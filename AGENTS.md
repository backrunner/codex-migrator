# Development Norms

This repository builds `codex-migrate`, a Node.js CLI written in TypeScript with
Commander.js.

## Commands

- Prefix shell commands with `rtk` in Codex sessions.
- Use `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Smoke-test the built binary with `codex-migrate --help` and
  `codex-migrate --json doctor`.

## Migration Safety

- Migration commands must default to dry-run behavior.
- Destructive writes require an explicit `--write` flag.
- Any write to Codex JSONL or SQLite state must create a timestamped backup under
  `~/.codex/backups/`.
- Do not print or snapshot conversation message content in logs, tests, or docs.
- Keep JSONL parsing structured with `JSON.parse`; do not use regex replacement
  for provider or cwd mutations.

## Data Surfaces

- JSONL history lives under `sessions/` and `archived_sessions/`.
- Active thread catalog data can live in `state_5.sqlite`.
- Desktop catalog data can live in `sqlite/codex-dev.db`.
- Project migrations must update both `cwd` and `workspace_roots` where present.
- History path logic must keep both POSIX and Win32 path fixtures passing.

## Code Style

- Keep CLI command names short and scriptable.
- Support `--json` for outputs that future Codex threads may parse.
- Prefer small pure helpers for path matching and migration planning, then keep
  file and SQLite writes at the edges.
