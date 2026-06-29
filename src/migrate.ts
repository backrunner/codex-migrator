import fs from "node:fs";
import path from "node:path";
import { migrateConfigToml } from "./config.js";
import { discoverSessionFiles, migrateJsonlFiles } from "./jsonl.js";
import { ensureDir, normalizeDir } from "./paths.js";
import { migrateSqlite, sqliteWritePreflight } from "./sqlite.js";
import { migrateJsonState } from "./state.js";
import type { ExecutionOptions, MigrationResult, MigrationSpec, ProjectMigrationSummary } from "./types.js";

export function runMigration(
  spec: MigrationSpec,
  options: ExecutionOptions,
): MigrationResult {
  const codexHome = normalizeDir(options.codexHome);
  const warnings: string[] = [];

  if (!fs.existsSync(codexHome)) {
    warnings.push(`Codex home does not exist: ${codexHome}`);
    return {
      ok: false,
      dryRun: !options.write,
      action: spec,
      codexHome,
      projects: [],
      jsonl: emptyJsonlResult(),
      config: emptyConfigResult(),
      state: emptyStateResult(),
      sqlite: [],
      warnings,
    };
  }

  if (options.write && options.includeSqlite) {
    const sqliteErrors = sqliteWritePreflight(codexHome);
    if (sqliteErrors.length > 0) {
      return {
        ok: false,
        dryRun: false,
        action: spec,
        codexHome,
        projects: [],
        jsonl: emptyJsonlResult(),
        config: emptyConfigResult(),
        state: emptyStateResult(),
        sqlite: [],
        warnings: sqliteErrors.map((error) => `SQLite is not ready for migration: ${error}`),
      };
    }
  }

  const backupDir = options.write ? createBackupDir(codexHome) : undefined;
  const sessions = options.includeJsonl
    ? discoverSessionFiles(codexHome, options.includeArchived, options.onProgress)
    : [];

  const jsonl = options.includeJsonl
    ? migrateJsonlFiles(sessions, spec, {
        write: options.write,
        codexHome,
        backupDir,
        onProgress: options.onProgress,
      })
    : {
        scannedFiles: 0,
        matchedFiles: 0,
        changedFiles: 0,
        changedLines: 0,
        threadProjectHints: [],
        projectChanges: [],
        samples: [],
      };

  options.onProgress?.({
    surface: "config",
    current: 1,
    total: 1,
    label: "config.toml",
  });
  const config = migrateConfigToml(codexHome, spec, { write: options.write, backupDir });
  const state = migrateJsonState(codexHome, spec, {
    write: options.write,
    backupDir,
    onProgress: options.onProgress,
  });

  const sqlite = options.includeSqlite
      ? migrateSqlite(codexHome, spec, {
        write: options.write,
        backupDir,
        threadProjectHints: jsonl.threadProjectHints,
        onProgress: options.onProgress,
      })
    : [];

  return {
    ok: warnings.length === 0,
    dryRun: !options.write,
    action: spec,
    codexHome,
    backupDir,
    projects: summarizeProjectMigrations(spec, jsonl, config, state, sqlite),
    jsonl,
    config,
    state,
    sqlite,
    warnings,
  };
}

function summarizeProjectMigrations(
  spec: MigrationSpec,
  jsonl: MigrationResult["jsonl"],
  config: MigrationResult["config"],
  state: MigrationResult["state"],
  sqlite: MigrationResult["sqlite"],
): ProjectMigrationSummary[] {
  if (spec.mode === "provider") {
    return [];
  }

  const projects = new Map<string, ProjectMigrationSummary>();
  const add = (
    fromCwd: string | undefined,
    toCwd: string | undefined,
    field: keyof Pick<
      ProjectMigrationSummary,
      "jsonlFiles" | "configSections" | "stateEntries" | "sqliteRows"
    >,
    count: number,
  ) => {
    if (!fromCwd || !toCwd) {
      return;
    }

    const key = `${fromCwd}\0${toCwd}`;
    const current =
      projects.get(key) ??
      {
        fromCwd,
        toCwd,
        targetExists: fs.existsSync(toCwd),
        jsonlFiles: 0,
        configSections: 0,
        stateEntries: 0,
        sqliteRows: 0,
      };
    current[field] += count;
    projects.set(key, current);
  };

  for (const change of jsonl.projectChanges) {
    add(change.fromCwd, change.toCwd, "jsonlFiles", change.files);
  }

  for (const change of config.projectChanges) {
    add(change.fromCwd, change.toCwd, "configSections", change.sections);
  }

  for (const change of state.projectChanges) {
    add(change.fromCwd, change.toCwd, "stateEntries", change.entries);
  }

  for (const db of sqlite) {
    for (const change of db.projectChanges) {
      add(change.fromCwd, change.toCwd, "sqliteRows", change.rows);
    }
  }

  return [...projects.values()].sort((a, b) => a.fromCwd.localeCompare(b.fromCwd));
}

function emptyJsonlResult(): MigrationResult["jsonl"] {
  return {
    scannedFiles: 0,
    matchedFiles: 0,
    changedFiles: 0,
    changedLines: 0,
    threadProjectHints: [],
    projectChanges: [],
    samples: [],
  };
}

function emptyConfigResult(): MigrationResult["config"] {
  return {
    scannedFiles: 0,
    matchedSections: 0,
    changedSections: 0,
    projectChanges: [],
    samples: [],
    skipped: true,
    reason: "not scanned",
  };
}

function emptyStateResult(): MigrationResult["state"] {
  return {
    scannedFiles: 0,
    matchedFiles: 0,
    changedFiles: 0,
    changedKeys: 0,
    changedValues: 0,
    projectChanges: [],
    samples: [],
  };
}

function createBackupDir(codexHome: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupDir = path.join(codexHome, "backups", `codex-migrate-${timestamp}`);
  ensureDir(backupDir);
  return backupDir;
}
