import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("cli preserves win32 history path arguments on any host", () => {
  const missingHome = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "codex-migrate-cli-test-")),
    "missing",
  );

  const stdout = execFileSync(process.execPath, [
    "dist/cli.js",
    "--json",
    "--codex-home",
    missingHome,
    "projects",
    String.raw`C:\Users\me\Projects`,
    String.raw`D:\Work`,
    "--no-sqlite",
  ]);

  const result = JSON.parse(stdout.toString("utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.action.originalDir, String.raw`C:\Users\me\Projects`);
  assert.equal(result.action.targetDir, String.raw`D:\Work`);
  assert.equal(fs.existsSync(missingHome), false);
});

test("cli migration asks for confirmation and defaults to no", () => {
  const codexHome = makeTempCodexHome();
  const file = makeSession(codexHome);

  const declined = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "--codex-home",
      codexHome,
      "project",
      "app",
      "/new/app",
      "--no-sqlite",
    ],
    { input: "\n", encoding: "utf8" },
  );

  assert.equal(declined.status, 0, declined.stderr);
  assert.match(declined.stdout, /Apply these migration changes\?/);
  assert.equal(readSessionCwd(file), "/old/app");

  const confirmed = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "--codex-home",
      codexHome,
      "project",
      "app",
      "/new/app",
      "--no-sqlite",
    ],
    { input: "y\n", encoding: "utf8" },
  );

  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(confirmed.stdout, /Migration applied/);
  assert.match(confirmed.stdout, /Project Review|Migrated Projects/);
  assert.match(confirmed.stdout, /SQLite/);
  assert.doesNotMatch(confirmed.stderr, /INFO Apply/);
  assert.equal(readSessionCwd(file), "/new/app");
});

test("cli --yes applies migration without prompting", () => {
  const codexHome = makeTempCodexHome();
  const file = makeSession(codexHome);

  const result = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "--yes",
      "--codex-home",
      codexHome,
      "project",
      "app",
      "/new/app",
      "--no-sqlite",
    ],
    { input: "", encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Apply these migration changes\?/);
  assert.match(result.stdout, /Migration applied/);
  assert.equal(readSessionCwd(file), "/new/app");
});

test("tty progress uses human task labels without duplicate INFO lines", { skip: !process.stdin.isTTY }, () => {
  const codexHome = makeTempCodexHome();
  const file = makeSession(codexHome);

  const result = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "--codex-home",
      codexHome,
      "project",
      "app",
      "/new/app",
      "--no-sqlite",
    ],
    {
      input: "y\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /INFO Apply/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /INFO Preview/);
  assert.equal(readSessionCwd(file), "/new/app");
});

test("json cli migration confirms before writing and emits one JSON object", () => {
  const codexHome = makeTempCodexHome();
  const file = makeSession(codexHome);

  const declined = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "--json",
      "--codex-home",
      codexHome,
      "project",
      "app",
      "/new/app",
      "--no-sqlite",
    ],
    { input: "\n", encoding: "utf8" },
  );

  assert.equal(declined.status, 0, declined.stderr);
  const declinedJson = JSON.parse(declined.stdout);
  assert.equal(declinedJson.confirmed, false);
  assert.equal(declinedJson.dryRun, true);
  assert.equal(readSessionCwd(file), "/old/app");

  const confirmed = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "--json",
      "--codex-home",
      codexHome,
      "project",
      "app",
      "/new/app",
      "--no-sqlite",
    ],
    { input: "y\n", encoding: "utf8" },
  );

  assert.equal(confirmed.status, 0, confirmed.stderr);
  const confirmedJson = JSON.parse(confirmed.stdout);
  assert.equal(confirmedJson.confirmed, true);
  assert.equal(confirmedJson.dryRun, false);
  assert.equal(confirmedJson.preview.dryRun, true);
  assert.equal(readSessionCwd(file), "/new/app");
});

function makeTempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-migrate-cli-test-"));
}

function makeSession(codexHome) {
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "28");
  fs.mkdirSync(sessionDir, { recursive: true });

  const file = path.join(sessionDir, "rollout-test.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "now",
        type: "session_meta",
        payload: { id: "thread-1", cwd: "/old/app", model_provider: "openai" },
      }),
      "",
    ].join("\n"),
  );

  return file;
}

function readSessionCwd(file) {
  const first = fs.readFileSync(file, "utf8").split("\n")[0];
  return JSON.parse(first).payload.cwd;
}
