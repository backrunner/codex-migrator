import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDir, normalizeHistoryPath, relativeFromCodexHome, remapPathPrefix, } from "./paths.js";
import { sessionMatches } from "./jsonl.js";
export function sqlite3Available() {
    try {
        execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
export function discoverSqliteCandidates(codexHome) {
    return [
        { database: path.join(codexHome, "state_5.sqlite"), table: "threads" },
        { database: path.join(codexHome, "sqlite", "state_5.sqlite"), table: "threads" },
        {
            database: path.join(codexHome, "sqlite", "codex-dev.db"),
            table: "local_thread_catalog",
        },
    ];
}
export function inspectSqlite(codexHome) {
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
        try {
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
        }
        catch (error) {
            return skipped(candidate, sqliteErrorMessage(error));
        }
    });
}
export function sqliteWritePreflight(codexHome) {
    if (!sqlite3Available()) {
        return [];
    }
    const errors = [];
    for (const candidate of discoverSqliteCandidates(codexHome)) {
        try {
            if (!fs.existsSync(candidate.database)) {
                continue;
            }
            if (!tableExists(candidate.database, candidate.table)) {
                continue;
            }
            countRows(candidate.database, candidate.table);
        }
        catch (error) {
            errors.push(`${candidate.database}: ${sqliteErrorMessage(error)}`);
        }
    }
    return errors;
}
export function migrateSqlite(codexHome, spec, options) {
    if (!sqlite3Available()) {
        return discoverSqliteCandidates(codexHome).map((candidate) => skipped(candidate, "sqlite3 not found on PATH"));
    }
    return discoverSqliteCandidates(codexHome).map((candidate) => {
        try {
            if (!fs.existsSync(candidate.database)) {
                return skipped(candidate, "database not found");
            }
            if (!tableExists(candidate.database, candidate.table)) {
                return skipped(candidate, "table not found");
            }
            const rows = readRows(candidate.database, candidate.table);
            const updates = rows
                .map((row) => updateForRow(row, spec))
                .filter((update) => update !== undefined);
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
        }
        catch (error) {
            if (options.write) {
                throw error;
            }
            return skipped(candidate, sqliteErrorMessage(error));
        }
    });
}
export function providerCounts(codexHome) {
    const rows = aggregateRows(codexHome);
    const counts = new Map();
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
export function projectCounts(codexHome) {
    const rows = aggregateRows(codexHome);
    const counts = new Map();
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
function aggregateRows(codexHome) {
    if (!sqlite3Available()) {
        return [];
    }
    const rows = [];
    const seen = new Set();
    for (const candidate of discoverSqliteCandidates(codexHome)) {
        try {
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
        catch {
            continue;
        }
    }
    return rows;
}
function updateForRow(row, spec) {
    if (spec.mode === "provider") {
        const shouldUpdate = row.model_provider !== spec.targetProvider &&
            (!spec.fromProvider || row.model_provider === spec.fromProvider);
        return shouldUpdate ? { ...row, model_provider: spec.targetProvider } : undefined;
    }
    const session = {
        file: "",
        id: row.id,
        cwd: row.cwd,
        modelProvider: row.model_provider,
        archived: false,
    };
    if (!sessionMatches(session, spec)) {
        return undefined;
    }
    const nextCwd = spec.mode === "projects"
        ? remapPathPrefix(row.cwd, spec.originalDir, spec.targetDir)
        : normalizeHistoryPath(spec.targetDir, row.cwd);
    if (!nextCwd || nextCwd === row.cwd) {
        return undefined;
    }
    return { ...row, cwd: nextCwd };
}
function tableExists(database, table) {
    const sql = `select count(*) as count from sqlite_master where type = 'table' and name = ${sqlString(table)};`;
    const rows = queryJson(database, sql);
    return rows[0]?.count === 1;
}
function countRows(database, table) {
    const rows = queryJson(database, `select count(*) as count from ${quoteIdentifier(table)};`);
    return rows[0]?.count ?? 0;
}
function readRows(database, table) {
    const idColumn = table === "threads" ? "id" : "thread_id";
    return queryJson(database, `select ${quoteIdentifier(idColumn)} as id, cwd, model_provider from ${quoteIdentifier(table)} order by ${quoteIdentifier(idColumn)};`);
}
function applyUpdates(database, table, spec, updates) {
    const idColumn = table === "threads" ? "id" : "thread_id";
    const statements = updates.map((row) => {
        if (spec.mode === "provider") {
            return `update ${quoteIdentifier(table)} set model_provider = ${sqlString(row.model_provider)} where ${quoteIdentifier(idColumn)} = ${sqlString(row.id)};`;
        }
        return `update ${quoteIdentifier(table)} set cwd = ${sqlString(row.cwd)} where ${quoteIdentifier(idColumn)} = ${sqlString(row.id)};`;
    });
    execSql(database, ["begin immediate;", ...statements, "commit;"].join("\n"));
}
function queryJson(database, sql) {
    const stdout = execFileSync("sqlite3", ["-json", database, sql], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout.trim() ? JSON.parse(stdout) : [];
}
function execSql(database, sql) {
    execFileSync("sqlite3", [database, sql], {
        stdio: ["ignore", "pipe", "pipe"],
    });
}
function backupSqlite(codexHome, backupDir, database) {
    const relative = relativeFromCodexHome(codexHome, database);
    const backupPath = path.join(backupDir, relative);
    ensureDir(path.dirname(backupPath));
    if (fs.existsSync(backupPath)) {
        fs.rmSync(backupPath);
    }
    execSql(database, `vacuum into ${sqlString(backupPath)};`);
}
function skipped(candidate, reason) {
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
function sqliteErrorMessage(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    return error.message.replace(/\s+/g, " ").trim();
}
function sqlString(value) {
    return `'${value.replaceAll("'", "''")}'`;
}
function quoteIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
//# sourceMappingURL=sqlite.js.map