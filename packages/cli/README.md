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
mu session list            # List persisted operator sessions for this repo
mu status                  # Show repository status
mu issues list             # List all issues
mu issues create "title"   # Create new issue
mu issues ready            # Show ready leaf issues
mu forum post topic -m "message"  # Post to forum
mu run "goal..."           # Queue a run + attach operator terminal (auto-inits workspace store)
mu exec "task..."          # One-shot operator prompt (no queued run)
mu resume <root-id>        # Resume interrupted run
```

Most issue/forum/event/control-plane read surfaces now default to compact output.
Use `--json` (optionally with `--pretty`) when you need full machine records.

Use `mu exec` when you want a lightweight one-shot operator response.
Use `mu run` when you want queued DAG orchestration with run lifecycle tracking.

Memory retrieval supports a local memory index:

```bash
mu memory index status
mu memory index rebuild
mu memory search --query "reload" --limit 20
```

When the index exists, `mu memory search|timeline|stats` run index-first with automatic fallback to direct JSONL scans.
When the index is missing, memory queries auto-heal it on demand, and `mu serve` performs scheduled stale-index maintenance.

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

Type `/exit`, Ctrl+D, or Ctrl+C to leave the operator session. The server keeps running in the background; use `mu stop` to shut it down.

In headless environments, use SSH port forwarding as needed.

### Operator session defaults

`mu serve`'s attached terminal operator session inherits `<store>/config.json` defaults
from `control_plane.operator.provider/model` when present. The session uses generic
tools and invokes `mu` CLI commands directly for reads and mutations.

By default, operator sessions are persisted under `<store>/operator/sessions`, and
`mu session` reconnects to the latest persisted session.

For follow-up handoffs on a prior terminal/tmux session:

```bash
mu session list --json --pretty
mu turn --session-kind operator --session-id <session-id> --body "follow-up question"
```

If `--session-kind` is omitted, `mu turn` defaults to `cp_operator`
(`control-plane/operator-sessions`) rather than terminal operator sessions.

In-session `/mu` helpers include:

- `/mu plan ...` (planning phase/checklist HUD)
- `/mu subagents ...` (tmux + issue-queue monitor/spawner widget)
- `/mu events ...` (event tail/watch)
- `/mu brand ...` (chrome toggle)

Use `mu store paths` to resolve `<store>`, and `mu control status` to inspect current
config-driven control-plane/operator state.

### Messaging setup quick reference

```bash
# 1) Inspect adapter readiness + config path
mu control status --pretty

# 2) Configure adapter secrets in <store>/config.json
mu store paths --pretty

# 3) Reload adapters
mu control reload

# 4) Link identities (examples)
mu control link --channel slack --actor-id U123 --tenant-id T123
mu control link --channel discord --actor-id <user-id> --tenant-id <guild-id>
mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot
```

For Telegram delivery, `control_plane.adapters.telegram.bot_token` must be set in
`<store>/config.json` so outbox messages can be sent by the bot.

For Neovim, configure `control_plane.adapters.neovim.shared_secret` and use `:Mu link`
from `mu.nvim`.

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/cli
bun run typecheck
```

## Runtime

- **Bun runtime** (ESM).
- Reads/writes workspace-scoped state under `~/.mu/workspaces/<workspace-id>/` (or `$MU_HOME/workspaces/<workspace-id>/`).
