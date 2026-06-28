#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./doctor.js";
import { runMigration } from "./migrate.js";
import { defaultCodexHome, normalizeDir, normalizeHistoryPath } from "./paths.js";
import { listBackups, restoreBackup } from "./restore.js";
import { projectCounts, providerCounts } from "./sqlite.js";
import { printError, printJson } from "./output.js";
import { command, hint, list, pathValue, section, status, table, tui, warnLine } from "./tui.js";
const program = new Command();
program
    .name("codex-migrate")
    .description("Migrate Codex conversation history between providers and project directories.")
    .version("0.1.0")
    .option("--codex-home <dir>", "Codex home directory", defaultCodexHome())
    .option("--json", "emit machine-readable JSON")
    .option("--no-archived", "skip archived_sessions");
program
    .command("doctor")
    .description("Inspect Codex history locations and migration support.")
    .action(async () => {
    await runCommand((global) => {
        const result = runDoctor(global.codexHome);
        if (global.json) {
            printJson(result);
        }
        else {
            printDoctor(result);
        }
    });
});
program
    .command("list")
    .description("List known providers or project directories from the Codex SQLite catalog.")
    .argument("<kind>", "providers or projects")
    .option("--limit <n>", "maximum rows for projects", parsePositiveInt, 50)
    .action(async (kind, options) => {
    await runCommand((global) => {
        if (kind !== "providers" && kind !== "projects") {
            throw new Error("list kind must be either 'providers' or 'projects'");
        }
        const rows = kind === "providers"
            ? providerCounts(global.codexHome)
            : projectCounts(global.codexHome).slice(0, options.limit);
        if (global.json) {
            printJson({ ok: true, kind, rows });
        }
        else {
            process.stdout.write(`${status("success", kind === "providers" ? "Providers" : "Projects")}\n`);
            if (kind === "providers") {
                process.stdout.write(table(rows.map((row) => "modelProvider" in row ? [row.modelProvider, String(row.count)] : ["", ""]), ["Provider", "Threads"]));
            }
            else {
                process.stdout.write(table(rows.map((row) => ("cwd" in row ? [String(row.count), pathValue(row.cwd)] : ["", ""])), ["Threads", "cwd"]));
            }
            process.stdout.write("\n");
            process.stdout.write(`${hint(`Dry-run a migration first; add ${command("--write")} only after reviewing samples.`)}\n`);
        }
    });
});
const backups = program.command("backups").description("Inspect codex-migrate backup snapshots.");
backups
    .command("list")
    .description("List migration backups under the Codex home.")
    .action(async () => {
    await runCommand((global) => {
        const result = listBackups(global.codexHome);
        printBackupList(result, global.json);
    });
});
program
    .command("restore")
    .description("Restore files from a codex-migrate backup. Defaults to dry-run.")
    .argument("<backup>", "backup name, backup path, or 'latest'")
    .option("--write", "apply restore; without this flag the command is a dry run")
    .action(async (backup, options) => {
    await runCommand((global) => {
        const result = restoreBackup(global.codexHome, backup, { write: Boolean(options.write) });
        printRestore(result, global.json);
    });
});
program
    .command("provider")
    .description("Migrate conversations to a target model provider.")
    .argument("<targetProvider>", "new model provider name")
    .option("--from <provider>", "only migrate conversations currently using this provider")
    .option("--write", "apply changes; without this flag the command is a dry run")
    .option("--no-jsonl", "skip JSONL rollout files")
    .option("--no-sqlite", "skip SQLite thread catalogs")
    .action(async (targetProvider, options) => {
    await runCommand((global) => {
        const result = runMigration({
            mode: "provider",
            targetProvider,
            fromProvider: options.from,
        }, executionOptions(global, options));
        printMigration(result, global.json);
    });
});
program
    .command("project")
    .description("Migrate one project's conversations to a new project directory.")
    .argument("<name>", "project basename or absolute source cwd")
    .argument("<targetDir>", "new project directory")
    .option("--from-dir <dir>", "exact source cwd; overrides basename matching")
    .option("--write", "apply changes; without this flag the command is a dry run")
    .option("--no-jsonl", "skip JSONL rollout files")
    .option("--no-sqlite", "skip SQLite thread catalogs")
    .action(async (name, targetDir, options) => {
    await runCommand((global) => {
        const result = runMigration({
            mode: "project",
            projectName: name,
            targetDir: normalizeHistoryPath(targetDir),
            fromDir: options.fromDir ? normalizeHistoryPath(options.fromDir) : undefined,
        }, executionOptions(global, options));
        printMigration(result, global.json);
    });
});
program
    .command("projects")
    .description("Migrate every project under one directory tree to another directory tree.")
    .argument("<originalDir>", "old parent directory")
    .argument("<targetDir>", "new parent directory")
    .option("--write", "apply changes; without this flag the command is a dry run")
    .option("--no-jsonl", "skip JSONL rollout files")
    .option("--no-sqlite", "skip SQLite thread catalogs")
    .action(async (originalDir, targetDir, options) => {
    await runCommand((global) => {
        const result = runMigration({
            mode: "projects",
            originalDir: normalizeHistoryPath(originalDir),
            targetDir: normalizeHistoryPath(targetDir),
        }, executionOptions(global, options));
        printMigration(result, global.json);
    });
});
program.parseAsync(process.argv).catch((error) => {
    printError(error, Boolean(program.opts().json));
    process.exitCode = 1;
});
async function runCommand(fn) {
    const opts = program.opts();
    const global = {
        codexHome: normalizeDir(opts.codexHome),
        json: Boolean(opts.json),
        archived: opts.archived !== false,
    };
    try {
        await fn(global);
    }
    catch (error) {
        printError(error, global.json);
        process.exitCode = 1;
    }
}
function executionOptions(global, commandOptions) {
    return {
        write: Boolean(commandOptions.write),
        codexHome: global.codexHome,
        includeArchived: global.archived,
        includeJsonl: commandOptions.jsonl !== false,
        includeSqlite: commandOptions.sqlite !== false,
        json: global.json,
    };
}
function printMigration(result, json) {
    if (json) {
        printJson(result);
        return;
    }
    const changedSomething = result.jsonl.changedFiles > 0 || result.sqlite.some((db) => db.changedRows > 0);
    process.stdout.write(`${result.dryRun ? status("dry", "Migration preview") : status("success", "Migration applied")} ${tui.bold(describeAction(result))}\n`);
    process.stdout.write(table([["Codex home", pathValue(result.codexHome)]]));
    process.stdout.write("\n");
    if (result.backupDir) {
        process.stdout.write(table([["Backup", pathValue(result.backupDir)]]));
        process.stdout.write("\n");
    }
    process.stdout.write(section("Summary"));
    process.stdout.write(table([
        [
            "JSONL",
            String(result.jsonl.scannedFiles),
            String(result.jsonl.matchedFiles),
            `${result.jsonl.changedFiles} files / ${result.jsonl.changedLines} lines`,
        ],
        ...result.sqlite.map((db) => [
            `SQLite ${db.table}`,
            db.skipped ? "-" : String(db.scannedRows),
            db.skipped ? "-" : String(db.matchedRows),
            db.skipped ? `skipped: ${db.reason}` : `${db.changedRows} rows`,
        ]),
    ], ["Surface", "Scanned", "Matched", "Would change"]));
    process.stdout.write("\n");
    if (result.jsonl.samples.length > 0) {
        process.stdout.write(section("Samples"));
        process.stdout.write(list(result.jsonl.samples.map((sample) => sample.toProvider
            ? `${tui.bold(sample.id ?? sample.file)} ${sample.fromProvider ?? "(unknown)"} ${tui.gray("->")} ${sample.toProvider}`
            : `${tui.bold(sample.id ?? sample.file)} ${pathValue(sample.fromCwd ?? "(unknown)")} ${tui.gray("->")} ${pathValue(sample.toCwd ?? "(unknown)")}`)));
        process.stdout.write("\n");
    }
    for (const warning of result.warnings) {
        process.stderr.write(`${warnLine(warning)}\n`);
    }
    process.stdout.write("\n");
    if (result.dryRun && changedSomething) {
        process.stdout.write(`${hint(`Review the samples, then rerun with ${command("--write")} to apply.`)}\n`);
    }
    else if (result.dryRun) {
        process.stdout.write(`${hint(`No matching changes found. Try ${command("codex-migrate list providers")} or ${command("codex-migrate list projects")}.`)}\n`);
    }
    else if (result.backupDir) {
        process.stdout.write(`${hint(`Preview rollback with ${command(`codex-migrate restore ${result.backupDir}`)}.`)}\n`);
    }
}
function printBackupList(result, json) {
    if (json) {
        printJson(result);
        return;
    }
    if (result.backups.length === 0) {
        process.stdout.write(`${status("info", "No backups found")}\n`);
        process.stdout.write(`${hint(`A migration with ${command("--write")} creates a backup under ${pathValue(result.codexHome)}.`)}\n`);
        return;
    }
    process.stdout.write(`${status("success", "Backups")}\n`);
    process.stdout.write(table(result.backups.map((backup) => [
        backup.updatedAt,
        String(backup.files),
        tui.bold(backup.name),
        pathValue(backup.path),
    ]), ["Updated", "Files", "Name", "Path"]));
    process.stdout.write("\n");
    process.stdout.write(`${hint(`Preview restore with ${command("codex-migrate restore latest")}.`)}\n`);
}
function printRestore(result, json) {
    if (json) {
        printJson(result);
        return;
    }
    process.stdout.write(`${result.dryRun ? status("dry", "Restore preview") : status("success", "Restore applied")} ${pathValue(result.backupDir)}\n`);
    process.stdout.write(table([
        ["Codex home", pathValue(result.codexHome)],
        ["Files", String(result.restoredFiles)],
        ["SQLite files", String(result.sqliteFiles)],
        ["SQLite sidecars removed", String(result.removedWalFiles)],
    ]));
    process.stdout.write("\n");
    if (result.samples.length > 0) {
        process.stdout.write(section("Samples"));
        process.stdout.write(list(result.samples.map((sample) => `${pathValue(sample.from)} ${tui.gray("->")} ${pathValue(sample.to)}`)));
        process.stdout.write("\n");
    }
    for (const warning of result.warnings) {
        process.stderr.write(`${warnLine(warning)}\n`);
    }
    process.stdout.write("\n");
    if (result.dryRun && result.ok) {
        process.stdout.write(`${hint(`Review the file list, then rerun with ${command("--write")} to restore.`)}\n`);
    }
    else if (!result.ok) {
        process.stdout.write(`${hint(`List available backups with ${command("codex-migrate backups list")}.`)}\n`);
    }
}
function printDoctor(result) {
    process.stdout.write(`${status(result.ok ? "success" : "warning", "Codex history doctor")}\n`);
    process.stdout.write(table([
        ["Codex home", pathValue(result.codexHome)],
        ["Platform", `${result.platform.node} ${tui.gray(`separator ${JSON.stringify(result.platform.pathSeparator)}`)}`],
        ["sqlite3", result.sqlite3Available ? tui.green("available") : tui.yellow("missing")],
        ["Sessions", `${result.sessionsDir.files} files ${tui.gray(result.sessionsDir.path)}`],
        ["Archived", `${result.archivedSessionsDir.files} files ${tui.gray(result.archivedSessionsDir.path)}`],
    ]));
    process.stdout.write("\n");
    process.stdout.write(section("SQLite"));
    process.stdout.write(table(result.sqlite.map((db) => [
        db.table,
        db.skipped ? tui.yellow("skipped") : tui.green("ready"),
        db.skipped ? (db.reason ?? "") : `${db.scannedRows} rows`,
        pathValue(db.database),
    ]), ["Table", "Status", "Rows", "Database"]));
    process.stdout.write("\n");
    if (result.providers.length > 0) {
        process.stdout.write(section("Providers"));
        process.stdout.write(table(result.providers.map((provider) => [provider.modelProvider, String(provider.count)]), ["Provider", "Threads"]));
        process.stdout.write("\n");
    }
    if (result.projects.length > 0) {
        process.stdout.write(section("Top Projects"));
        process.stdout.write(table(result.projects.map((project) => [String(project.count), pathValue(project.cwd)]), ["Threads", "cwd"]));
        process.stdout.write("\n");
    }
    for (const warning of result.warnings) {
        process.stderr.write(`${warnLine(warning)}\n`);
    }
    process.stdout.write("\n");
    process.stdout.write(`${hint(`Run ${command("codex-migrate list providers")} or ${command("codex-migrate list projects --limit 50")} before migrating.`)}\n`);
}
function describeAction(result) {
    const spec = result.action;
    if (spec.mode === "provider") {
        return spec.fromProvider
            ? `provider ${spec.fromProvider} -> ${spec.targetProvider}`
            : `provider * -> ${spec.targetProvider}`;
    }
    if (spec.mode === "project") {
        return `project ${spec.fromDir ?? spec.projectName} -> ${spec.targetDir}`;
    }
    return `projects ${spec.originalDir} -> ${spec.targetDir}`;
}
function parsePositiveInt(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Expected a positive integer, got ${value}`);
    }
    return parsed;
}
//# sourceMappingURL=cli.js.map