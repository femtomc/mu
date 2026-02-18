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
- `serverToolsExtension` — status + issues/forum/events/control-plane tools
- `eventLogExtension` — event tail + watch widget
- `messagingSetupExtension` — adapter diagnostics and setup guidance

`mu serve` sets `MU_SERVER_URL` automatically for these extensions.

Default operator UI theme is `mu-gruvbox-dark`.

## Slash commands (operator-facing)

- `/mu status` — concise server status
- `/mu control` — active control-plane adapters and webhook routes
- `/mu setup` — adapter preflight
- `/mu setup plan <adapter>` — actionable wiring plan
- `/mu setup apply <adapter>` — guided config apply + control-plane reload
- `/mu setup verify [adapter]` — runtime verification for mounted routes
- `/mu setup <adapter>` — sends adapter setup brief to mu agent (`--no-agent` prints local guide)
- `/mu events [n]` / `/mu events tail [n]` — event log tail
- `/mu events watch on|off` — toggle event watch widget
- `/mu brand on|off|toggle` — enable/disable UI branding

## Tools (agent/operator-facing)

- `mu_status()`
  - High-level server status.
- `mu_control_plane({ action })`
  - `action`: `status | adapters | routes`
- `mu_issues({ action, ... })`
  - `action`: `list | get | ready`
- `mu_forum({ action, ... })`
  - `action`: `read | post | topics`
- `mu_events({ action, ... })`
  - `action`: `tail | query`
- `mu_messaging_setup({ action, adapter?, public_base_url? })`
  - `action`: `check | preflight | guide | plan | apply | verify`
  - `adapter`: `slack | discord | telegram | gmail`

## Messaging setup notes

- Runtime setup state comes from `GET /api/config` and `.mu/config.json`.
- `slack`, `discord`, `telegram` are currently modeled as available adapters.
- `gmail` is modeled as planned guidance (not mounted by runtime yet).
- `mu_messaging_setup(action=preflight)` is the quickest health check during
  onboarding.
