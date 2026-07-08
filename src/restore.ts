import fs from "node:fs";
import path from "node:path";
import { ensureDir, normalizeDir, pathIsDirectory, walkFilesFollowingSymlinks } from "./paths.js";
import type { BackupListResult, ExecutionOptions, RestoreResult } from "./types.js";

const MAX_SAMPLES = 10;

export function listBackups(codexHomeInput: string): BackupListResult {
  const codexHome = normalizeDir(codexHomeInput);
  const warnings: string[] = [];
  const backupsRoot = path.join(codexHome, "backups");

  if (!fs.existsSync(backupsRoot)) {
    return {
      ok: true,
      codexHome,
      backups: [],
      warnings,
    };
  }

  const backups = fs
    .readdirSync(backupsRoot, { withFileTypes: true })
    .filter((entry) => pathIsDirectory(path.join(backupsRoot, entry.name)))
    .map((entry) => {
      const backupPath = path.join(backupsRoot, entry.name);
      const stat = fs.statSync(backupPath);
      return {
        name: entry.name,
        path: backupPath,
        updatedAt: stat.mtime.toISOString(),
        files: walkFiles(backupPath).length,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    ok: true,
    codexHome,
    backups,
    warnings,
  };
}

export function restoreBackup(
  codexHomeInput: string,
  backupInput: string,
  options: { write: boolean; onProgress?: ExecutionOptions["onProgress"] },
): RestoreResult {
  const codexHome = normalizeDir(codexHomeInput);
  const warnings: string[] = [];
  const backupDir = resolveBackupDir(codexHome, backupInput);

  if (!backupDir || !pathIsDirectory(backupDir)) {
    return {
      ok: false,
      dryRun: !options.write,
      codexHome,
      backupDir: backupDir ?? backupInput,
      restoredFiles: 0,
      sqliteFiles: 0,
      removedWalFiles: 0,
      samples: [],
      warnings: [`Backup not found: ${backupInput}`, ...warnings],
    };
  }

  const files = walkFiles(backupDir);
  let sqliteFiles = 0;
  let removedWalFiles = 0;
  const samples: RestoreResult["samples"] = [];

  for (const [index, file] of files.entries()) {
    const relative = path.relative(backupDir, file);
    options.onProgress?.({
      surface: "restore",
      current: index + 1,
      total: files.length,
      label: relative,
    });

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      warnings.push(`Skipped unsafe backup path: ${file}`);
      continue;
    }

    const destination = path.join(codexHome, relative);

    if (samples.length < MAX_SAMPLES) {
      samples.push({ from: file, to: destination });
    }

    if (isSqliteDatabaseFile(destination)) {
      sqliteFiles += 1;
    }

    if (!options.write) {
      continue;
    }

    ensureDir(path.dirname(destination));

    if (isSqliteDatabaseFile(destination)) {
      removedWalFiles += removeSqliteSidecars(destination);
    }

    fs.copyFileSync(file, destination);
  }

  return {
    ok: warnings.length === 0,
    dryRun: !options.write,
    codexHome,
    backupDir,
    restoredFiles: files.length,
    sqliteFiles,
    removedWalFiles,
    samples,
    warnings,
  };
}

function resolveBackupDir(codexHome: string, input: string): string | undefined {
  if (input === "latest") {
    return listBackups(codexHome).backups[0]?.path;
  }

  const expanded = normalizeDir(input);
  if (fs.existsSync(expanded)) {
    return expanded;
  }

  return path.join(codexHome, "backups", input);
}

function walkFiles(dir: string): string[] {
  return walkFilesFollowingSymlinks(dir);
}

function isSqliteDatabaseFile(file: string): boolean {
  return file.endsWith(".sqlite") || file.endsWith(".db");
}

function removeSqliteSidecars(database: string): number {
  let removed = 0;
  for (const suffix of ["-wal", "-shm"]) {
    const file = `${database}${suffix}`;
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed += 1;
    }
  }

  return removed;
}
