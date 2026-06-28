#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./doctor.js";
import { runMigration } from "./migrate.js";
import { defaultCodexHome, normalizeDir, normalizeHistoryPath } from "./paths.js";
import { listBackups, restoreBackup } from "./restore.js";
import { projectCounts, providerCounts } from "./sqlite.js";
import { printError, printJson } from "./output.js";
import type { BackupListResult, ExecutionOptions, GlobalOptions, MigrationResult, RestoreResult } from "./types.js";

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
        for (const row of rows) {
          if ("modelProvider" in row) {
            process.stdout.write(`${row.count}\t${row.modelProvider}\n`);
          } else {
            process.stdout.write(`${row.count}\t${row.cwd}\n`);
          }
        }
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
  .action(async (backup: string, options: { write?: boolean }) => {
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
  .action(
    async (
      targetProvider: string,
      options: {
        from?: string;
        write?: boolean;
        jsonl: boolean;
        sqlite: boolean;
      },
    ) => {
      await runCommand((global) => {
        const result = runMigration(
          {
            mode: "provider",
            targetProvider,
            fromProvider: options.from,
          },
          executionOptions(global, options),
        );
        printMigration(result, global.json);
      });
    },
  );

program
  .command("project")
  .description("Migrate one project's conversations to a new project directory.")
  .argument("<name>", "project basename or absolute source cwd")
  .argument("<targetDir>", "new project directory")
  .option("--from-dir <dir>", "exact source cwd; overrides basename matching")
  .option("--write", "apply changes; without this flag the command is a dry run")
  .option("--no-jsonl", "skip JSONL rollout files")
  .option("--no-sqlite", "skip SQLite thread catalogs")
  .action(
    async (
      name: string,
      targetDir: string,
      options: {
        fromDir?: string;
        write?: boolean;
        jsonl: boolean;
        sqlite: boolean;
      },
    ) => {
      await runCommand((global) => {
        const result = runMigration(
          {
            mode: "project",
            projectName: name,
            targetDir: normalizeHistoryPath(targetDir),
            fromDir: options.fromDir ? normalizeHistoryPath(options.fromDir) : undefined,
          },
          executionOptions(global, options),
        );
        printMigration(result, global.json);
      });
    },
  );

program
  .command("projects")
  .description("Migrate every project under one directory tree to another directory tree.")
  .argument("<originalDir>", "old parent directory")
  .argument("<targetDir>", "new parent directory")
  .option("--write", "apply changes; without this flag the command is a dry run")
  .option("--no-jsonl", "skip JSONL rollout files")
  .option("--no-sqlite", "skip SQLite thread catalogs")
  .action(
    async (
      originalDir: string,
      targetDir: string,
      options: {
        write?: boolean;
        jsonl: boolean;
        sqlite: boolean;
      },
    ) => {
      await runCommand((global) => {
        const result = runMigration(
          {
            mode: "projects",
            originalDir: normalizeHistoryPath(originalDir),
            targetDir: normalizeHistoryPath(targetDir),
          },
          executionOptions(global, options),
        );
        printMigration(result, global.json);
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
    write?: boolean;
    jsonl?: boolean;
    sqlite?: boolean;
  },
): ExecutionOptions {
  return {
    write: Boolean(commandOptions.write),
    codexHome: global.codexHome,
    includeArchived: global.archived,
    includeJsonl: commandOptions.jsonl !== false,
    includeSqlite: commandOptions.sqlite !== false,
    json: global.json,
  };
}

function printMigration(result: MigrationResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }

  process.stdout.write(`${result.dryRun ? "Dry run" : "Applied"}: ${describeAction(result)}\n`);
  process.stdout.write(`Codex home: ${result.codexHome}\n`);
  if (result.backupDir) {
    process.stdout.write(`Backup: ${result.backupDir}\n`);
  }
  process.stdout.write(
    `JSONL: scanned ${result.jsonl.scannedFiles}, matched ${result.jsonl.matchedFiles}, changed ${result.jsonl.changedFiles} files / ${result.jsonl.changedLines} lines\n`,
  );

  for (const db of result.sqlite) {
    if (db.skipped) {
      process.stdout.write(`SQLite: skipped ${db.database} (${db.reason})\n`);
    } else {
      process.stdout.write(
        `SQLite: ${db.table} in ${db.database}: scanned ${db.scannedRows}, changed ${db.changedRows}\n`,
      );
    }
  }

  if (result.jsonl.samples.length > 0) {
    process.stdout.write("Samples:\n");
    for (const sample of result.jsonl.samples) {
      if (sample.toProvider) {
        process.stdout.write(
          `- ${sample.id ?? sample.file}: ${sample.fromProvider ?? "(unknown)"} -> ${sample.toProvider}\n`,
        );
      } else {
        process.stdout.write(
          `- ${sample.id ?? sample.file}: ${sample.fromCwd ?? "(unknown)"} -> ${sample.toCwd ?? "(unknown)"}\n`,
        );
      }
    }
  }

  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
}

function printBackupList(result: BackupListResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }

  if (result.backups.length === 0) {
    process.stdout.write(`No backups found under ${result.codexHome}\n`);
    return;
  }

  for (const backup of result.backups) {
    process.stdout.write(`${backup.updatedAt}\t${backup.files}\t${backup.name}\t${backup.path}\n`);
  }
}

function printRestore(result: RestoreResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }

  process.stdout.write(`${result.dryRun ? "Dry run" : "Restored"}: ${result.backupDir}\n`);
  process.stdout.write(`Codex home: ${result.codexHome}\n`);
  process.stdout.write(
    `Files: ${result.restoredFiles} total, ${result.sqliteFiles} SQLite, ${result.removedWalFiles} SQLite sidecars removed\n`,
  );

  if (result.samples.length > 0) {
    process.stdout.write("Samples:\n");
    for (const sample of result.samples) {
      process.stdout.write(`- ${sample.from} -> ${sample.to}\n`);
    }
  }

  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
}

function printDoctor(result: ReturnType<typeof runDoctor>): void {
  process.stdout.write(`Codex home: ${result.codexHome}\n`);
  process.stdout.write(
    `platform: ${result.platform.node} (path separator: ${JSON.stringify(result.platform.pathSeparator)})\n`,
  );
  process.stdout.write(`sqlite3: ${result.sqlite3Available ? "available" : "missing"}\n`);
  process.stdout.write(
    `sessions: ${result.sessionsDir.files} files (${result.sessionsDir.path})\n`,
  );
  process.stdout.write(
    `archived: ${result.archivedSessionsDir.files} files (${result.archivedSessionsDir.path})\n`,
  );

  for (const db of result.sqlite) {
    if (db.skipped) {
      process.stdout.write(`SQLite: skipped ${db.database} (${db.reason})\n`);
    } else {
      process.stdout.write(`SQLite: ${db.table} in ${db.database}: ${db.scannedRows} rows\n`);
    }
  }

  if (result.providers.length > 0) {
    process.stdout.write("Providers:\n");
    for (const provider of result.providers) {
      process.stdout.write(`- ${provider.modelProvider}: ${provider.count}\n`);
    }
  }

  if (result.projects.length > 0) {
    process.stdout.write("Top projects:\n");
    for (const project of result.projects) {
      process.stdout.write(`- ${project.count}\t${project.cwd}\n`);
    }
  }

  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
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
