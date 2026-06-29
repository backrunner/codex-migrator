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

test("project migration samples are grouped one per project", () => {
  const codexHome = makeTempCodexHome();
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "28");
  fs.mkdirSync(sessionDir, { recursive: true });

  writeSession(path.join(sessionDir, "rollout-app-root.jsonl"), "thread-app-root", "/old/root/app");
  writeSession(path.join(sessionDir, "rollout-app-nested.jsonl"), "thread-app-nested", "/old/root/app/packages/lib");
  writeSession(path.join(sessionDir, "rollout-other.jsonl"), "thread-other", "/old/root/other");

  const result = runMigration(
    { mode: "projects", originalDir: "/old/root", targetDir: "/new/root" },
    {
      write: false,
      codexHome,
      includeArchived: true,
      includeJsonl: true,
      includeSqlite: false,
      json: true,
    },
  );

  assert.equal(result.jsonl.changedFiles, 3);
  assert.deepEqual(
    result.jsonl.samples.map((sample) => [sample.fromCwd, sample.toCwd]).sort(),
    [
      ["/old/root/app", "/new/root/app"],
      ["/old/root/other", "/new/root/other"],
    ],
  );
});

test("project migration updates config project sections and creates a backup", () => {
  const codexHome = makeTempCodexHome();
  const config = [
    'model = "gpt-5"',
    "",
    '[projects."/old/root/app"]',
    'trust_level = "trusted"',
    "",
    '[projects."/old/root/other"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), config);

  const dryRun = runMigration(
    { mode: "projects", originalDir: "/old/root", targetDir: "/new/root" },
    {
      write: false,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: false,
      json: true,
    },
  );

  assert.equal(dryRun.config.changedSections, 2);
  assert.deepEqual(
    dryRun.config.samples.map((sample) => [sample.fromCwd, sample.toCwd]),
    [
      ["/old/root/app", "/new/root/app"],
      ["/old/root/other", "/new/root/other"],
    ],
  );
  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), config);

  const applied = runMigration(
    { mode: "projects", originalDir: "/old/root", targetDir: "/new/root" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: false,
      json: true,
    },
  );

  assert.equal(applied.config.changedSections, 2);
  assert.match(
    fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"),
    /\[projects\."\/new\/root\/app"\]/,
  );
  assert.equal(fs.readFileSync(path.join(applied.backupDir, "config.toml"), "utf8"), config);
});

