import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensureDir,
  normalizeHistoryPath,
  relativeFromCodexHome,
  remapPathPrefix,
} from "./paths.js";
import type { MigrationSpec, SessionSummary, SqliteMigrationResult } from "./types.js";
import { sessionMatches } from "./jsonl.js";

interface SqliteCandidate {
  database: string;
  table: "threads" | "local_thread_catalog";
}

interface ThreadRow {
  id: string;
  cwd: string;
  model_provider: string;
}

export function sqlite3Available(): boolean {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function discoverSqliteCandidates(codexHome: string): SqliteCandidate[] {
  return [
    { database: path.join(codexHome, "state_5.sqlite"), table: "threads" },
    { database: path.join(codexHome, "sqlite", "state_5.sqlite"), table: "threads" },
    {
      database: path.join(codexHome, "sqlite", "codex-dev.db"),
      table: "local_thread_catalog",
    },
  ];
}

export function inspectSqlite(codexHome: string): SqliteMigrationResult[] {
  if (!sqlite3Available()) {
    return discoverSqliteCandidates(codexHome).map((candidate) => ({
      database: candidate.database,
      table: candidate.table,
      scannedRows: 0,
      matchedRows: 0,
      changedRows: 0,
      skipped: true,
      reason: "sqlite3 not found on PATH",
    }));
  }

  return discoverSqliteCandidates(codexHome).map((candidate) => {
    if (!fs.existsSync(candidate.database)) {
      return skipped(candidate, "database not found");
    }

    if (!tableExists(candidate.database, candidate.table)) {
      return skipped(candidate, "table not found");
    }

    return {
      database: candidate.database,
      table: candidate.table,
      scannedRows: countRows(candidate.database, candidate.table),
      matchedRows: 0,
      changedRows: 0,
      skipped: false,
    };
  });
}

export function migrateSqlite(
  codexHome: string,
  spec: MigrationSpec,
  options: { write: boolean; backupDir?: string },
): SqliteMigrationResult[] {
  if (!sqlite3Available()) {
    return discoverSqliteCandidates(codexHome).map((candidate) =>
      skipped(candidate, "sqlite3 not found on PATH"),
    );
  }

  return discoverSqliteCandidates(codexHome).map((candidate) => {
    if (!fs.existsSync(candidate.database)) {
      return skipped(candidate, "database not found");
    }

    if (!tableExists(candidate.database, candidate.table)) {
      return skipped(candidate, "table not found");
    }

    const rows = readRows(candidate.database, candidate.table);
    const updates = rows
      .map((row) => updateForRow(row, spec))
      .filter((update): update is ThreadRow => update !== undefined);

    if (options.write && updates.length > 0) {
      if (!options.backupDir) {
        throw new Error("backupDir is required when writing SQLite changes");
      }

      backupSqlite(codexHome, options.backupDir, candidate.database);
      applyUpdates(candidate.database, candidate.table, spec, updates);
    }

    return {
      database: candidate.database,
      table: candidate.table,
      scannedRows: rows.length,
      matchedRows: updates.length,
      changedRows: updates.length,
      skipped: false,
    };
  });
}

export function providerCounts(codexHome: string): Array<{ modelProvider: string; count: number }> {
  const rows = aggregateRows(codexHome);
  const counts = new Map<string, number>();

  for (const row of rows) {
    if (!row.model_provider) {
      continue;
    }

    counts.set(row.model_provider, (counts.get(row.model_provider) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([modelProvider, count]) => ({ modelProvider, count }))
    .sort((a, b) => b.count - a.count || a.modelProvider.localeCompare(b.modelProvider));
}

export function projectCounts(codexHome: string): Array<{ cwd: string; count: number }> {
  const rows = aggregateRows(codexHome);
  const counts = new Map<string, number>();

  for (const row of rows) {
    if (!row.cwd) {
      continue;
    }

    counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((a, b) => b.count - a.count || a.cwd.localeCompare(b.cwd));
}

function aggregateRows(codexHome: string): ThreadRow[] {
  if (!sqlite3Available()) {
    return [];
  }

  const rows: ThreadRow[] = [];
  const seen = new Set<string>();

  for (const candidate of discoverSqliteCandidates(codexHome)) {
    if (!fs.existsSync(candidate.database) || !tableExists(candidate.database, candidate.table)) {
      continue;
    }

    for (const row of readRows(candidate.database, candidate.table)) {
      const key = `${row.id}:${row.cwd}:${row.model_provider}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
  }

  return rows;
}

function updateForRow(row: ThreadRow, spec: MigrationSpec): ThreadRow | undefined {
  if (spec.mode === "provider") {
    const shouldUpdate =
      row.model_provider !== spec.targetProvider &&
      (!spec.fromProvider || row.model_provider === spec.fromProvider);

    return shouldUpdate ? { ...row, model_provider: spec.targetProvider } : undefined;
  }

  const session: SessionSummary = {
    file: "",
    id: row.id,
    cwd: row.cwd,
    modelProvider: row.model_provider,
    archived: false,
  };

  if (!sessionMatches(session, spec)) {
    return undefined;
  }

  const nextCwd =
    spec.mode === "projects"
      ? remapPathPrefix(row.cwd, spec.originalDir, spec.targetDir)
      : normalizeHistoryPath(spec.targetDir, row.cwd);

  if (!nextCwd || nextCwd === row.cwd) {
    return undefined;
  }

  return { ...row, cwd: nextCwd };
}

function tableExists(database: string, table: string): boolean {
  const sql = `select count(*) as count from sqlite_master where type = 'table' and name = ${sqlString(table)};`;
  const rows = queryJson<{ count: number }>(database, sql);
  return rows[0]?.count === 1;
}

function countRows(database: string, table: string): number {
  const rows = queryJson<{ count: number }>(
    database,
    `select count(*) as count from ${quoteIdentifier(table)};`,
  );
  return rows[0]?.count ?? 0;
}

function readRows(database: string, table: string): ThreadRow[] {
  const idColumn = table === "threads" ? "id" : "thread_id";
  return queryJson<ThreadRow>(
    database,
    `select ${quoteIdentifier(idColumn)} as id, cwd, model_provider from ${quoteIdentifier(table)} order by ${quoteIdentifier(idColumn)};`,
  );
}

function applyUpdates(
  database: string,
  table: "threads" | "local_thread_catalog",
  spec: MigrationSpec,
  updates: ThreadRow[],
): void {
  const idColumn = table === "threads" ? "id" : "thread_id";
  const statements = updates.map((row) => {
    if (spec.mode === "provider") {
      return `update ${quoteIdentifier(table)} set model_provider = ${sqlString(row.model_provider)} where ${quoteIdentifier(idColumn)} = ${sqlString(row.id)};`;
    }

    return `update ${quoteIdentifier(table)} set cwd = ${sqlString(row.cwd)} where ${quoteIdentifier(idColumn)} = ${sqlString(row.id)};`;
  });

  execSql(database, ["begin immediate;", ...statements, "commit;"].join("\n"));
}

function queryJson<T>(database: string, sql: string): T[] {
  const stdout = execFileSync("sqlite3", ["-json", database, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

function execSql(database: string, sql: string): void {
  execFileSync("sqlite3", [database, sql], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function backupSqlite(codexHome: string, backupDir: string, database: string): void {
  const relative = relativeFromCodexHome(codexHome, database);
  const backupPath = path.join(backupDir, relative);
  ensureDir(path.dirname(backupPath));

  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath);
  }

  execSql(database, `vacuum into ${sqlString(backupPath)};`);
}

function skipped(candidate: SqliteCandidate, reason: string): SqliteMigrationResult {
  return {
    database: candidate.database,
    table: candidate.table,
    scannedRows: 0,
    matchedRows: 0,
    changedRows: 0,
    skipped: true,
    reason,
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
