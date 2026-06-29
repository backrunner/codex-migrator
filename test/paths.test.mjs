import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  firstPathUnderParent,
  historyBasename,
  isHistoryPathAbsolute,
  normalizeExistingHistoryPath,
  remapPathPrefix,
  sameHistoryPath,
} from "../dist/paths.js";

test("remapPathPrefix handles posix paths", () => {
  assert.equal(
    remapPathPrefix("/home/me/projects/app/packages/lib", "/home/me/projects", "/mnt/work"),
    "/mnt/work/app/packages/lib",
  );
  assert.equal(remapPathPrefix("/home/me/projects2/app", "/home/me/projects", "/mnt/work"), undefined);
});

test("remapPathPrefix handles win32 paths on any host", () => {
  assert.equal(
    remapPathPrefix(
      String.raw`C:\Users\me\Projects\app\packages\lib`,
      String.raw`C:\Users\me\Projects`,
      String.raw`D:\Work`,
    ),
    String.raw`D:\Work\app\packages\lib`,
  );
  assert.equal(
    remapPathPrefix(
      String.raw`C:\Users\me\Projects2\app`,
      String.raw`C:\Users\me\Projects`,
      String.raw`D:\Work`,
    ),
    undefined,
  );
});

test("history path helpers detect win32 and posix styles", () => {
  assert.equal(historyBasename(String.raw`C:\Users\me\Projects\app`), "app");
  assert.equal(historyBasename("/home/me/projects/app"), "app");
  assert.equal(isHistoryPathAbsolute(String.raw`C:\Users\me\Projects\app`), true);
  assert.equal(isHistoryPathAbsolute("/home/me/projects/app"), true);
  assert.equal(
    sameHistoryPath(String.raw`C:\Users\me\Projects\App`, String.raw`c:\users\me\projects\app`),
    true,
  );
  assert.equal(sameHistoryPath("/home/me/Projects/App", "/home/me/projects/app"), false);
});

test("firstPathUnderParent returns one project level below the parent", () => {
  assert.equal(
    firstPathUnderParent("/home/me/projects/app/packages/lib", "/home/me/projects"),
    "/home/me/projects/app",
  );
  assert.equal(firstPathUnderParent("/home/me/projects", "/home/me/projects"), "/home/me/projects");
  assert.equal(firstPathUnderParent("/home/me/projects2/app", "/home/me/projects"), undefined);
  assert.equal(
    firstPathUnderParent(
      String.raw`C:\Users\me\Projects\app\packages\lib`,
      String.raw`C:\Users\me\Projects`,
    ),
    String.raw`C:\Users\me\Projects\app`,
  );
});

test("normalizeExistingHistoryPath preserves existing filesystem casing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-migrate-path-test-"));
  const actual = path.join(root, "QuaEngine");
  fs.mkdirSync(actual);
  const lowercase = path.join(root, "quaengine");

  if (!fs.existsSync(lowercase)) {
    t.skip("filesystem is case-sensitive");
    return;
  }

  assert.equal(normalizeExistingHistoryPath(lowercase), actual);
});
