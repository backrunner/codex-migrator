# codex-migrator

`codex-migrate` is a Node.js + TypeScript CLI for migrating local Codex
conversation history.

It supports two common moves:

- Change conversation history from one model provider name to another.
- Move conversation history from old project directories to new project
  directories.

The tool updates Codex rollout JSONL files and SQLite thread catalogs. Migration
commands are dry-runs by default. Nothing is written unless `--write` is passed.

Human output uses a lightweight colored TUI with status labels, tables, samples,
and next-step hints. Use `--json` for stable machine-readable output. Set
`NO_COLOR=1` to disable colors or `FORCE_COLOR=1` to force ANSI colors in
non-TTY output.

## Platform Support

Supported runtime targets:

- macOS: supported and smoke-tested locally.
- Linux: supported when Node.js 20+ is available. SQLite catalog migration
  requires `sqlite3` on PATH; JSONL migration works without it.
- Windows: supported through npm's generated command shim. Win32 paths such as
  `C:\Users\me\Projects\app` are detected and rewritten with Windows separators.
  SQLite catalog migration requires `sqlite3.exe` on PATH; otherwise SQLite
  migration is skipped with a warning.

## Data Updated

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`
- `~/.codex/state_5.sqlite`
- `~/.codex/sqlite/state_5.sqlite`
- `~/.codex/sqlite/codex-dev.db`

For project moves, JSONL `cwd` and `workspace_roots` values are rewritten. For
provider moves, `model_provider` is rewritten.

## Install

```bash
pnpm install
pnpm build
```

Install the command on PATH:

```bash
npm link
```

`pnpm link --global` also works when your pnpm global bin directory is already
on PATH.

Verify:

```bash
command -v codex-migrate
codex-migrate --help
codex-migrate --json doctor
```

PowerShell equivalent:

```powershell
Get-Command codex-migrate
codex-migrate --help
codex-migrate --json doctor
```

## Basic Workflow

Inspect first:

```bash
codex-migrate --json doctor
codex-migrate --json list providers
codex-migrate --json list projects --limit 50
codex-migrate --json backups list
```

Dry-run the migration:

```bash
codex-migrate --json provider packycode --from openai
codex-migrate --json project serlink /Users/me/Work/serlink
codex-migrate --json projects /Users/me/Projects /Users/me/Work
```

Windows example:

```powershell
codex-migrate --json project app "D:\Work\app" --from-dir "C:\Users\me\Projects\app"
```

Apply only after the dry-run looks right:

```bash
codex-migrate --json provider packycode --from openai --write
codex-migrate --json project serlink /Users/me/Work/serlink --write
codex-migrate --json projects /Users/me/Projects /Users/me/Work --write
```

Restore if needed:

```bash
codex-migrate --json backups list
codex-migrate --json restore latest
codex-migrate --json restore latest --write
```

## Commands

### `doctor`

Checks the Codex home, session file counts, SQLite availability, provider counts,
and top project directories.

```bash
codex-migrate doctor
codex-migrate --json doctor
```

### `list providers`

Lists provider counts from the SQLite thread catalogs.

```bash
codex-migrate list providers
codex-migrate --json list providers
```

### `list projects`

Lists project directory counts from the SQLite thread catalogs.

```bash
codex-migrate list projects --limit 20
codex-migrate --json list projects --limit 20
```

### `provider <targetProvider>`

Migrates conversations to a provider name. Use `--from` when renaming one old
provider instead of forcing every non-target provider to the target.

```bash
codex-migrate provider packycode --from openai
codex-migrate provider packycode --from openai --write
```

### `project <name> <targetDir>`

Migrates one project. `name` matches the basename of the stored `cwd`, such as
`serlink` for `/Users/me/Projects/serlink`.

```bash
codex-migrate project serlink /Users/me/Work/serlink
codex-migrate project serlink /Users/me/Work/serlink --write
```

Use `--from-dir` if multiple projects share the same basename or you want exact
source matching:

```bash
codex-migrate project serlink /Users/me/Work/serlink --from-dir /Users/me/Projects/serlink
```

### `projects <originalDir> <targetDir>`

Migrates every conversation whose stored `cwd` is equal to or under
`originalDir`. Relative project paths are preserved.

```bash
codex-migrate projects /Users/me/Projects /Users/me/Work
```

Example rewrite:

```text
/Users/me/Projects/app      -> /Users/me/Work/app
/Users/me/Projects/a/tool   -> /Users/me/Work/a/tool
```

### `backups list`

Lists timestamped migration backups under `~/.codex/backups`.

```bash
codex-migrate backups list
codex-migrate --json backups list
```

### `restore <backup>`

Restores files from a backup directory. This is also a dry-run by default.
Use `latest`, a backup directory name, or an absolute backup path.

```bash
codex-migrate --json restore latest
codex-migrate --json restore codex-migrate-2026-06-28T12-00-00-000Z
codex-migrate --json restore /Users/me/.codex/backups/codex-migrate-example
```

Apply the restore only after reviewing the dry-run output:

```bash
codex-migrate --json restore latest --write
```

When restoring SQLite database files, stale destination `-wal` and `-shm`
sidecar files are removed before the database file is copied back.

## Options

Global options:

- `--codex-home <dir>`: use a Codex home other than `$CODEX_HOME` or `~/.codex`.
- `--json`: emit machine-readable JSON.
- `--no-archived`: skip `archived_sessions`.

Migration options:

- `--write`: apply changes. Without this, commands are dry-runs.
- `--no-jsonl`: skip rollout JSONL files.
- `--no-sqlite`: skip SQLite catalogs.
- `--from <provider>`: provider command filter.
- `--from-dir <dir>`: project command exact source directory.

Restore options:

- `--write`: apply restore. Without this, restore is a dry-run.

## Backups

Every `--write` run creates a timestamped backup directory before the first
mutation:

```text
~/.codex/backups/codex-migrate-<timestamp>
```

JSONL backups preserve their path relative to the Codex home. SQLite backups are
created with SQLite `vacuum into` so committed WAL changes are included.

If `--codex-home` points to a missing directory, write mode returns an error
result and does not create that directory.

Before a write migration that includes SQLite, the CLI preflights the SQLite
catalogs. If a database is locked or unreadable, the command stops before any
JSONL files are changed. Use `--no-sqlite` only when you intentionally want to
skip SQLite catalog updates.

## JSON Output

With `--json`, successful migration commands emit:

```json
{
  "ok": true,
  "dryRun": true,
  "action": {},
  "codexHome": "/Users/me/.codex",
  "jsonl": {
    "scannedFiles": 0,
    "matchedFiles": 0,
    "changedFiles": 0,
    "changedLines": 0,
    "samples": []
  },
  "sqlite": [],
  "warnings": []
}
```

Errors emit:

```json
{
  "ok": false,
  "error": {
    "message": "what failed"
  }
}
```

The CLI does not print conversation message content. Samples include only thread
IDs, file paths, providers, and project directories.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

The test suite covers provider rewrites, project path rewrites, JSONL write
mode with backups, SQLite write mode with backups, and missing Codex home write
safety. It also covers backup listing/restoration and POSIX/Win32 path rewrite
fixtures.