test("project migration deduplicates config sections when target already exists", () => {
  const codexHome = makeTempCodexHome();
  const config = [
    'model = "gpt-5"',
    "",
    '[projects."/old/root/app"]',
    'trust_level = "untrusted"',
    "",
    '[projects."/new/root/app"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), config);

  const result = runMigration(
    { mode: "projects", originalDir: "/old/root", targetDir: "/new/root" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: false,
      json: true,
    },
  );

  const updated = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.equal(result.config.changedSections, 1);
  assert.equal(updated.match(/\[projects\."\/new\/root\/app"\]/g)?.length, 1);
  assert.doesNotMatch(updated, /\[projects\."\/old\/root\/app"\]/);
  assert.match(updated, /trust_level = "trusted"/);
  assert.doesNotMatch(updated, /trust_level = "untrusted"/);
});

test("write project migration updates global JSON state files", () => {
  const codexHome = makeTempCodexHome();
  const globalStateFile = path.join(codexHome, ".codex-global-state.json");
  const processFile = path.join(codexHome, "process_manager", "chat_processes.json");
  const ambientFile = path.join(
    codexHome,
    "ambient-suggestions",
    "thread-1",
    "ambient-suggestions.json",
  );
  const cacheStateFile = path.join(codexHome, "cache", "codex_app_directory", "state.json");
  fs.mkdirSync(path.dirname(processFile), { recursive: true });
  fs.mkdirSync(path.dirname(ambientFile), { recursive: true });
  fs.mkdirSync(path.dirname(cacheStateFile), { recursive: true });

  const globalState = {
    "electron-saved-workspace-roots": ["/old/app", "/old/app/packages/lib", "/other/app"],
    "electron-persisted-atom-state": {
      "sidebar-collapsed-groups": {
        "/old/app": true,
        "/other/app": false,
      },
      "ambient-suggestions:default-statuses": {
        "ambient-suggestions:default-statuses:local:/old/app": "visible",
      },
    },
  };
  const processState = [{ cwd: "/old/app/packages/lib" }, { cwd: "/other/app" }];
  const ambientState = {
    cwd: "/old/app",
    note: "embedded /old/app text is not a standalone path",
  };
  const cacheState = {
    recentProjectPath: "/old/app/packages/lib",
  };

  fs.writeFileSync(globalStateFile, JSON.stringify(globalState, null, 2));
  fs.writeFileSync(processFile, JSON.stringify(processState, null, 2));
  fs.writeFileSync(ambientFile, JSON.stringify(ambientState, null, 2));
  fs.writeFileSync(cacheStateFile, JSON.stringify(cacheState, null, 2));

  const result = runMigration(
    { mode: "project", projectName: "app", fromDir: "/old/app", targetDir: "/new/app" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: false,
      json: true,
    },
  );

  assert.equal(result.state.changedFiles, 4);
  assert.equal(result.state.changedKeys, 2);
  assert.equal(result.state.changedValues, 5);

  const updatedGlobalState = JSON.parse(fs.readFileSync(globalStateFile, "utf8"));
  assert.deepEqual(updatedGlobalState["electron-saved-workspace-roots"], [
    "/new/app",
    "/new/app/packages/lib",
    "/other/app",
  ]);
  assert.equal(
    updatedGlobalState["electron-persisted-atom-state"]["sidebar-collapsed-groups"]["/new/app"],
    true,
  );
  assert.equal(
    updatedGlobalState["electron-persisted-atom-state"]["ambient-suggestions:default-statuses"][
      "ambient-suggestions:default-statuses:local:/new/app"
    ],
    "visible",
  );

  const updatedProcessState = JSON.parse(fs.readFileSync(processFile, "utf8"));
  assert.equal(updatedProcessState[0].cwd, "/new/app/packages/lib");
  assert.equal(updatedProcessState[1].cwd, "/other/app");

  const updatedAmbientState = JSON.parse(fs.readFileSync(ambientFile, "utf8"));
  assert.equal(updatedAmbientState.cwd, "/new/app");
  assert.equal(updatedAmbientState.note, "embedded /old/app text is not a standalone path");

  const updatedCacheState = JSON.parse(fs.readFileSync(cacheStateFile, "utf8"));
  assert.equal(updatedCacheState.recentProjectPath, "/new/app/packages/lib");

  assert.equal(
    fs.readFileSync(path.join(result.backupDir, ".codex-global-state.json"), "utf8"),
    JSON.stringify(globalState, null, 2),
  );
  assert.ok(
    fs.existsSync(path.join(result.backupDir, "process_manager", "chat_processes.json")),
  );
  assert.ok(
    fs.existsSync(
      path.join(result.backupDir, "ambient-suggestions", "thread-1", "ambient-suggestions.json"),
    ),
  );
  assert.ok(
    fs.existsSync(path.join(result.backupDir, "cache", "codex_app_directory", "state.json")),
  );
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

test("write project migration preserves nested sqlite cwd with fromDir", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const rollout = path.join(codexHome, "sessions", "2026", "06", "28", "rollout-test.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, "");

  const database = path.join(codexHome, "state_5.sqlite");
  execFileSync("sqlite3", [
    database,
    [
      "create table threads (id text primary key, rollout_path text not null, cwd text not null, model_provider text not null, agent_path text);",
      `insert into threads values ('thread-1', '${rollout}', '/old/app/packages/lib', 'openai', '/old/app/.codex/agents/reviewer.md');`,
    ].join("\n"),
  ]);

  const result = runMigration(
    {
      mode: "project",
      projectName: "app",
      fromDir: "/old/app",
      targetDir: "/new/app",
    },
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
  assert.equal(result.sqlite[0].missingRolloutPaths, 0);
  assert.deepEqual(result.sqlite[0].projectChanges, [
    { fromCwd: "/old/app", toCwd: "/new/app", rows: 1 },
  ]);
  assert.equal(result.projects.find((project) => project.fromCwd === "/old/app")?.sqliteRows, 1);

  const row = execFileSync("sqlite3", [
    database,
    "select cwd || char(10) || agent_path from threads where id = 'thread-1';",
  ])
    .toString("utf8")
    .trim();
  assert.deepEqual(row.split("\n"), [
    "/new/app/packages/lib",
    "/new/app/.codex/agents/reviewer.md",
  ]);
});

test("write project migration bumps desktop catalog revision", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const sqliteDir = path.join(codexHome, "sqlite");
  fs.mkdirSync(sqliteDir, { recursive: true });

  const database = path.join(sqliteDir, "codex-dev.db");
  execFileSync("sqlite3", [
    database,
    [
      `create table local_thread_catalog (
        host_id text not null,
        thread_id text not null,
        display_title text not null,
        source_created_at real not null,
        source_updated_at real not null,
        cwd text not null,
        source_kind text not null,
        source_detail text,
        model_provider text not null,
        git_branch text,
        observation_sequence integer not null,
        missing_candidate integer not null default 0 check (missing_candidate in (0, 1)),
        primary key (host_id, thread_id)
      );`,
      "create table local_thread_catalog_metadata (id integer primary key check (id = 1), catalog_revision integer not null default 0);",
      "insert into local_thread_catalog values ('local', 'thread-1', 'Thread', 1, 2, '/old/app', 'local', null, 'openai', null, 4, 0);",
      "insert into local_thread_catalog_metadata values (1, 7);",
    ].join("\n"),
  ]);

  const result = runMigration(
    { mode: "project", projectName: "app", fromDir: "/old/app", targetDir: "/new/app" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: true,
      json: true,
    },
  );

  assert.equal(
    result.sqlite.find((db) => db.table === "local_thread_catalog" && !db.skipped)?.changedRows,
    1,
  );

  const row = execFileSync("sqlite3", [
    database,
    "select cwd || char(10) || observation_sequence || char(10) || catalog_revision from local_thread_catalog, local_thread_catalog_metadata where host_id = 'local' and thread_id = 'thread-1';",
  ])
    .toString("utf8")
    .trim();
  assert.deepEqual(row.split("\n"), ["/new/app", "4", "8"]);
});

test("write project migration updates global sqlite path state", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const stateDb = path.join(codexHome, "state_5.sqlite");
  execFileSync("sqlite3", [
    stateDb,
    [
      "create table agent_jobs (id text primary key, input_csv_path text not null, output_csv_path text not null);",
      "insert into agent_jobs values ('job-1', '/old/app/input.csv', '/old/app/out/output.csv');",
    ].join("\n"),
  ]);

  const sqliteDir = path.join(codexHome, "sqlite");
  fs.mkdirSync(sqliteDir, { recursive: true });
  const desktopDb = path.join(sqliteDir, "codex-dev.db");
  execFileSync("sqlite3", [
    desktopDb,
    [
      "create table automations (id text primary key, cwds text not null);",
      "create table automation_runs (thread_id text primary key, source_cwd text);",
      "insert into automations values ('automation-1', '[\"/old/app\",\"/other/app\"]');",
      "insert into automation_runs values ('thread-1', '/old/app/packages/lib');",
    ].join("\n"),
  ]);

  const result = runMigration(
    { mode: "project", projectName: "app", fromDir: "/old/app", targetDir: "/new/app" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: true,
      json: true,
    },
  );

  assert.equal(result.sqlite.find((db) => db.table === "agent_jobs" && !db.skipped)?.changedRows, 1);
  assert.equal(result.sqlite.find((db) => db.table === "automations" && !db.skipped)?.changedRows, 1);
  assert.equal(
    result.sqlite.find((db) => db.table === "automation_runs" && !db.skipped)?.changedRows,
    1,
  );

  const agentJob = execFileSync("sqlite3", [
    stateDb,
    "select input_csv_path || char(10) || output_csv_path from agent_jobs where id = 'job-1';",
  ])
    .toString("utf8")
    .trim();
  assert.deepEqual(agentJob.split("\n"), [
    "/new/app/input.csv",
    "/new/app/out/output.csv",
  ]);

  const automation = execFileSync("sqlite3", [
    desktopDb,
    "select cwds from automations where id = 'automation-1';",
  ])
    .toString("utf8")
    .trim();
  assert.deepEqual(JSON.parse(automation), ["/new/app", "/other/app"]);

  const sourceCwd = execFileSync("sqlite3", [
    desktopDb,
    "select source_cwd from automation_runs where thread_id = 'thread-1';",
  ])
    .toString("utf8")
    .trim();
  assert.equal(sourceCwd, "/new/app/packages/lib");

  const backupAgentJob = execFileSync("sqlite3", [
    path.join(result.backupDir, "state_5.sqlite"),
    "select input_csv_path from agent_jobs where id = 'job-1';",
  ])
    .toString("utf8")
    .trim();
  assert.equal(backupAgentJob, "/old/app/input.csv");
});

test("write project migration updates root and nested desktop sqlite catalogs", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const rootDesktopDb = path.join(codexHome, "codex-dev.db");
  const nestedSqliteDir = path.join(codexHome, "sqlite");
  fs.mkdirSync(nestedSqliteDir, { recursive: true });
  const nestedDesktopDb = path.join(nestedSqliteDir, "codex-dev.db");

  writeDesktopCatalog(rootDesktopDb, "root-thread", "/old/app", 3);
  writeDesktopCatalog(nestedDesktopDb, "nested-thread", "/old/app/packages/lib", 9);

  const result = runMigration(
    { mode: "project", projectName: "app", fromDir: "/old/app", targetDir: "/new/app" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: true,
      json: true,
    },
  );

  const changedCatalogs = result.sqlite
    .filter((db) => db.table === "local_thread_catalog" && db.changedRows === 1)
    .map((db) => path.relative(codexHome, db.database))
    .sort();
  assert.deepEqual(changedCatalogs, ["codex-dev.db", path.join("sqlite", "codex-dev.db")]);

  assert.deepEqual(readDesktopCatalog(rootDesktopDb, "root-thread"), ["/new/app", "4"]);
  assert.deepEqual(readDesktopCatalog(nestedDesktopDb, "nested-thread"), [
    "/new/app/packages/lib",
    "10",
  ]);

  assert.ok(fs.existsSync(path.join(result.backupDir, "codex-dev.db")));
  assert.ok(fs.existsSync(path.join(result.backupDir, "sqlite", "codex-dev.db")));
});

test("write project migration backfills missing desktop catalog rows from state databases", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const rootStateDb = path.join(codexHome, "state_5.sqlite");
  const nestedSqliteDir = path.join(codexHome, "sqlite");
  fs.mkdirSync(nestedSqliteDir, { recursive: true });
  const nestedStateDb = path.join(nestedSqliteDir, "state_5.sqlite");
  const desktopDb = path.join(nestedSqliteDir, "codex-dev.db");
  const rootRollout = path.join(codexHome, "sessions", "2026", "06", "28", "root.jsonl");
  const nestedRollout = path.join(codexHome, "sessions", "2026", "06", "28", "nested.jsonl");
  fs.mkdirSync(path.dirname(rootRollout), { recursive: true });
  fs.writeFileSync(rootRollout, "");
  fs.writeFileSync(nestedRollout, "");

  writeStateThreads(rootStateDb, [
    {
      id: "thread-root",
      rolloutPath: rootRollout,
      cwd: "/old/root/QuaEngine",
      updatedAt: 10,
    },
  ]);
  writeStateThreads(nestedStateDb, [
    {
      id: "thread-nested",
      rolloutPath: nestedRollout,
      cwd: "/old/root/QuaEngine/ai/novel-writer",
      updatedAt: 20,
    },
  ]);
  writeEmptyDesktopCatalog(desktopDb);

  const result = runMigration(
    { mode: "project", projectName: "quaengine", targetDir: "/new/root/QuaEngine" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: true,
      json: true,
    },
  );

  const desktopResult = result.sqlite.find(
    (db) => db.table === "local_thread_catalog" && db.database === desktopDb,
  );
  assert.equal(desktopResult?.changedRows, 2);
  assert.equal(desktopResult?.insertedRows, 2);
  assert.deepEqual(desktopResult?.projectChanges, [
    { fromCwd: "/old/root/QuaEngine", toCwd: "/new/root/QuaEngine", rows: 2 },
  ]);
  assert.equal(
    result.projects.find((project) => project.fromCwd === "/old/root/QuaEngine")?.sqliteRows,
    4,
  );

  assert.deepEqual(readDesktopCatalog(desktopDb, "thread-root"), [
    "/new/root/QuaEngine",
    "1",
  ]);
  assert.deepEqual(readDesktopCatalog(desktopDb, "thread-nested"), [
    "/new/root/QuaEngine/ai/novel-writer",
    "1",
  ]);

  const syncState = execFileSync("sqlite3", [
    desktopDb,
    "select initial_build_complete || char(10) || observation_sequence from local_thread_catalog_sync_state where host_id = 'local';",
  ])
    .toString("utf8")
    .trim();
  assert.deepEqual(syncState.split("\n"), ["1", "2"]);
  assert.ok(fs.existsSync(path.join(result.backupDir, "sqlite", "codex-dev.db")));
});

