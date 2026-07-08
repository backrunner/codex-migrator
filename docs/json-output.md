# JSON Output

`codex-migrate` supports `--json` for scripts and automation that need stable,
machine-readable output. The README intentionally documents the normal
interactive TUI workflow; use this page when you are integrating the CLI into
another tool.

## Inspect

```bash
codex-migrate --json doctor
codex-migrate --json list providers
codex-migrate --json list projects --limit 50
codex-migrate --json backups list
```

## Preview Or Apply Migrations

```bash
codex-migrate --json provider packycode --from openai
codex-migrate --json project serlink /Users/me/Work/serlink
codex-migrate --json projects /Users/me/Projects /Users/me/Work
codex-migrate --json --max-backups 20 project serlink /Users/me/Work/serlink
```

Windows example:

```powershell
codex-migrate --json project app "D:\Work\app" --from-dir "C:\Users\me\Projects\app"
```

When a migration has changes, `--json` uses the same confirmation prompt as the
interactive TUI. The prompt is printed on stderr. Stdout emits one final JSON
object with `confirmed: true` or `confirmed: false`.

## Restore

```bash
codex-migrate --json backups list
codex-migrate --json restore latest
codex-migrate --json restore codex-migrate-2026-06-28T12-00-00-000Z
codex-migrate --json restore /Users/me/.codex/backups/codex-migrate-example
```

## Migration Result

Successful migration commands emit:

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
    "changedValues": 0,
    "projectChanges": [],
    "providerChanges": [],
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

If a confirmed migration writes changes, the final JSON has `dryRun: false`,
`confirmed: true`, and a `preview` object with the original dry-run result. If
the prompt is declined, the final JSON has `dryRun: true` and
`confirmed: false`.

Confirmed writes also include backup retention details:

```json
{
  "backupDir": "/Users/me/.codex/backups/codex-migrate-2026-06-28T12-00-00-000Z",
  "backupRetention": {
    "maxBackups": 10,
    "prunedBackups": []
  }
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

The CLI does not print conversation message content. Samples include only
thread IDs, file paths, providers, and project directories. Project migration
samples are grouped to one sample per project. Provider migrations may also
report `config.providerChanges` when matching provider references or
`model_providers` sections are found in `config.toml`.

## Options

Global options:

- `--json`: emit machine-readable JSON.
- `--codex-home <dir>`: use a Codex home other than `$CODEX_HOME` or
  `~/.codex`.
- `--no-archived`: skip `archived_sessions`.

Migration options:

- `--no-jsonl`: skip rollout JSONL files.
- `--no-sqlite`: skip SQLite catalogs.
- `--from <provider>`: provider command filter.
- `--from-dir <dir>`: project command exact source directory.
