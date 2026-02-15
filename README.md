# mu

**Keep-it-simple agent work orchestration.**

mu is an agent orchestration framework which keeps it as simple and minimal as possible (and not an ounce more).
You can think of it as a _long running harness_ (a "fire and forget" style UI): compared to interactive chat, 
the idea is that you spend a good amount of time thinking upfront about your prompt, and then 
expect to let `mu` run for many hours.

The design of `mu` supports this mode of operation by allowing agents to carefully keep track and manage 
context using a CLI issue tracker, a forum, and a work orchestration pattern based on hierarchical planning.

At the core, it provides AI agents (and humans) with three primitives for structured work:

- **Issue DAG** — decompose work into issues with parent/child and blocking
  dependencies. The DAG tracks status, priority, outcomes, and execution specs.
- **Forum** — topic-keyed message log for communication between agents and humans.
  Threads are cheap: one per issue, per research topic, etc.
- **Event log** — append-only audit trail. Every issue state change and forum post
  emits a structured event with run correlation IDs.

All state lives in a `.mu/` directory at your repo root: three JSONL files
(`issues.jsonl`, `forum.jsonl`, `events.jsonl`) and a `logs/` directory for
per-step backend output.

mu has two built-in roles: `orchestrator` and `worker`. Roles are built-in
system prompt.

The **orchestration engine** walks the DAG: it finds ready leaves (open issues with no
unresolved blockers or open children), dispatches them to the agent backend, and
manages the lifecycle — claim, execute, close/expand, repeat — until the
root issue is terminal.

## Project Context And Skills

- **Project context**: mu only loads `AGENTS.md` (and ignores `CLAUDE.md`).
- **Customization**: use skills, not role templates.
  - Pi skills: `.pi/skills/` (project) and `~/.pi/agent/skills/` (global).
  - Repo skills: if a repo has a top-level `skills/` directory, mu loads it too.

## Quickstart

```bash
npm install -g @femtomc/mu
cd /path/to/your/repo

mu init          # create .mu/ store
mu serve         # start server and open web UI
mu status        # show DAG state (CLI)
mu issues create "build the thing" --body "details here" --pretty
mu issues ready  # show executable leaf issues
mu forum post research:topic -m "found something" --author worker
```

### Web UI

The easiest way to interact with mu is through the web interface:

```bash
mu serve              # Start server and open browser
mu serve --no-open    # Headless mode (shows SSH forwarding instructions)
mu serve --port 8080  # Custom web UI port
```

The `mu serve` command:
- Starts the API server on port 3000 (configurable with `--api-port`)
- Starts the web UI on port 5173 (configurable with `--port`)
- Opens your browser automatically (unless `--no-open` or headless)
- Shows SSH port forwarding instructions in headless environments

## Packages

| Package | Description |
|---------|-------------|
| [`@femtomc/mu-core`](packages/core/README.md) | Types, JSONL persistence, DAG algorithms, event system. Runtime-agnostic core with Node and browser adapters. |
| [`@femtomc/mu-issue`](packages/issue/README.md) | Issue store — create, update, close, plus DAG queries (ready leaves, subtree, validate, collapsible). |
| [`@femtomc/mu-forum`](packages/forum/README.md) | Forum store — topic-keyed messages with read filtering and event emission. |
| [`@femtomc/mu-orchestrator`](packages/orchestrator/README.md) | DAG runner — walks the issue tree, dispatches to LLM backends, manages run lifecycle. |
| [`@femtomc/mu`](packages/cli/README.md) | Node CLI wrapping the above into `mu` commands. |
| [`@femtomc/mu-server`](packages/server/README.md) | HTTP API server — REST endpoints for issue and forum operations. |
| [`@femtomc/mu-web`](packages/web/README.md) | Web UI — browser frontend for managing issues and forum through the API. |
| [`@femtomc/mu-slack-bot`](packages/slack-bot/README.md) | Slack integration — slash commands for issue triage and creation. |

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

### Formatting

```bash
bun run fmt
bun run lint
bun run check
```

### Pack smoke test

```bash
bun run pack:smoke
```

Builds `dist/`, packs each publishable package, installs them into a temp
project, verifies imports under Node, and verifies the `mu` CLI runs.

## The `.mu/` directory

```
.mu/
├── issues.jsonl        # issue DAG state
├── forum.jsonl         # forum messages
├── events.jsonl        # audit trail
├── logs/               # per-run output
│   └── <issue-id>.jsonl
```

All files are newline-delimited JSON. The store is discovered by walking up from
the current directory until a `.mu/` directory is found.