test("project migration uses JSONL project hints for worktree sqlite rows", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "28");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rollout = path.join(sessionDir, "worktree.jsonl");
  fs.writeFileSync(
    rollout,
    [
      JSON.stringify({
        timestamp: "now",
        type: "session_meta",
        payload: {
          id: "thread-worktree",
          cwd: "/tmp/.codex/worktrees/1234/skillscat",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        timestamp: "now",
        type: "turn_context",
        payload: {
          cwd: "/old/root/skillscat/packages/lib",
          workspace_roots: ["/old/root/skillscat"],
        },
      }),
      "",
    ].join("\n"),
  );

  const stateDb = path.join(codexHome, "state_5.sqlite");
  const sqliteDir = path.join(codexHome, "sqlite");
  fs.mkdirSync(sqliteDir, { recursive: true });
  const desktopDb = path.join(sqliteDir, "codex-dev.db");
  writeStateThreads(stateDb, [
    {
      id: "thread-worktree",
      rolloutPath: rollout,
      cwd: "/tmp/.codex/worktrees/1234/skillscat",
      updatedAt: 10,
    },
  ]);
  writeEmptyDesktopCatalog(desktopDb);

  const result = runMigration(
    { mode: "projects", originalDir: "/old/root", targetDir: "/new/root" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: true,
      includeSqlite: true,
      json: true,
    },
  );

  assert.equal(result.jsonl.changedFiles, 1);
  assert.deepEqual(readDesktopCatalog(desktopDb, "thread-worktree"), [
    "/new/root/skillscat",
    "1",
  ]);
});

