# @femtomc/mu-agent

Shared agent runtime package for mu.

This package provides reusable runtime pieces for operator sessions and serve-mode tooling, including:

- Messaging operator runtime + backend
- Command context resolution for operator command proposals
- Operator prompt loading/defaults
- pi CLI/SDK backend and resource loader helpers
- Prompt/template helpers

## Bundled default prompts

Bundled defaults now live as markdown files under `packages/agent/prompts/`:

- `operator.md`
- `soul.md` (shared tail appended to the operator prompt)

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
bun test packages/agent/test
```

## Serve-mode extensions (`mu serve`)

When `mu serve` starts the interactive assistant, it loads
`serveExtensionPaths` from `src/extensions/index.ts` (path-based extensions,
not anonymous inline factories).

Current stack:

- `brandingExtension` — mu compact header/footer branding + default theme
- `eventLogExtension` — event tail + watch widget
- `planningUiExtension` — planning mode: compact HUD for next-step/approval flow in widget/status surfaces while keeping the branding footer unchanged (`/mu plan ...`)
- `subagentsUiExtension` — subagents mode: compact HUD with activity sentences from issue/forum events, with state kept in widget/status surfaces while branding footer stays unchanged (`/mu subagents ...`)

Default operator UI theme is `mu-gruvbox-dark`.

## Slash commands (operator-facing)

- `/mu events [n]` / `/mu events tail [n]` — event log tail
- `/mu events watch on|off` — toggle event watch widget
- `/mu brand on|off|toggle` — enable/disable UI branding
- `/mu plan ...` — planning HUD (phases, checklist editing, communication state, snapshots); does not inject planning metadata into branding footer
- `/mu subagents ...` — tmux + issue queue monitor/spawner (profiles, spawn pause, stale/refresh controls, snapshots); does not inject subagents metadata into branding footer
- `/mu help` — dispatcher catalog of registered `/mu` subcommands

## Tooling model (CLI-first)

mu agent sessions rely on generic built-in tools from pi:

- `bash`
- `read`
- `write`
- `edit`

State inspection and mutation are performed by invoking `mu` CLI commands
directly through `bash`, for example:

```bash
mu status --pretty
mu issues get <id> --pretty
mu forum read issue:<id> --limit 20 --pretty
mu issues close <id> --outcome success --pretty
mu control reload --pretty
```

There is no dedicated `query(...)` vs `command(...)` wrapper boundary in this package.

## Control-plane config notes

- Runtime config source of truth is `<store>/config.json` (resolve with `mu store paths`).
- Inspect runtime state via CLI (`mu control status`, `mu status`).
- Apply control-plane lifecycle mutations via CLI (`mu control reload`, `mu control update`).
