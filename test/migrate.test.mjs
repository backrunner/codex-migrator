import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMigration } from "../dist/migrate.js";

function makeTempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-migrate-test-"));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("write project migration updates JSONL and creates a backup", () => {
  const codexHome = makeTempCodexHome();
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "28");
  fs.mkdirSync(sessionDir, { recursive: true });

  const file = path.join(sessionDir, "rollout-test.jsonl");
  const original = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: { id: "thread-1", cwd: "/old/app", model_provider: "openai" },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: { cwd: "/old/app/packages/lib", workspace_roots: ["/old/app"] },
    }),
    "",
  ].join("\n");
  fs.writeFileSync(file, original);

  const result = runMigration(
    { mode: "project", projectName: "app", targetDir: "/new/app" },
    {
      write: true,
      codexHome,
      includeArchived: true,
      includeJsonl: true,
      includeSqlite: false,
      json: true,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.jsonl.changedFiles, 1);
  assert.ok(result.backupDir);

  const [meta, turn] = readJsonl(file);
  assert.equal(meta.payload.cwd, "/new/app");
  assert.equal(turn.payload.cwd, "/new/app/packages/lib");
  assert.deepEqual(turn.payload.workspace_roots, ["/new/app"]);

  const backupFile = path.join(
    result.backupDir,
    "sessions",
    "2026",
    "06",
    "28",
    "rollout-test.jsonl",
  );
  assert.equal(fs.readFileSync(backupFile, "utf8"), original);
});

test("write provider migration updates sqlite and creates a backup", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const database = path.join(codexHome, "state_5.sqlite");
  execFileSync("sqlite3", [
    database,
    [
      "create table threads (id text primary key, cwd text not null, model_provider text not null);",
      "insert into threads values ('thread-1', '/old/app', 'openai');",
    ].join("\n"),
  ]);

  const result = runMigration(
    { mode: "provider", targetProvider: "packycode", fromProvider: "openai" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: true,
      json: true,
    },
  );

  assert.equal(result.sqlite[0].changedRows, 1);
  assert.ok(result.backupDir);
  assert.ok(fs.existsSync(path.join(result.backupDir, "state_5.sqlite")));

  const provider = execFileSync("sqlite3", [
    database,
    "select model_provider from threads where id = 'thread-1';",
  ])
    .toString("utf8")
    .trim();
  assert.equal(provider, "packycode");
});

test("write migration does not create a missing codex home", () => {
  const parent = makeTempCodexHome();
  const missingHome = path.join(parent, "missing");

  const result = runMigration(
    { mode: "provider", targetProvider: "packycode" },
    {
      write: true,
      codexHome: missingHome,
      includeArchived: true,
      includeJsonl: true,
      includeSqlite: true,
      json: true,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.backupDir, undefined);
  assert.equal(fs.existsSync(missingHome), false);
});

test("write migration stops before JSONL changes when sqlite preflight fails", () => {
  const codexHome = makeTempCodexHome();
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "28");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "not a sqlite database");

  const file = path.join(sessionDir, "rollout-test.jsonl");
  const original = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: { id: "thread-1", cwd: "/old/app", model_provider: "openai" },
    }),
    "",
  ].join("\n");
  fs.writeFileSync(file, original);

  const result = runMigration(
    { mode: "provider", targetProvider: "packycode", fromProvider: "openai" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: true,
      includeSqlite: true,
      json: true,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.backupDir, undefined);
  assert.match(result.warnings[0], /SQLite is not ready/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});
