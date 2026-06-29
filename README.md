# codex-migrator

`codex-migrate` is a Node.js + TypeScript CLI for migrating local Codex
conversation history.

It supports two common moves:

- Change conversation history from one model provider name to another.
- Move conversation history from old project directories to new project
  directories.

The tool updates Codex rollout JSONL files and SQLite thread catalogs. Migration
commands preview changes first. Nothing is written unless the confirmation
prompt is answered with `y`; pressing Enter keeps the dry-run result.

Human output uses a lightweight colored TUI with status labels, progress bars,
tables, samples, and next-step hints. Preview and confirmed writes show progress
while scanning Codex history, JSONL rollout files, `config.toml`, JSON state
files, and SQLite catalogs. In an interactive terminal the progress bar updates
in place; non-TTY output is kept compact. Use `--json` for stable
machine-readable output; prompts and progress go to stderr and stdout remains a
single JSON object. Set `NO_COLOR=1` to disable colors or `FORCE_COLOR=1` to
force ANSI colors in non-TTY output.

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
- `~/.codex/config.toml`
- Active JSON state files under `~/.codex`, including
  `~/.codex/.codex-global-state.json`,
  `~/.codex/process_manager/chat_processes.json`, and
  `~/.codex/ambient-suggestions/**/*.json`
- `~/.codex/state_5.sqlite`
- `~/.codex/codex-dev.db`
- `~/.codex/sqlite/state_5.sqlite`
- `~/.codex/sqlite/codex-dev.db`

For project moves, JSONL `cwd` and `workspace_roots` values are rewritten. For
Codex config, `[projects."..."]` section paths are rewritten so Desktop project
lists and trusted-project settings move with the conversation history. For
existing target directories, the target path is canonicalized against the local
filesystem before writing, which preserves real directory casing such as
`/Volumes/BRData/projects/QuaEngine` even when the command is entered with a
different case. For project catalog rows, SQLite `cwd` and thread `agent_path` values are rewritten
when they are under the migrated project tree, while existing `rollout_path`
links are checked so broken thread-to-JSONL references are visible in `doctor`
and migration previews. Desktop `local_thread_catalog` rows are updated and
`local_thread_catalog_metadata.catalog_revision` is incremented so Codex Desktop
can refresh its project catalog. If the Desktop catalog is missing local rows,
matching rows are backfilled from both root and nested `state_5.sqlite`
databases without reading conversation bodies. Codex JSON global state is
migrated with structured `JSON.parse` traversal, including project paths stored
as object keys inside `.codex-global-state.json`, saved workspace roots,
process-manager cwd entries, and ambient-suggestion project state. Codex SQLite
global state with project-bound paths is also migrated:
`agent_jobs.input_csv_path`, `agent_jobs.output_csv_path`, `automations.cwds`,
and `automation_runs.source_cwd`. For provider moves, `model_provider` is
rewritten.

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

Preview or apply the migration with JSON output:

```bash
codex-migrate --json provider packycode --from openai
codex-migrate --json project serlink /Users/me/Work/serlink
codex-migrate --json projects /Users/me/Projects /Users/me/Work
```

Windows example:

```powershell
codex-migrate --json project app "D:\Work\app" --from-dir "C:\Users\me\Projects\app"
```

Apply only from the human TUI after the preview looks right:

```bash
codex-migrate provider packycode --from openai
codex-migrate project serlink /Users/me/Work/serlink
codex-migrate projects /Users/me/Projects /Users/me/Work
```

Each command prints a preview, then asks `Apply these migration changes? [y/N]`.
Only `y` or `yes` applies the write and creates a backup.
The same confirmation is used with `--json`; the prompt is printed on stderr and
stdout emits one final JSON object with `confirmed: true` or `confirmed: false`.

Restore if needed:

```bash
codex-migrate --json backups list
codex-migrate --json restore latest
codex-migrate restore latest
```

## Commands

### `doctor`

Checks the Codex home, session file counts, top-level history indexes, JSON
global-state path counts, SQLite availability, provider counts, and top project
directories.

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
```

### `project <name> <targetDir>`

Migrates one project. `name` matches a project directory name in the stored
`cwd` path, case-insensitively, such as `serlink` for either
`/Users/me/Projects/serlink` or a nested cwd like
`/Users/me/Projects/serlink/packages/api`.

```bash
codex-migrate project serlink /Users/me/Work/serlink
```

Use `--from-dir` if multiple projects share the same basename or you want to
anchor matching to one source project tree. Conversations whose stored `cwd` is
equal to or under that directory are migrated, and relative subpaths are
preserved:

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

Apply the restore only after reviewing the preview and answering `y`:

```bash
codex-migrate restore latest
```

When restoring SQLite database files, stale destination `-wal` and `-shm`
sidecar files are removed before the database file is copied back.

## Options

Global options:

- `--codex-home <dir>`: use a Codex home other than `$CODEX_HOME` or `~/.codex`.
- `--json`: emit machine-readable JSON.
- `--no-archived`: skip `archived_sessions`.

Migration options:

- `--no-jsonl`: skip rollout JSONL files.
- `--no-sqlite`: skip SQLite catalogs.
- `--from <provider>`: provider command filter.
- `--from-dir <dir>`: project command exact source directory.

## Backups

Every confirmed migration creates a timestamped backup directory before the
first mutation:

```text
~/.codex/backups/codex-migrate-<timestamp>
```

JSONL backups preserve their path relative to the Codex home. SQLite backups are
created with SQLite `vacuum into` so committed WAL changes are included.
Restore commands copy files back from one of these backup directories after you
review the preview and answer `y`.

If `--codex-home` points to a missing directory, confirmed write mode returns an
error result and does not create that directory.

Before a confirmed migration that includes SQLite, the CLI preflights the
SQLite catalogs. If a database is locked or unreadable, the command stops before
any JSONL files are changed. Use `--no-sqlite` only when you intentionally want
to skip SQLite catalog updates.

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
  "config": {
    "scannedFiles": 1,
    "matchedSections": 0,
    "changedSections": 0,
    "samples": [],
    "skipped": false
  },
  "state": {
    "scannedFiles": 0,
    "matchedFiles": 0,
    "changedFiles": 0,
    "changedKeys": 0,
    "changedValues": 0,
    "samples": []
  },
  "sqlite": [],
  "warnings": [],
  "confirmed": false
}
```

When a migration has changes, `--json` prompts before writing. If confirmed, the
final JSON has `dryRun: false`, `confirmed: true`, and a `preview` object with
the dry-run result. If declined, it has `dryRun: true` and `confirmed: false`.

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
IDs, file paths, providers, and project directories. Project migration samples
are grouped to one sample per project.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

The test suite covers provider rewrites, project path rewrites, JSONL writes
with backups, JSON global-state writes with backups, SQLite writes with backups,
Desktop catalog backfills, interactive confirmation defaults, and missing Codex
home write safety. It also covers backup listing/restoration and POSIX/Win32
path rewrite fixtures.

## License

MIT
