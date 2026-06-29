import assert from "node:assert/strict";
import test from "node:test";
import { transformJsonlContent } from "../dist/jsonl.js";

const session = {
  file: "/tmp/rollout.jsonl",
  id: "thread-1",
  cwd: "/old/root/app",
  modelProvider: "old-provider",
  archived: false,
};

test("provider migration updates only session metadata", () => {
  const input = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: { id: "thread-1", cwd: "/old/root/app", model_provider: "old-provider" },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: { cwd: "/old/root/app", workspace_roots: ["/old/root/app"] },
    }),
    "",
  ].join("\n");

  const result = transformJsonlContent(
    input,
    { mode: "provider", targetProvider: "new-provider", fromProvider: "old-provider" },
    session,
  );

  const [first, second] = result.content.split("\n").map((line) => line && JSON.parse(line));
  assert.equal(result.changedLines, 1);
  assert.equal(first.payload.model_provider, "new-provider");
  assert.equal(second.payload.cwd, "/old/root/app");
});

test("projects migration preserves relative project paths", () => {
  const input = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: { id: "thread-1", cwd: "/old/root/app", model_provider: "provider" },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: {
        cwd: "/old/root/app",
        workspace_roots: ["/old/root/app", "/old/root/app/packages/lib"],
      },
    }),
    "",
  ].join("\n");

  const result = transformJsonlContent(
    input,
    { mode: "projects", originalDir: "/old/root", targetDir: "/new/root" },
    session,
  );

  const [first, second] = result.content.split("\n").map((line) => line && JSON.parse(line));
  assert.equal(result.changedLines, 2);
  assert.equal(first.payload.cwd, "/new/root/app");
  assert.equal(second.payload.cwd, "/new/root/app");
  assert.deepEqual(second.payload.workspace_roots, [
    "/new/root/app",
    "/new/root/app/packages/lib",
  ]);
});

test("single project migration maps matching project basename to target dir", () => {
  const input = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: { id: "thread-1", cwd: "/old/root/app", model_provider: "provider" },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: { cwd: "/old/root/app/packages/lib", workspace_roots: ["/old/root/app"] },
    }),
    "",
  ].join("\n");

  const result = transformJsonlContent(
    input,
    { mode: "project", projectName: "app", targetDir: "/new/location/app" },
    session,
  );

  const [first, second] = result.content.split("\n").map((line) => line && JSON.parse(line));
  assert.equal(result.changedLines, 2);
  assert.equal(first.payload.cwd, "/new/location/app");
  assert.equal(second.payload.cwd, "/new/location/app/packages/lib");
  assert.deepEqual(second.payload.workspace_roots, ["/new/location/app"]);
});

test("single project migration with fromDir preserves nested cwd paths", () => {
  const nestedSession = {
    file: "/tmp/rollout.jsonl",
    id: "thread-1",
    cwd: "/old/root/app/packages/lib",
    modelProvider: "provider",
    archived: false,
  };
  const input = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: {
        id: "thread-1",
        cwd: "/old/root/app/packages/lib",
        model_provider: "provider",
      },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: {
        cwd: "/old/root/app/packages/lib/src",
        workspace_roots: ["/old/root/app"],
      },
    }),
    "",
  ].join("\n");

  const result = transformJsonlContent(
    input,
    {
      mode: "project",
      projectName: "app",
      targetDir: "/new/location/app",
      fromDir: "/old/root/app",
    },
    nestedSession,
  );

  const [first, second] = result.content.split("\n").map((line) => line && JSON.parse(line));
  assert.equal(result.changedLines, 2);
  assert.equal(first.payload.cwd, "/new/location/app/packages/lib");
  assert.equal(second.payload.cwd, "/new/location/app/packages/lib/src");
  assert.deepEqual(second.payload.workspace_roots, ["/new/location/app"]);
});

test("single project migration updates project paths when session cwd is a worktree", () => {
  const worktreeSession = {
    file: "/tmp/rollout.jsonl",
    id: "thread-1",
    cwd: "/Users/me/.codex/worktrees/1234/app",
    modelProvider: "provider",
    archived: false,
  };
  const input = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: {
        id: "thread-1",
        cwd: "/Users/me/.codex/worktrees/1234/app",
        model_provider: "provider",
      },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: {
        cwd: "/old/root/app/packages/lib",
        workspace_roots: ["/old/root/app"],
      },
    }),
    "",
  ].join("\n");

  const result = transformJsonlContent(
    input,
    {
      mode: "project",
      projectName: "app",
      targetDir: "/new/location/app",
    },
    worktreeSession,
  );

  const [first, second] = result.content.split("\n").map((line) => line && JSON.parse(line));
  assert.equal(result.changedLines, 2);
  assert.equal(first.payload.cwd, "/new/location/app");
  assert.equal(second.payload.cwd, "/new/location/app/packages/lib");
  assert.deepEqual(second.payload.workspace_roots, ["/new/location/app"]);
});

test("single project migration infers nested project root case-insensitively", () => {
  const nestedSession = {
    file: "/tmp/rollout.jsonl",
    id: "thread-1",
    cwd: "/old/root/QuaEngine/ai/novel-writer",
    modelProvider: "provider",
    archived: false,
  };
  const input = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: {
        id: "thread-1",
        cwd: "/old/root/QuaEngine/ai/novel-writer",
        model_provider: "provider",
      },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: {
        cwd: "/old/root/QuaEngine/ai/novel-writer/src",
        workspace_roots: ["/old/root/QuaEngine"],
      },
    }),
    "",
  ].join("\n");

  const result = transformJsonlContent(
    input,
    {
      mode: "project",
      projectName: "quaengine",
      targetDir: "/new/root/QuaEngine",
    },
    nestedSession,
  );

  const [first, second] = result.content.split("\n").map((line) => line && JSON.parse(line));
  assert.equal(result.changedLines, 2);
  assert.equal(first.payload.cwd, "/new/root/QuaEngine/ai/novel-writer");
  assert.equal(second.payload.cwd, "/new/root/QuaEngine/ai/novel-writer/src");
  assert.deepEqual(second.payload.workspace_roots, ["/new/root/QuaEngine"]);
});

test("project migration handles win32 paths", () => {
  const windowsSession = {
    file: "/tmp/rollout.jsonl",
    id: "thread-1",
    cwd: String.raw`C:\Users\me\Projects\app`,
    modelProvider: "provider",
    archived: false,
  };
  const input = [
    JSON.stringify({
      timestamp: "now",
      type: "session_meta",
      payload: {
        id: "thread-1",
        cwd: String.raw`C:\Users\me\Projects\app`,
        model_provider: "provider",
      },
    }),
    JSON.stringify({
      timestamp: "now",
      type: "turn_context",
      payload: {
        cwd: String.raw`C:\Users\me\Projects\app\packages\lib`,
        workspace_roots: [String.raw`C:\Users\me\Projects\app`],
      },
    }),
    "",
  ].join("\n");

  const result = transformJsonlContent(
    input,
    { mode: "project", projectName: "app", targetDir: String.raw`D:\Work\app` },
    windowsSession,
  );

  const [first, second] = result.content.split("\n").map((line) => line && JSON.parse(line));
  assert.equal(result.changedLines, 2);
  assert.equal(first.payload.cwd, String.raw`D:\Work\app`);
  assert.equal(second.payload.cwd, String.raw`D:\Work\app\packages\lib`);
  assert.deepEqual(second.payload.workspace_roots, [String.raw`D:\Work\app`]);
});
