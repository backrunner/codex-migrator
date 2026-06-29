#!/usr/bin/env node
import { clearLine, cursorTo } from "node:readline";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { runDoctor } from "./doctor.js";
import { runMigration } from "./migrate.js";
import {
  defaultCodexHome,
  normalizeDir,
  normalizeExistingHistoryPath,
  normalizeHistoryPath,
  relativeFromCodexHome,
} from "./paths.js";
import { listBackups, restoreBackup } from "./restore.js";
import { projectCounts, providerCounts } from "./sqlite.js";
import { printError, printJson } from "./output.js";
import type {
  BackupListResult,
  ExecutionOptions,
  GlobalOptions,
  MigrationResult,
  MigrationSpec,
  RestoreResult,
} from "./types.js";
import { command, hint, pathValue, section, status, table, tui, warnLine } from "./tui.js";

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
      } else {
        printDoctor(result);
      }
    });
  });

program
  .command("list")
  .description("List known providers or project directories from the Codex SQLite catalog.")
  .argument("<kind>", "providers or projects")
  .option("--limit <n>", "maximum rows for projects", parsePositiveInt, 50)
  .action(async (kind: string, options: { limit: number }) => {
    await runCommand((global) => {
      if (kind !== "providers" && kind !== "projects") {
        throw new Error("list kind must be either 'providers' or 'projects'");
      }

      const rows =
        kind === "providers"
          ? providerCounts(global.codexHome)
          : projectCounts(global.codexHome).slice(0, options.limit);

      if (global.json) {
        printJson({ ok: true, kind, rows });
      } else {
        process.stdout.write(`${status("success", kind === "providers" ? "Providers" : "Projects")}\n`);
        if (kind === "providers") {
          process.stdout.write(
            table(
              rows.map((row) =>
                "modelProvider" in row ? [row.modelProvider, String(row.count)] : ["", ""],
              ),
              ["Provider", "Threads"],
            ),
          );
        } else {
          process.stdout.write(
            table(
              rows.map((row) => ("cwd" in row ? [String(row.count), pathValue(row.cwd)] : ["", ""])),
              ["Threads", "cwd"],
            ),
          );
        }
        process.stdout.write("\n");
        process.stdout.write(`${hint("Run a migration command to preview changes, then answer y to apply.")}\n`);
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
  .action(async (backup: string) => {
    await runCommand(async (global) => {
      await runRestoreCommand(global, backup);
    });
  });

program
  .command("provider")
  .description("Migrate conversations to a target model provider.")
  .argument("<targetProvider>", "new model provider name")
  .option("--from <provider>", "only migrate conversations currently using this provider")
  .option("--no-jsonl", "skip JSONL rollout files")
  .option("--no-sqlite", "skip SQLite thread catalogs")
  .action(
    async (
      targetProvider: string,
      options: {
        from?: string;
        jsonl: boolean;
        sqlite: boolean;
      },
    ) => {
      await runCommand(async (global) => {
        await runMigrationCommand(
          global,
          {
            mode: "provider",
            targetProvider,
            fromProvider: options.from,
          },
          options,
        );
      });
    },
  );

program
  .command("project")
  .description("Migrate one project's conversations to a new project directory.")
  .argument("<name>", "project basename or absolute source cwd")
  .argument("<targetDir>", "new project directory")
  .option("--from-dir <dir>", "exact source cwd; overrides basename matching")
  .option("--no-jsonl", "skip JSONL rollout files")
  .option("--no-sqlite", "skip SQLite thread catalogs")
  .action(
    async (
      name: string,
      targetDir: string,
      options: {
        fromDir?: string;
        jsonl: boolean;
        sqlite: boolean;
      },
    ) => {
      await runCommand(async (global) => {
        await runMigrationCommand(
          global,
          {
            mode: "project",
            projectName: name,
            targetDir: normalizeExistingHistoryPath(targetDir),
            fromDir: options.fromDir ? normalizeHistoryPath(options.fromDir) : undefined,
          },
          options,
        );
      });
    },
  );

program
  .command("projects")
  .description("Migrate every project under one directory tree to another directory tree.")
  .argument("<originalDir>", "old parent directory")
  .argument("<targetDir>", "new parent directory")
  .option("--no-jsonl", "skip JSONL rollout files")
  .option("--no-sqlite", "skip SQLite thread catalogs")
  .action(
    async (
      originalDir: string,
      targetDir: string,
      options: {
        jsonl: boolean;
        sqlite: boolean;
      },
    ) => {
      await runCommand(async (global) => {
        await runMigrationCommand(
          global,
          {
            mode: "projects",
            originalDir: normalizeHistoryPath(originalDir),
            targetDir: normalizeExistingHistoryPath(targetDir),
          },
          options,
        );
      });
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  printError(error, Boolean(program.opts<GlobalOptions>().json));
  process.exitCode = 1;
});

async function runCommand(fn: (global: GlobalOptions) => void | Promise<void>): Promise<void> {
  const opts = program.opts<{ codexHome: string; json?: boolean; archived?: boolean }>();
  const global: GlobalOptions = {
    codexHome: normalizeDir(opts.codexHome),
    json: Boolean(opts.json),
    archived: opts.archived !== false,
  };

  try {
    await fn(global);
  } catch (error) {
    printError(error, global.json);
    process.exitCode = 1;
  }
}

function executionOptions(
  global: GlobalOptions,
  commandOptions: {
    jsonl?: boolean;
    sqlite?: boolean;
  },
  write = false,
  onProgress?: ExecutionOptions["onProgress"],
): ExecutionOptions {
  return {
    write,
    codexHome: global.codexHome,
    includeArchived: global.archived,
    includeJsonl: commandOptions.jsonl !== false,
    includeSqlite: commandOptions.sqlite !== false,
    json: global.json,
    onProgress,
  };
}

async function runMigrationCommand(
  global: GlobalOptions,
  spec: MigrationSpec,
  commandOptions: {
    jsonl?: boolean;
    sqlite?: boolean;
  },
): Promise<void> {
  const previewProgress = createProgressReporter(process.stderr, {
    title: "Preparing migration preview",
    done: "Preview ready",
  });
  const preview = runMigration(spec, executionOptions(global, commandOptions, false, previewProgress));
  previewProgress.finish();
  if (global.json) {
    await runJsonMigrationCommand(global, spec, commandOptions, preview);
    return;
  }

  printMigration(preview, global.json);

  if (!canApplyMigration(preview)) {
    return;
  }

  const confirmed = await confirmApply("Apply these migration changes? [y/N]");
  if (!confirmed) {
    process.stdout.write(`\n${status("info", "No changes applied")}\n`);
    return;
  }

  const applyProgress = createProgressReporter(process.stderr, {
    title: "Applying migration",
    done: "Apply phase complete",
  });
  const applied = runMigration(spec, executionOptions(global, commandOptions, true, applyProgress));
  applyProgress.finish();
  process.stdout.write("\n");
  printMigration(applied, false);
}

async function runJsonMigrationCommand(
  global: GlobalOptions,
  spec: MigrationSpec,
  commandOptions: {
    jsonl?: boolean;
    sqlite?: boolean;
  },
  preview: MigrationResult,
): Promise<void> {
  if (!canApplyMigration(preview)) {
    printJson({ ...preview, confirmed: false });
    return;
  }

  writeJsonConfirmationSummary("migration", preview);
  const confirmed = await confirmApply("Apply these migration changes? [y/N]", process.stderr);
  if (!confirmed) {
    printJson({ ...preview, confirmed: false });
    return;
  }

  const applyProgress = createProgressReporter(process.stderr, {
    title: "Applying migration",
    done: "Apply phase complete",
  });
  const applied = runMigration(spec, executionOptions(global, commandOptions, true, applyProgress));
  applyProgress.finish();
  printJson({ ...applied, confirmed: true, preview });
}

async function runRestoreCommand(global: GlobalOptions, backup: string): Promise<void> {
  const previewProgress = createProgressReporter(process.stderr, {
    title: "Inspecting restore backup",
    done: "Restore preview ready",
  });
  const preview = restoreBackup(global.codexHome, backup, { write: false, onProgress: previewProgress });
  previewProgress.finish();
  if (global.json) {
    await runJsonRestoreCommand(global, backup, preview);
    return;
  }

  printRestore(preview, global.json);

  if (!preview.ok || preview.restoredFiles === 0) {
    return;
  }

  const confirmed = await confirmApply("Apply this restore? [y/N]");
  if (!confirmed) {
    process.stdout.write(`\n${status("info", "No files restored")}\n`);
    return;
  }

  const applyProgress = createProgressReporter(process.stderr, {
    title: "Restoring files",
    done: "Restore completed",
  });
  const applied = restoreBackup(global.codexHome, backup, { write: true, onProgress: applyProgress });
  applyProgress.finish();
  process.stdout.write("\n");
  printRestore(applied, false);
}

async function runJsonRestoreCommand(
  global: GlobalOptions,
  backup: string,
  preview: RestoreResult,
): Promise<void> {
  if (!preview.ok || preview.restoredFiles === 0) {
    printJson({ ...preview, confirmed: false });
    return;
  }

  writeJsonConfirmationSummary("restore", preview);
  const confirmed = await confirmApply("Apply this restore? [y/N]", process.stderr);
  if (!confirmed) {
    printJson({ ...preview, confirmed: false });
    return;
  }

  const applyProgress = createProgressReporter(process.stderr, {
    title: "Restoring files",
    done: "Restore completed",
  });
  const applied = restoreBackup(global.codexHome, backup, { write: true, onProgress: applyProgress });
  applyProgress.finish();
  printJson({ ...applied, confirmed: true, preview });
}

async function confirmApply(
  question: string,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output,
  });

  try {
    const answer = (await rl.question(`\n${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function canApplyMigration(result: MigrationResult): boolean {
  if (!result.ok) {
    return false;
  }

  return hasMigrationChanges(result);
}

function writeJsonConfirmationSummary(kind: "migration" | "restore", result: MigrationResult | RestoreResult): void {
  if (kind === "restore") {
    const restore = result as RestoreResult;
    process.stderr.write(
      `Preview restore: ${restore.restoredFiles} files, ${restore.sqliteFiles} SQLite files. Answer y to apply; default is no.\n`,
    );
    return;
  }

  const migration = result as MigrationResult;
  const sqliteRows = migration.sqlite.reduce((sum, db) => sum + db.changedRows, 0);
  process.stderr.write(
    `Preview migration: ${migration.jsonl.changedFiles} JSONL files, ${migration.jsonl.changedLines} JSONL lines, ${migration.config.changedSections} config project sections, ${migration.state.changedFiles} JSON state files, ${sqliteRows} SQLite rows. Answer y to apply; default is no.\n`,
  );
}

type ProgressReporter = NonNullable<ExecutionOptions["onProgress"]> & { finish: () => void };

interface ProgressReporterOptions {
  title: string;
  done: string;
}

function createProgressReporter(
  output: NodeJS.WritableStream,
  options: ProgressReporterOptions,
): ProgressReporter {
  let active = false;
  let lastEventAt = 0;
  let lastSurface = "";
  const startedAt = Date.now();
  const interactive = Boolean("isTTY" in output && output.isTTY);

  const reporter = ((event) => {
    if (event.total <= 0) {
      return;
    }

    if (!interactive) {
      return;
    }

    const now = Date.now();
    const shouldRender =
      event.current === 1 ||
      event.current === event.total ||
      event.surface !== lastSurface ||
      now - lastEventAt >= 80;

    if (!shouldRender) {
      return;
    }

    if (!active) {
      output.write(`${tui.bold(options.title)}\n`);
      active = true;
    }

    cursorTo(output, 0);
    clearLine(output, 0);
    output.write(progressLine(event.surface, event.current, event.total, event.label, terminalColumns(output)));
    lastEventAt = now;
    lastSurface = event.surface;
  }) as ProgressReporter;

  reporter.finish = () => {
    if (interactive && active) {
      cursorTo(output, 0);
      clearLine(output, 0);
      output.write(
        `${status("success", options.done)} ${tui.gray(`in ${formatDuration(Date.now() - startedAt)}`)}`,
      );
      output.write("\n");
      active = false;
    }
  };

  return reporter;
}

function progressLine(
  surface: ExecutionOptions["onProgress"] extends (event: infer Event) => void
    ? Event extends { surface: infer Surface }
      ? Surface & string
      : string
    : string,
  current: number,
  total: number,
  label: string,
  columns = 100,
): string {
  const percent = total > 0 ? Math.min(1, current / total) : 1;
  const width = columns >= 110 ? 28 : 18;
  const filled = Math.round(percent * width);
  const bar = `${tui.cyan("=".repeat(filled))}${tui.gray("-".repeat(width - filled))}`;
  const count = `${formatCount(current)}/${formatCount(total)}`.padStart(13);
  const pct = `${Math.round(percent * 100)}`.padStart(3);
  const prefix = [
    "  ",
    padVisible(tui.bold(surfaceLabel(surface)), 9),
    `[${bar}]`,
    `${pct}%`,
    count,
  ].join(" ");
  const labelWidth = Math.max(16, columns - visibleWidth(prefix) - 2);
  return [
    prefix,
    tui.gray(truncateMiddle(label, labelWidth)),
  ].join(" ");
}

function surfaceLabel(surface: string): string {
  switch (surface) {
    case "scan":
      return "Scan";
    case "jsonl":
      return "JSONL";
    case "config":
      return "Config";
    case "state":
      return "State";
    case "sqlite":
      return "SQLite";
    case "restore":
      return "Restore";
    default:
      return surface;
  }
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const marker = "...";
  const keep = maxLength - marker.length;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${value.slice(0, left)}${marker}${value.slice(value.length - right)}`;
}

function visibleWidth(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function terminalColumns(output: NodeJS.WritableStream): number {
  const columns = (output as NodeJS.WritableStream & { columns?: number }).columns;
  return typeof columns === "number" && columns > 40 ? columns : 100;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
}

function projectOverview(result: MigrationResult): string {
  if (result.projects.length === 0) {
    return "-";
  }

  const missing = result.projects.filter((project) => !project.targetExists).length;
  const suffix = missing > 0 ? `, ${formatCount(missing)} missing targets` : "";
  return `${formatCount(result.projects.length)} directories${suffix}`;
}

function jsonStateOverview(result: MigrationResult): string {
  return [
    `${formatCount(result.state.changedFiles)} files`,
    `${formatCount(result.state.changedKeys)} keys`,
    `${formatCount(result.state.changedValues)} values`,
  ].join(", ");
}

function sqliteSurfaceName(codexHome: string, db: MigrationResult["sqlite"][number]): string {
  return `SQLite ${relativeFromCodexHome(codexHome, db.database)}:${db.table}`;
}

function printMigration(result: MigrationResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }

  const changedSomething = hasMigrationChanges(result);
  const changeHeader = result.dryRun ? "Would change" : "Changed";
  const missingTargets = result.projects.filter((project) => !project.targetExists);
  process.stdout.write(
    `${result.dryRun ? status("dry", "Migration preview") : status("success", "Migration applied")}\n`,
  );
  process.stdout.write(`${tui.bold("Operation")} ${describeAction(result)}\n`);
  process.stdout.write(section("Overview"));
  process.stdout.write(
    table([
      ["Codex home", pathValue(result.codexHome)],
      ["Projects", projectOverview(result)],
      ["JSONL", `${formatCount(result.jsonl.changedFiles)} files, ${formatCount(result.jsonl.changedLines)} lines`],
      [
        "Config",
        result.config.skipped
          ? `skipped: ${result.config.reason}`
          : `${formatCount(result.config.changedSections)} project sections`,
      ],
      ["JSON state", jsonStateOverview(result)],
      ["SQLite", `${formatCount(totalSqliteChanges(result))} rows`],
    ]),
  );
  process.stdout.write("\n");

  if (result.backupDir) {
    process.stdout.write(table([["Backup", pathValue(result.backupDir)]]));
    process.stdout.write("\n");
  }

  if (result.projects.length > 0) {
    printProjectPlan(result);
  }

  if (missingTargets.length > 0) {
    process.stdout.write(
      `${warnLine(`${formatCount(missingTargets.length)} target project director${missingTargets.length === 1 ? "y is" : "ies are"} missing. Codex Desktop can only open migrated projects after those directories exist.`)}\n`,
    );
    process.stdout.write("\n");
  }

  process.stdout.write(section("Details"));
  process.stdout.write(
    table(
      [
        [
          "JSONL",
          result.jsonl.scannedFiles > 0 ? "ready" : "skipped",
          `${formatCount(result.jsonl.scannedFiles)} files`,
          `${formatCount(result.jsonl.matchedFiles)} files`,
          `${formatCount(result.jsonl.changedFiles)} files / ${formatCount(result.jsonl.changedLines)} lines`,
          "-",
        ],
        [
          "config.toml",
          result.config.skipped ? "skipped" : "ready",
          result.config.skipped ? "-" : `${formatCount(result.config.scannedFiles)} files`,
          result.config.skipped ? "-" : `${formatCount(result.config.matchedSections)} sections`,
          result.config.skipped
            ? `skipped: ${result.config.reason}`
            : `${formatCount(result.config.changedSections)} project sections`,
          "-",
        ],
        [
          "JSON state",
          "ready",
          `${formatCount(result.state.scannedFiles)} files`,
          `${formatCount(result.state.matchedFiles)} files`,
          `${formatCount(result.state.changedFiles)} files / ${formatCount(result.state.changedKeys)} keys / ${formatCount(result.state.changedValues)} values`,
          "-",
        ],
        ...result.sqlite.map((db) => [
          sqliteSurfaceName(result.codexHome, db),
          db.skipped ? "skipped" : "ready",
          db.skipped ? "-" : `${formatCount(db.scannedRows)} rows`,
          db.skipped ? "-" : `${formatCount(db.matchedRows)} rows`,
          db.skipped ? `skipped: ${db.reason}` : sqliteChangeSummary(db),
          db.skipped || db.table !== "threads" ? "-" : rolloutPathStatus(db.missingRolloutPaths),
        ]),
      ],
      ["Surface", "Status", "Scanned", "Matched", changeHeader, "Rollout files"],
    ),
  );
  process.stdout.write("\n");

  for (const warning of result.warnings) {
    process.stderr.write(`${warnLine(warning)}\n`);
  }

  process.stdout.write("\n");
  if (result.dryRun && changedSomething) {
    process.stdout.write(`${hint("Review the preview. Answer y at the prompt to apply; default is no.")}\n`);
  } else if (result.dryRun) {
    process.stdout.write(
      `${hint(`No matching changes found. Try ${command("codex-migrate list providers")} or ${command("codex-migrate list projects")}.`)}\n`,
    );
  } else if (result.backupDir) {
    if (result.ok) {
      process.stdout.write(`${status("success", "Migration completed successfully")}\n`);
    }
    process.stdout.write(`${hint(`Preview rollback with ${command(`codex-migrate restore ${result.backupDir}`)}.`)}\n`);
  }
}

function printBackupList(result: BackupListResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }

  if (result.backups.length === 0) {
    process.stdout.write(`${status("info", "No backups found")}\n`);
    process.stdout.write(`${hint(`Confirmed migrations create backups under ${pathValue(result.codexHome)}.`)}\n`);
    return;
  }

  process.stdout.write(`${status("success", "Backups")}\n`);
  process.stdout.write(
    table(
      result.backups.map((backup) => [
        backup.updatedAt,
        String(backup.files),
        tui.bold(backup.name),
        pathValue(backup.path),
      ]),
      ["Updated", "Files", "Name", "Path"],
    ),
  );
  process.stdout.write("\n");
  process.stdout.write(`${hint(`Preview restore with ${command("codex-migrate restore latest")}.`)}\n`);
}

function printRestore(result: RestoreResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `${result.dryRun ? status("dry", "Restore preview") : status("success", "Restore applied")}\n`,
  );
  process.stdout.write(`${tui.bold("Backup")} ${pathValue(result.backupDir)}\n`);
  process.stdout.write(section("Overview"));
  process.stdout.write(
    table([
      ["Codex home", pathValue(result.codexHome)],
      ["Files", `${formatCount(result.restoredFiles)} files`],
      ["SQLite files", `${formatCount(result.sqliteFiles)} files`],
      ["SQLite sidecars removed", `${formatCount(result.removedWalFiles)} files`],
    ]),
  );
  process.stdout.write("\n");

  if (result.samples.length > 0) {
    process.stdout.write(section(result.restoredFiles > result.samples.length ? "File Sample" : "Files"));
    process.stdout.write(
      table(
        result.samples.map((sample) => [samplePath(sample.from), samplePath(sample.to)]),
        ["Backup file", "Restores to"],
      ),
    );
    process.stdout.write("\n");
    if (result.restoredFiles > result.samples.length) {
      process.stdout.write(
        `${hint(`Showing ${formatCount(result.samples.length)} of ${formatCount(result.restoredFiles)} files.`)}\n`,
      );
    }
  }

  for (const warning of result.warnings) {
    process.stderr.write(`${warnLine(warning)}\n`);
  }

  process.stdout.write("\n");
  if (result.dryRun && result.ok) {
    process.stdout.write(`${hint("Review the file list. Answer y at the prompt to restore; default is no.")}\n`);
  } else if (!result.ok) {
    process.stdout.write(`${hint(`List available backups with ${command("codex-migrate backups list")}.`)}\n`);
  } else {
    process.stdout.write(`${status("success", "Restore completed successfully")}\n`);
  }
}

function printDoctor(result: ReturnType<typeof runDoctor>): void {
  process.stdout.write(`${status(result.ok ? "success" : "warning", "Codex history doctor")}\n`);
  process.stdout.write(
    table([
      ["Codex home", pathValue(result.codexHome)],
      ["Platform", `${result.platform.node} ${tui.gray(`separator ${JSON.stringify(result.platform.pathSeparator)}`)}`],
      ["sqlite3", result.sqlite3Available ? tui.green("available") : tui.yellow("missing")],
      ["Sessions", `${result.sessionsDir.files} files ${tui.gray(result.sessionsDir.path)}`],
      ["Archived", `${result.archivedSessionsDir.files} files ${tui.gray(result.archivedSessionsDir.path)}`],
    ]),
  );
  process.stdout.write("\n");

  process.stdout.write(section("SQLite"));
  process.stdout.write(
    table(
      result.sqlite.map((db) => [
        db.table,
        db.skipped ? tui.yellow("skipped") : tui.green("ready"),
        db.skipped ? (db.reason ?? "") : `${db.scannedRows} rows`,
        db.skipped || db.table !== "threads" ? "-" : rolloutPathStatus(db.missingRolloutPaths),
        pathValue(db.database),
      ]),
      ["Table", "Status", "Rows", "Rollout files", "Database"],
    ),
  );
  process.stdout.write("\n");

  process.stdout.write(section("JSON State"));
  process.stdout.write(
    table(
      [
        ["Files", String(result.state.scannedFiles)],
        ["Path keys", String(result.state.pathKeys)],
        ["Path values", String(result.state.pathValues)],
      ],
      ["Metric", "Count"],
    ),
  );
  process.stdout.write("\n");

  process.stdout.write(section("Indexes"));
  process.stdout.write(
    table(
      [
        [
          "history.jsonl",
          result.indexFiles.history.exists ? tui.green("present") : tui.yellow("missing"),
          String(result.indexFiles.history.entries),
        ],
        [
          "session_index.jsonl",
          result.indexFiles.sessionIndex.exists ? tui.green("present") : tui.yellow("missing"),
          String(result.indexFiles.sessionIndex.entries),
        ],
      ],
      ["File", "Status", "Entries"],
    ),
  );
  process.stdout.write("\n");

  if (result.providers.length > 0) {
    process.stdout.write(section("Providers"));
    process.stdout.write(
      table(
        result.providers.map((provider) => [provider.modelProvider, String(provider.count)]),
        ["Provider", "Threads"],
      ),
    );
    process.stdout.write("\n");
  }

  if (result.projects.length > 0) {
    process.stdout.write(section("Top Projects"));
    process.stdout.write(
      table(
        result.projects.map((project) => [String(project.count), pathValue(project.cwd)]),
        ["Threads", "cwd"],
      ),
    );
    process.stdout.write("\n");
  }

  for (const warning of result.warnings) {
    process.stderr.write(`${warnLine(warning)}\n`);
  }

  process.stdout.write("\n");
  process.stdout.write(
    `${hint(`Run ${command("codex-migrate list providers")} or ${command("codex-migrate list projects --limit 50")} before migrating.`)}\n`,
  );
}

function hasMigrationChanges(result: MigrationResult): boolean {
  return (
    result.jsonl.changedFiles > 0 ||
    result.config.changedSections > 0 ||
    result.state.changedFiles > 0 ||
    result.sqlite.some((db) => db.changedRows > 0)
  );
}

function rolloutPathStatus(missing: number): string {
  return missing > 0 ? tui.yellow(`${missing} missing`) : tui.green("ok");
}

function sqliteChangeSummary(db: MigrationResult["sqlite"][number]): string {
  return db.insertedRows > 0
    ? `${formatCount(db.changedRows)} rows (${formatCount(db.insertedRows)} inserted)`
    : `${formatCount(db.changedRows)} rows`;
}

function totalSqliteChanges(result: MigrationResult): number {
  return result.sqlite.reduce((sum, db) => sum + db.changedRows, 0);
}

function printProjectPlan(result: MigrationResult): void {
  process.stdout.write(section(result.dryRun ? "Project Review" : "Migrated Projects"));
  process.stdout.write(
    table(
      result.projects.map((project) => [
        samplePath(project.fromCwd),
        samplePath(project.toCwd),
        project.targetExists ? tui.green("exists") : tui.yellow("missing"),
        formatCount(project.jsonlFiles),
        formatCount(project.configSections),
        formatCount(project.stateEntries),
        formatCount(project.sqliteRows),
      ]),
      ["From", "To", "Target", "JSONL", "Config", "State", "SQLite"],
    ),
  );
  process.stdout.write("\n");
}

function samplePath(value: string): string {
  return pathValue(compactPath(value, 72));
}

function compactPath(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
  const segments = value.split(separator).filter((segment) => segment.length > 0);
  if (segments.length <= 3) {
    return truncateMiddle(value, maxLength);
  }

  const prefix = value.startsWith(separator) ? separator : "";
  for (let keep = Math.min(4, segments.length - 1); keep >= 1; keep -= 1) {
    const candidate = `${prefix}${segments[0]}${separator}...${separator}${segments.slice(-keep).join(separator)}`;
    if (candidate.length <= maxLength) {
      return candidate;
    }
  }

  return truncateMiddle(value, maxLength);
}

function describeAction(result: MigrationResult): string {
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

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }

  return parsed;
}
