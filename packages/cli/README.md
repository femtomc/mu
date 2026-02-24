# @femtomc/mu

`mu` is a personal assistant for technical work.

This package provides the Bun CLI and programmatic API.

## Install

After publishing:

```bash
npm install -g @femtomc/mu
# or: bun add -g @femtomc/mu
```

From this repo:

```bash
cd mu
bun install
bun run build
packages/cli/dist/cli.js --help
```

## Usage

### CLI Commands

```bash
mu serve                   # Start server + terminal operator session (auto-inits workspace store)
mu session                 # Reconnect to latest persisted operator session
mu session list            # List persisted sessions (operator + cp_operator) for this repo
mu session list --kind all --all-workspaces --limit 50
mu session list --verbose  # Show per-row kind chips in text output (op/cp)
mu status                  # Compact repository status summary
mu status --verbose        # Expanded ready/topic detail
mu control harness         # Compact harness adapter/provider/model snapshot
mu control harness --verbose  # Expanded capability vectors
mu control config get      # Compact typed workspace control-plane config
mu control config get --verbose  # Include defaults + descriptions
mu issues list             # List all issues
mu issues create "title"   # Create new issue
mu issues ready            # Show ready leaf issues
mu forum post topic -m "message"  # Post to forum
mu exec "task..."          # One-shot operator prompt
mu heartbeats --help        # Durable heartbeat automation programs
mu heartbeats stats         # Heartbeat scheduler summary (total/enabled/armed)
mu cron --help              # Durable cron automation programs
```

Most issue/forum/event/control-plane read surfaces now default to compact output.
Use `--json` (optionally with `--pretty`) when you need full machine records.


Use `mu exec` when you want a lightweight one-shot operator response.
Use `mu heartbeats`/`mu cron` + `mu turn`/`mu session` for durable
operator-centric automation loops.

Memory retrieval supports a local memory index:

```bash
mu memory index status
mu memory index rebuild
mu memory search --query "reload" --limit 20
```

When the index exists, `mu memory search|timeline|stats` run index-first
with automatic fallback to direct JSONL scans.
When the index is missing, memory queries auto-heal it on demand, and
`mu serve` performs scheduled stale-index maintenance.

### Programmatic API

```ts
import { run } from "@femtomc/mu";

const r = await run(["status", "--json"]);
if (r.exitCode !== 0) throw new Error(r.stdout);
console.log(r.stdout);
```

### Serve + terminal operator

The `mu serve` command starts the server and immediately
attaches an interactive terminal operator session in the same shell:

```bash
mu serve              # Default port: 3000 (operator session)
mu serve --port 8080  # Custom port
```

Type `/exit`, Ctrl+D, or Ctrl+C to leave the operator session.
The server keeps running in the background; use `mu stop` to shut it down.

In headless environments, use SSH port forwarding as needed.

### Operator session defaults

`mu serve`'s attached terminal operator session inherits `<store>/config.json` defaults
from `control_plane.operator.provider/model` when present. The session uses generic
tools and invokes `mu` CLI commands directly for reads and mutations.

By default, operator sessions are persisted under `<store>/operator/sessions`, and
`mu session` reconnects to the latest persisted session.
`mu session list` defaults to both session kinds (`operator` + `cp_operator`).
Text list output is compact by default; use `--verbose` to include kind chips and per-row session paths.

For follow-up handoffs on a prior terminal/tmux session:

```bash
mu session list --json --pretty
mu session list --kind cp_operator --json --pretty
mu session list --kind all --all-workspaces --limit 50 --json --pretty
mu session <session-id>  # auto-resolves operator/cp_operator stores by id
mu turn --session-kind operator --session-id <session-id> --body "follow-up question"
```

Session-scoped model/thinking updates (without changing workspace global defaults):

```bash
mu session config get --session-id <id>
mu session config set-model --session-id <id> --provider openai-codex --model gpt-5.3-codex --thinking high
mu session config set-thinking --session-id <id> --thinking minimal
```

Workspace global defaults remain under:

```bash
mu control operator set <provider> <model> [thinking]
mu control operator thinking-set <thinking>
```

Additional typed workspace config controls:

```bash
mu control config get
mu control config set control_plane.operator.enabled false
mu control config set control_plane.memory_index.every_ms 120000
mu control config unset control_plane.adapters.slack.bot_token
```

If `--session-kind` is omitted, `mu turn` auto-resolves `--session-id`
across both session stores (`operator/sessions` + `control-plane/operator-sessions`).
If the same id exists in both, pass `--session-kind` (or `--session-dir`) to disambiguate.

In-session `/mu` helpers include:

- `/mu hud ...` (HUD surface for status/snapshot/on/off/toggle/clear/remove)
- `/mu events ...` (event tail/watch)
- `/mu brand ...` (chrome toggle)

Use `mu store paths` to resolve `<store>`, `mu control status` for compact
control-plane/operator state (or `--verbose` for detail), and `mu control harness`
for compact provider/model availability + capability vectors (`--verbose` to expand).

### Messaging setup (skills-first)

Prefer bundled setup skills for channel onboarding (`setup-slack`, `setup-discord`,
`setup-telegram`, `setup-neovim`). These workflows are agent-first: the agent patches
config, reloads control-plane, verifies routes/capabilities, and asks the user only for
required external-console steps and secret handoff.

Baseline control-plane commands:

```bash
mu control status
mu control status --verbose
mu control config get
mu control config get --verbose
mu store paths --pretty
mu control reload
mu control identities --all --pretty
```

For manual linking (Slack/Discord/Telegram):

```bash
mu control link --channel slack --actor-id U123 --tenant-id T123
mu control link --channel discord --actor-id <user-id> --tenant-id <guild-id>
mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot
```

For Neovim identity binding, use `:Mu link` from `mu.nvim`.

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/cli
bun run typecheck
```

## Runtime

- **Bun runtime** (ESM).
- Reads/writes workspace-scoped state under
  `~/.mu/workspaces/<workspace-id>/` (or `$MU_HOME/workspaces/<workspace-id>/`).
