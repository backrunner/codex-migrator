import fs from "node:fs";
import path from "node:path";
import { countSessionFiles } from "./jsonl.js";
import { normalizeDir } from "./paths.js";
import { inspectSqlite, projectCounts, providerCounts, sqlite3Available } from "./sqlite.js";
import { inspectJsonState } from "./state.js";
export function runDoctor(codexHomeInput) {
    const codexHome = normalizeDir(codexHomeInput);
    const sessionsPath = path.join(codexHome, "sessions");
    const archivedPath = path.join(codexHome, "archived_sessions");
    const warnings = [];
    if (!fs.existsSync(codexHome)) {
        warnings.push(`Codex home does not exist: ${codexHome}`);
    }
    const sqliteAvailable = sqlite3Available();
    if (!sqliteAvailable) {
        warnings.push("sqlite3 is not available; SQLite thread catalog migration will be skipped");
    }
    const sqlite = inspectSqlite(codexHome);
    const state = inspectJsonState(codexHome);
    const historyIndex = path.join(codexHome, "history.jsonl");
    const sessionIndex = path.join(codexHome, "session_index.jsonl");
    for (const db of sqlite) {
        if (db.missingRolloutPaths > 0) {
            warnings.push(`${db.table} has ${db.missingRolloutPaths} thread row(s) whose rollout_path file is missing`);
        }
    }
    const stateThreadRows = sqlite
        .filter((db) => db.table === "threads" && !db.skipped)
        .reduce((sum, db) => sum + db.scannedRows, 0);
    const desktopCatalogRows = sqlite
        .filter((db) => db.table === "local_thread_catalog" && !db.skipped)
        .reduce((sum, db) => sum + db.scannedRows, 0);
    if (stateThreadRows > 0 && desktopCatalogRows === 0) {
        warnings.push("Desktop local_thread_catalog is empty while state_5.sqlite has thread rows; run a confirmed project migration to rebuild Desktop history.");
    }
    return {
        ok: warnings.length === 0,
        codexHome,
        platform: {
            node: process.platform,
            pathSeparator: path.sep,
        },
        sqlite3Available: sqliteAvailable,
        state,
        indexFiles: {
            history: {
                path: historyIndex,
                exists: fs.existsSync(historyIndex),
                entries: countJsonlLines(historyIndex),
            },
            sessionIndex: {
                path: sessionIndex,
                exists: fs.existsSync(sessionIndex),
                entries: countJsonlLines(sessionIndex),
            },
        },
        sessionsDir: {
            path: sessionsPath,
            exists: fs.existsSync(sessionsPath),
            files: countSessionFiles(sessionsPath),
        },
        archivedSessionsDir: {
            path: archivedPath,
            exists: fs.existsSync(archivedPath),
            files: countSessionFiles(archivedPath),
        },
        sqlite,
        providers: providerCounts(codexHome),
        projects: projectCounts(codexHome).slice(0, 20),
        warnings,
    };
}
function countJsonlLines(file) {
    if (!fs.existsSync(file)) {
        return 0;
    }
    const content = fs.readFileSync(file, "utf8").trim();
    if (!content) {
        return 0;
    }
    return content.split("\n").length;
}
//# sourceMappingURL=doctor.js.map