test("write project migration handles large sqlite write scripts without argv limits", (t) => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("sqlite3 is not available");
    return;
  }

  const codexHome = makeTempCodexHome();
  const sqliteDir = path.join(codexHome, "sqlite");
  fs.mkdirSync(sqliteDir, { recursive: true });
  const desktopDb = path.join(sqliteDir, "codex-dev.db");
  writeEmptyDesktopCatalog(desktopDb);

  const rows = Array.from({ length: 1800 }, (_, index) => {
    const padded = String(index).padStart(4, "0");
    return [
      "insert into local_thread_catalog values",
      `('local', 'thread-${padded}', 'Thread ${padded}', 1, 2,`,
      `'${"/old/app/packages/feature-" + padded + "/".repeat(32)}',`,
      "'local', null, 'openai', null,",
      `${index + 1}, 0);`,
    ].join(" ");
  });
  execSqlForTest(desktopDb, rows.join("\n"));

  const result = runMigration(
    { mode: "project", projectName: "app", fromDir: "/old/app", targetDir: "/new/app" },
    {
      write: true,
      codexHome,
      includeArchived: false,
      includeJsonl: false,
      includeSqlite: true,
      json: true,
    },
  );

  const desktopResult = result.sqlite.find(
    (db) => db.table === "local_thread_catalog" && db.database === desktopDb,
  );
  assert.equal(desktopResult?.changedRows, 1800);

  const migratedRows = execFileSync("sqlite3", [
    desktopDb,
    "select count(*) from local_thread_catalog where cwd like '/new/app/%';",
  ])
    .toString("utf8")
    .trim();
  assert.equal(migratedRows, "1800");
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

