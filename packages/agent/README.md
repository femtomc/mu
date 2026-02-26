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

## Bundled starter skills

Bundled starter skills live under `packages/agent/prompts/skills/` and are bootstrapped
into `~/.mu/skills/` (or `$MU_HOME/skills/`) by the CLI store-initialization path.
They are organized as category meta-skills plus subskills:

- `core`
  - `mu`
  - `memory`
  - `tmux`
  - `code-mode`
- `subagents`
  - `planning`
  - `protocol`
  - `execution`
  - `control-flow`
  - `model-routing`
- `automation`
  - `heartbeats`
  - `crons`
- `messaging`
  - `setup-slack`
  - `setup-discord`
  - `setup-telegram`
  - `setup-neovim`
- `writing`

Starter skills are version-synced by CLI bootstrap. Initial bootstrap seeds missing
skills; bundled-version changes refresh installed starter skill files.

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
- `uiExtension` — programmable `UiDoc` surface (`/mu ui ...`, `mu_ui`) with terminal auto-prompt/awaiting behavior and deterministic action fallbacks

Default operator UI theme is `mu-gruvbox-dark`.

## Slash commands (operator-facing)

- `/mu events [n]` / `/mu events tail [n]` — event log tail
- `/mu events watch on|off` — toggle event watch widget
- `/mu brand on|off|toggle` — enable/disable UI branding
- `/mu ui ...` — inspect interactive `UiDoc`s (`status`/`snapshot`)
- `/mu help` — dispatcher catalog of registered `/mu` subcommands
- `ctrl+shift+u` — reopen local programmable-UI interaction flow (in-TUI doc/action picker, auto-fill payload-backed template values, prompt unresolved values, submit composed prompt)

## Programmable UI documents

Skills can publish interactive UI state via the `mu_ui` tool. Rendered `UiDoc`s survive session reconnects
(30 minute retention per session ID), respect revision/version bumps, and route action clicks/taps back to
plain command text via `metadata.command_text` (the `/answer` flow is the reference pattern).

Actions without `metadata.command_text` are treated as non-interactive and rendered as deterministic fallback rows.

Current runtime behavior is channel-specific:

- Slack renders rich blocks + interactive action buttons.
- Discord/Telegram/Neovim render text-first docs; interactive actions are tokenized, while status-profile actions deterministically degrade to command-text fallback.
- Terminal operator UI (`mu serve`) renders docs in-widget, auto-prompts when agent publishes new runnable actions, shows `awaiting` UI status/widget state until resolved, and supports manual reopen via `ctrl+shift+u` (in-TUI picker overlay + prompt composition).
- When interactive controls cannot be rendered, adapters append deterministic text fallback.

See the [Programmable UI substrate guide](../../docs/mu-ui.md) for the full support matrix and workflow.

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
