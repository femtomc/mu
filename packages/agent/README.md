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
  - `programmable-ui`
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
Operator-facing workflow detail lives in the skill docs (for example, `core/programmable-ui`).

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
- `uiExtension` — programmable `UiDoc` surface (`/mu ui ...`, `mu_ui`)

Default operator UI theme is `mu-gruvbox-dark`.

## Slash commands (operator-facing)

- `/mu events [n]` / `/mu events tail [n]` — event log tail
- `/mu events watch on|off` — toggle event watch widget
- `/mu brand on|off|toggle` — enable/disable UI branding
- `/mu ui ...` — inspect interactive `UiDoc`s (`status`/`snapshot`)
- `/mu help` — dispatcher catalog of registered `/mu` subcommands
- `ctrl+shift+u` — reopen local programmable-UI interaction flow

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
