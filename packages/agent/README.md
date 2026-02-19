# @femtomc/mu-agent

Shared agent runtime package for mu.

This package provides reusable runtime pieces for chat, orchestration, and serve-mode tooling, including:

- Messaging operator runtime + backend
- Command context resolution for operator command proposals
- Role prompt loading/defaults for orchestrator + worker agents
- pi CLI/SDK orchestration backends and resource loader helpers
- Prompt/template helpers used by orchestration roles

## Bundled default prompts

Bundled defaults now live as markdown files under `packages/agent/prompts/`:

- `operator.md`
- `orchestrator.md`
- `worker.md`
- `soul.md` (shared tail appended to all role prompts)

These are loaded by runtime code and are the single source of truth for default system prompts.

## Install

```bash
npm install @femtomc/mu-agent
# or: bun add @femtomc/mu-agent
```

## Development

From repo root (`mu/`):

```bash
bun run build
bun test packages/orchestrator packages/control-plane
```

## Serve-mode extensions (`mu serve`)

When `mu serve` starts the interactive assistant, it loads
`serveExtensionPaths` from `src/extensions/index.ts` (path-based extensions,
not anonymous inline factories).

Current stack:

- `brandingExtension` — mu compact header/footer branding + default theme
- `queryExtension` — read-only retrieval (`query` tool)
- `operatorCommandExtension` — approved mutation pathway (`command` tool)
- `eventLogExtension` — event tail + watch widget

`mu serve` sets `MU_SERVER_URL` automatically for these extensions.

Default operator UI theme is `mu-gruvbox-dark`.

## Slash commands (operator-facing)

- `/mu events [n]` / `/mu events tail [n]` — event log tail
- `/mu events watch on|off` — toggle event watch widget
- `/mu brand on|off|toggle` — enable/disable UI branding
- `/mu help` — dispatcher catalog of registered `/mu` subcommands

## Tools (agent/operator-facing)

- `query({ action, resource?, ... })`
  - Read-only pathway.
  - `action`: `describe | get | list | search | timeline | stats | trace`
  - Use `action="describe"` for machine-readable capability discovery.
- `command({ kind, ... })`
  - Approved mutation pathway through `/api/commands/submit`.
  - `kind` includes run lifecycle (`run_start|run_resume|run_interrupt`),
    control-plane lifecycle (`reload|update`), issue lifecycle/dependency edits
    (`issue_create|issue_update|issue_claim|issue_open|issue_close|issue_dep|issue_undep`),
    forum posting (`forum_post`), heartbeat program lifecycle
    (`heartbeat_create|heartbeat_update|heartbeat_delete|heartbeat_trigger|heartbeat_enable|heartbeat_disable`),
    and cron program lifecycle
    (`cron_create|cron_update|cron_delete|cron_trigger|cron_enable|cron_disable`).

### Query contract (context-safe by default)

The `query` tool is designed to be programmable + narrow-by-default:

- `limit` bounds result size (default typically `20`).
- `fields` (comma-separated paths) enables selective projection.
- domain filters (`status`, `tag`, `source`, `issue_id`, `run_id`, `conversation_key`, etc.) avoid broad scans.

Recommended flow:

1. `query(action="describe")` to discover capabilities.
2. bounded `list`/`search` with focused filters.
3. targeted `get`/`trace` with `fields` as needed.

## Control-plane config notes

- Runtime config source of truth is `.mu/config.json`.
- Inspect runtime state via `query(action="get", resource="status")` and related `query` reads.
- Apply control-plane lifecycle mutations via `command(kind="reload")` / `command(kind="update")`.
