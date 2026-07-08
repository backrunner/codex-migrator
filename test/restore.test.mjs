import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listBackups, restoreBackup } from "../dist/restore.js";

function makeTempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-restore-test-"));
}

function symlinkDirOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link, "dir");
    return true;
  } catch (error) {
    t.skip(`directory symlinks are not available: ${error.message}`);
    return false;
  }
}

test("restoreBackup defaults to dry-run and write restores files", () => {
  const codexHome = makeTempCodexHome();
  const backupDir = path.join(codexHome, "backups", "codex-migrate-test");
  const relative = path.join("sessions", "2026", "06", "28", "rollout.jsonl");
  const backupFile = path.join(backupDir, relative);
  const targetFile = path.join(codexHome, relative);

  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(backupFile, "original\n");
  fs.writeFileSync(targetFile, "changed\n");

  const dryRun = restoreBackup(codexHome, "codex-migrate-test", { write: false });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.restoredFiles, 1);
  assert.equal(fs.readFileSync(targetFile, "utf8"), "changed\n");

  const applied = restoreBackup(codexHome, "codex-migrate-test", { write: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.dryRun, false);
  assert.equal(fs.readFileSync(targetFile, "utf8"), "original\n");
});

test("restoreBackup removes sqlite sidecars before restoring database files", () => {
  const codexHome = makeTempCodexHome();
  const backupDir = path.join(codexHome, "backups", "codex-migrate-test");
  fs.mkdirSync(backupDir, { recursive: true });

  const backupDb = path.join(backupDir, "state_5.sqlite");
  const targetDb = path.join(codexHome, "state_5.sqlite");
  fs.writeFileSync(backupDb, "backup-db");
  fs.writeFileSync(targetDb, "current-db");
  fs.writeFileSync(`${targetDb}-wal`, "stale-wal");
  fs.writeFileSync(`${targetDb}-shm`, "stale-shm");

  const result = restoreBackup(codexHome, "latest", { write: true });
  assert.equal(result.ok, true);
  assert.equal(result.sqliteFiles, 1);
  assert.equal(result.removedWalFiles, 2);
  assert.equal(fs.readFileSync(targetDb, "utf8"), "backup-db");
  assert.equal(fs.existsSync(`${targetDb}-wal`), false);
  assert.equal(fs.existsSync(`${targetDb}-shm`), false);
});

test("restoreBackup follows symlinked backup directories", (t) => {
  const codexHome = makeTempCodexHome();
  const backupDir = path.join(codexHome, "backups", "codex-migrate-test");
  const linkedSessions = path.join(codexHome, "linked-backup-sessions");
  const backupFile = path.join(linkedSessions, "2026", "06", "28", "rollout.jsonl");
  const targetFile = path.join(codexHome, "sessions", "2026", "06", "28", "rollout.jsonl");

  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(backupFile, "original\n");
  if (!symlinkDirOrSkip(t, linkedSessions, path.join(backupDir, "sessions"))) {
    return;
  }

  const dryRun = restoreBackup(codexHome, "codex-migrate-test", { write: false });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.restoredFiles, 1);
  assert.equal(fs.existsSync(targetFile), false);

  const applied = restoreBackup(codexHome, "codex-migrate-test", { write: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.restoredFiles, 1);
  assert.equal(fs.readFileSync(targetFile, "utf8"), "original\n");
});

test("listBackups returns newest backups first", () => {
  const codexHome = makeTempCodexHome();
  const backupsRoot = path.join(codexHome, "backups");
  fs.mkdirSync(path.join(backupsRoot, "codex-migrate-old"), { recursive: true });
  fs.mkdirSync(path.join(backupsRoot, "codex-migrate-new"), { recursive: true });
  fs.writeFileSync(path.join(backupsRoot, "codex-migrate-new", "state_5.sqlite"), "db");
  fs.utimesSync(path.join(backupsRoot, "codex-migrate-old"), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(backupsRoot, "codex-migrate-new"), new Date(2000), new Date(2000));

  const result = listBackups(codexHome);
  assert.equal(result.ok, true);
  assert.equal(result.backups.length, 2);
  assert.equal(result.backups[0].name, "codex-migrate-new");
  assert.equal(result.backups[0].files, 1);
});
