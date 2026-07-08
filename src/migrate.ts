import fs from "node:fs";
import path from "node:path";
import { migrateConfigToml } from "./config.js";
import { applyJsonlPlan, discoverSessionFiles, migrateJsonlFiles, validateJsonlPlan } from "./jsonl.js";
import { ensureDir, normalizeDir, pathIsDirectory } from "./paths.js";
import { migrateSqlite, sqliteWritePreflight } from "./sqlite.js";
import { migrateJsonState } from "./state.js";
import type { ExecutionOptions, JsonlMigrationPlan, MigrationResult, MigrationSpec, ProjectMigrationSummary } from "./types.js";

export const DEFAULT_MAX_BACKUPS = 10;
const MIGRATION_BACKUP_PREFIX = "codex-migrate-";

export function runMigration(
  spec: MigrationSpec,
  options: ExecutionOptions,
): MigrationResult {
  const codexHome = normalizeDir(options.codexHome);
  const maxBackups = normalizeMaxBackups(options.maxBackups);
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

  if (options.write && options.includeJsonl && options.jsonlPlan) {
    validateJsonlPlan(options.jsonlPlan, codexHome, options.includeArchived, spec);
  }

  const backupDir = options.write ? createBackupDir(codexHome) : undefined;

  let jsonlPlan: JsonlMigrationPlan | undefined = options.jsonlPlan;
  const jsonl = options.includeJsonl
    ? (() => {
        if (options.write && jsonlPlan) {
          if (!backupDir) {
            throw new Error("backupDir is required when writing JSONL changes");
          }

          return applyJsonlPlan(jsonlPlan, {
            codexHome,
            backupDir,
            onProgress: options.onProgress,
          });
        }

        const sessions = discoverSessionFiles(codexHome, options.includeArchived, options.onProgress);
        const result = migrateJsonlFiles(sessions, spec, {
          write: false,
          codexHome,
          includeArchived: options.includeArchived,
          backupDir,
          onPlan: (plan) => {
            jsonlPlan = plan;
            options.onJsonlPlan?.(plan);
          },
          onProgress: options.onProgress,
        });

        if (options.write) {
          if (!jsonlPlan || !backupDir) {
            throw new Error("JSONL migration plan is required when writing JSONL changes");
          }

          validateJsonlPlan(jsonlPlan, codexHome, options.includeArchived, spec);
          return applyJsonlPlan(jsonlPlan, {
            codexHome,
            backupDir,
            onProgress: options.onProgress,
          });
        }

        return result;
      })()
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
  const backupRetention = backupDir
    ? pruneMigrationBackups(codexHome, maxBackups, backupDir)
    : undefined;

  return {
    ok: warnings.length === 0,
    dryRun: !options.write,
    action: spec,
    codexHome,
    backupDir,
    backupRetention,
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
    changedValues: 0,
    projectChanges: [],
    providerChanges: [],
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
  const backupsRoot = path.join(codexHome, "backups");
  ensureDir(backupsRoot);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const backupDir = path.join(backupsRoot, `${MIGRATION_BACKUP_PREFIX}${timestamp}${suffix}`);
    try {
      fs.mkdirSync(backupDir);
      return backupDir;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Unable to create a unique backup directory under ${backupsRoot}`);
}

function normalizeMaxBackups(value: number | undefined): number {
  const maxBackups = value ?? DEFAULT_MAX_BACKUPS;
  if (!Number.isSafeInteger(maxBackups) || maxBackups < 0) {
    throw new Error(`maxBackups must be a non-negative integer, got ${String(value)}`);
  }

  return maxBackups;
}

interface MigrationBackupDir {
  name: string;
  path: string;
  updatedAtMs: number;
}

function pruneMigrationBackups(
  codexHome: string,
  maxBackups: number,
  activeBackupDir: string,
): NonNullable<MigrationResult["backupRetention"]> {
  if (maxBackups === 0) {
    return { maxBackups, prunedBackups: [] };
  }

  const backupsRoot = path.join(codexHome, "backups");
  const activePath = path.resolve(activeBackupDir);
  const backups = listMigrationBackupDirs(backupsRoot);
  const active = backups.find((backup) => path.resolve(backup.path) === activePath);
  const ordered = active
    ? [active, ...backups.filter((backup) => path.resolve(backup.path) !== activePath)]
    : backups;
  const retainedPaths = new Set(ordered.slice(0, maxBackups).map((backup) => path.resolve(backup.path)));
  const prunedBackups = ordered
    .filter((backup) => !retainedPaths.has(path.resolve(backup.path)))
    .map((backup) => ({ name: backup.name, path: backup.path }));

  for (const backup of prunedBackups) {
    fs.rmSync(backup.path, { recursive: true, force: true });
  }

  return { maxBackups, prunedBackups };
}

function listMigrationBackupDirs(backupsRoot: string): MigrationBackupDir[] {
  if (!fs.existsSync(backupsRoot)) {
    return [];
  }

  return fs
    .readdirSync(backupsRoot, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(MIGRATION_BACKUP_PREFIX))
    .filter((entry) => pathIsDirectory(path.join(backupsRoot, entry.name)))
    .map((entry) => {
      const backupPath = path.join(backupsRoot, entry.name);
      const stat = fs.statSync(backupPath);
      return {
        name: entry.name,
        path: backupPath,
        updatedAtMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.name.localeCompare(a.name));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
