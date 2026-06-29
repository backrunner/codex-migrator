# codex-migrator

`codex-migrate` is a Node.js CLI for migrating local Codex conversation history
through an interactive terminal UI.

Use it when you want to:

- Move conversations from one model provider name to another.
- Move conversations from an old project directory to a new project directory.

Migration commands always preview the changes first. Nothing is written unless
you review the preview and answer the confirmation prompt with `y`; pressing
Enter leaves the dry-run unchanged. Every confirmed migration creates a
timestamped backup under `~/.codex/backups/`.

## Install

Install dependencies and build the CLI:

```bash
pnpm install
pnpm build
```

Install the command on your PATH:

```bash
npm link
```

`pnpm link --global` also works when your pnpm global bin directory is already
on PATH.

Verify the install:

```bash
command -v codex-migrate
codex-migrate --help
codex-migrate doctor
```

PowerShell equivalent:

```powershell
Get-Command codex-migrate
codex-migrate --help
codex-migrate doctor
```

## Normal Workflow

Start with a quick health check:

```bash
codex-migrate doctor
```

See the provider names Codex has stored locally:

```bash
codex-migrate list providers
```

See the project directories Codex has stored locally:

```bash
codex-migrate list projects --limit 50
```

Run the migration command you need. The CLI will show a TUI preview with the
files, state entries, and SQLite rows that would change, then ask:

```text
Apply these migration changes? [y/N]
```

Answer `y` or `yes` to apply the migration. Any other answer keeps the preview
as a dry run.

## Migrate Between Providers

To rename conversations from one provider to another, pass the target provider
and the current provider:

```bash
codex-migrate provider packycode --from openai
```

This updates conversations currently stored with `model_provider: openai` so
they use `packycode`.

If you omit `--from`, every conversation that is not already using the target
provider is included in the preview:

```bash
codex-migrate provider packycode
```

## Migrate One Project Directory

To move one project by its directory name:

```bash
codex-migrate project serlink /Users/me/Work/serlink
```

The project name is matched against stored conversation `cwd` paths,
case-insensitively. Nested paths are preserved, so a conversation stored under
`/Users/me/Projects/serlink/packages/api` moves under
`/Users/me/Work/serlink/packages/api`.

When multiple projects share the same directory name, anchor the migration to
the exact source tree:

```bash
codex-migrate project serlink /Users/me/Work/serlink --from-dir /Users/me/Projects/serlink
```

Windows example:

```powershell
codex-migrate project app "D:\Work\app" --from-dir "C:\Users\me\Projects\app"
```

## Migrate A Directory Tree

To move every conversation under one parent directory to another parent
directory:

```bash
codex-migrate projects /Users/me/Projects /Users/me/Work
```

Example rewrite:

```text
/Users/me/Projects/app      -> /Users/me/Work/app
/Users/me/Projects/a/tool   -> /Users/me/Work/a/tool
```

## Restore From A Backup

List migration backups:

```bash
codex-migrate backups list
```

Preview a restore from the latest backup:

```bash
codex-migrate restore latest
```

The restore command is also a dry run by default. Review the preview and answer
`y` only when you want to copy the backup files back into place.

## What Gets Updated

`codex-migrate` can update Codex session JSONL files, `config.toml`, active JSON
state files, and SQLite thread catalogs under your Codex home. Project
migrations update both `cwd` and `workspace_roots` where present. Provider
migrations update stored `model_provider` values.

The CLI never prints conversation message content in previews.

## License

MIT
