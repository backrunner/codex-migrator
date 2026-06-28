import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