function writeSession(file, id, cwd) {
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "now",
        type: "session_meta",
        payload: { id, cwd, model_provider: "openai" },
      }),
      "",
    ].join("\n"),
  );
}

function writeDesktopCatalog(database, threadId, cwd, revision) {
  execFileSync("sqlite3", [
    database,
    [
      `create table local_thread_catalog (
        host_id text not null,
        thread_id text not null,
        display_title text not null,
        source_created_at real not null,
        source_updated_at real not null,
        cwd text not null,
        source_kind text not null,
        source_detail text,
        model_provider text not null,
        git_branch text,
        observation_sequence integer not null,
        missing_candidate integer not null default 0 check (missing_candidate in (0, 1)),
        primary key (host_id, thread_id)
      );`,
      "create table local_thread_catalog_metadata (id integer primary key check (id = 1), catalog_revision integer not null default 0);",
      `insert into local_thread_catalog values ('local', '${threadId}', 'Thread', 1, 2, '${cwd}', 'local', null, 'openai', null, 4, 0);`,
      `insert into local_thread_catalog_metadata values (1, ${revision});`,
    ].join("\n"),
  ]);
}

function writeEmptyDesktopCatalog(database) {
  execFileSync("sqlite3", [
    database,
    [
      `create table local_thread_catalog (
        host_id text not null,
        thread_id text not null,
        display_title text not null,
        source_created_at real not null,
        source_updated_at real not null,
        cwd text not null,
        source_kind text not null,
        source_detail text,
        model_provider text not null,
        git_branch text,
        observation_sequence integer not null,
        missing_candidate integer not null default 0 check (missing_candidate in (0, 1)),
        primary key (host_id, thread_id)
      );`,
      "create table local_thread_catalog_hosts (host_id text primary key, host_kind text not null);",
      "create table local_thread_catalog_sync_state (host_id text primary key, watermark_updated_at real, initial_build_complete integer not null default 0, observation_sequence integer not null default 0);",
      "create table local_thread_catalog_metadata (id integer primary key check (id = 1), catalog_revision integer not null default 0);",
      "insert into local_thread_catalog_hosts values ('local', 'local');",
      "insert into local_thread_catalog_sync_state values ('local', null, 0, 0);",
      "insert into local_thread_catalog_metadata values (1, 0);",
    ].join("\n"),
  ]);
}

function writeStateThreads(database, rows) {
  const inserts = rows.map(
    (row) =>
      `insert into threads values ('${row.id}', '${row.rolloutPath}', 1, ${row.updatedAt}, 'vscode', 'openai', '${row.cwd}', 'Thread', 'Preview', 1000, ${row.updatedAt * 1000}, 'main');`,
  );
  execFileSync("sqlite3", [
    database,
    [
      `create table threads (
        id text primary key,
        rollout_path text not null,
        created_at integer not null,
        updated_at integer not null,
        source text not null,
        model_provider text not null,
        cwd text not null,
        title text not null,
        preview text not null,
        created_at_ms integer,
        updated_at_ms integer,
        git_branch text
      );`,
      ...inserts,
    ].join("\n"),
  ]);
}

function readDesktopCatalog(database, threadId) {
  return execFileSync("sqlite3", [
    database,
    `select cwd || char(10) || catalog_revision from local_thread_catalog, local_thread_catalog_metadata where host_id = 'local' and thread_id = '${threadId}';`,
  ])
    .toString("utf8")
    .trim()
    .split("\n");
}

function execSqlForTest(database, sql) {
  execFileSync("sqlite3", [database], {
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
