import fs from "node:fs";
import path from "node:path";
import { discoverSessionFiles, migrateJsonlFiles } from "./jsonl.js";
import { ensureDir, normalizeDir } from "./paths.js";
import { migrateSqlite } from "./sqlite.js";
export function runMigration(spec, options) {
    const codexHome = normalizeDir(options.codexHome);
    const warnings = [];
    if (!fs.existsSync(codexHome)) {
        warnings.push(`Codex home does not exist: ${codexHome}`);
        return {
            ok: false,
            dryRun: !options.write,
            action: spec,
            codexHome,
            jsonl: emptyJsonlResult(),
            sqlite: [],
            warnings,
        };
    }
    const backupDir = options.write ? createBackupDir(codexHome) : undefined;
    const sessions = options.includeJsonl
        ? discoverSessionFiles(codexHome, options.includeArchived)
        : [];
    const jsonl = options.includeJsonl
        ? migrateJsonlFiles(sessions, spec, {
            write: options.write,
            codexHome,
            backupDir,
        })
        : {
            scannedFiles: 0,
            matchedFiles: 0,
            changedFiles: 0,
            changedLines: 0,
            samples: [],
        };
    const sqlite = options.includeSqlite
        ? migrateSqlite(codexHome, spec, { write: options.write, backupDir })
        : [];
    return {
        ok: warnings.length === 0,
        dryRun: !options.write,
        action: spec,
        codexHome,
        backupDir,
        jsonl,
        sqlite,
        warnings,
    };
}
function emptyJsonlResult() {
    return {
        scannedFiles: 0,
        matchedFiles: 0,
        changedFiles: 0,
        changedLines: 0,
        samples: [],
    };
}
function createBackupDir(codexHome) {
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const backupDir = path.join(codexHome, "backups", `codex-migrate-${timestamp}`);
    ensureDir(backupDir);
    return backupDir;
}
//# sourceMappingURL=migrate.js.map