# mu

**The little long-running assistant that could.**

`mu` is a personal assistant for technical work.

There's thousands of agents slopped into existence every day: the main distinguishing feature of this one is that it is
designed _to be long running_ (allowing you to prompt, and then leave it running for many hours). 
It bundles tools (within the `mu` CLI! all you need is bash and `mu` installed) designed to make this capability straightforward and practical. 

You can think of the main UX model as a sort of "fire and forget" style: compared to interactive chat, 
**the idea is that you spend a good amount of time thinking upfront about your prompt and context, 
and then expect to let the agent run for many hours.**

The philosophy behind this design is simple: chat is excellent for exploration and steering,
while structured execution is better for long-running engineering work.
If you already have a solid plan, mu should be able to run for hours and report back at the right level,
so you only jump in when needed.

Most harnesses are trending in this direction, here's the pitch for this one:
- **this is an open source agent that does it well,
by people who care about the UX, and dogfood their own shit**
- **mu is a programmable tool: programmable tools prioritize _you_ and your relationship with your tools, not VC funders**

The design of `mu` supports _long-running_ operation by allowing agents to carefully keep track and manage 
context using an issue tracker, a forum, and a work orchestration pattern based loosely on hierarchical planning.
Each of these tools is built into the package, and accessible via the CLI, and agents are quite good
at using CLIs!

## mu, quickly

At the core, mu provides AI agents (and humans) with three primitives for structured work:

- **Issue DAG** — decompose work into issues with parent/child and blocking
  dependencies. The DAG tracks status, priority, and outcomes.
- **Forum** — topic-keyed message log for communication between agents and humans.
  Forum threads are cheap: one per issue, per research topic, etc. Very easy
  for agents to store persistent knowledge, comment on threads ... without leaving a
  tangled mess of Markdown.
- **Event log** — append-only audit trail. Every issue state change and forum post
  emits a structured event with run correlation IDs.

Runtime state lives in a workspace-scoped global store under:
`~/.mu/workspaces/<workspace-id>/` (or `$MU_HOME/workspaces/<workspace-id>/`).
Core files include `issues.jsonl`, `forum.jsonl`, `events.jsonl`, and `logs/`.

### Long running operation

mu ships with role prompts for `operator`, `orchestrator`, `reviewer`, and `worker`.
In long-running execution, orchestrators plan and coordinate, reviewers gate/iterate,
and workers execute concrete tasks.

The **orchestration engine** walks the issue DAG: it finds ready leaves (open issues with no
unresolved blockers or open children), dispatches them to the agent backend, and
manages the lifecycle — claim, execute, close/expand, repeat — until the
root issue is terminal.

## mu builds on pi

mu uses [`pi`](https://github.com/badlogic/pi-mono) directly -- `pi` is a great agent framework, 
check it out! `pi` amounts to _a very smart and sleek ant_ (in the words of Yegge), `mu` is concerned with
organizing smart ants into a workforce.

mu inherits much of pi's philosophy, which grounds out in 3 main design points:
- customizing mu's behavior is done straightforwardly with SKILLS, AGENTS.md, etc.
- all events are captured and auditable.
- there's good UIs for looking through all the work, event logs, etc.

## Customizing mu: Project Context and Skills

We don't recommend screwing around with the system prompts for orchestrators / workers, but 
you can customize the behavior of `mu` as you would any other agent.

- **Project context**: mu only loads `AGENTS.md` (ignores `CLAUDE.md`).
- **Customization**: if you wish to customize the context and behavior of mu's execution, use skills.
  - Pi skills: `.pi/skills/` (project) and `~/.pi/agent/skills/` (global).
  - Mu skills: `~/.mu/skills/` (global) and `~/.mu/workspaces/<workspace-id>/skills/` (workspace-local).
  - Repo skills: if a repo has a top-level `skills/` directory, mu loads it too.
  - On skill-name collisions, mu-prefixed roots are preferred by default.

## Quickstart

```bash
npm install -g @femtomc/mu
cd /path/to/your/repo

mu run "build the thing"  # initialize workspace store + root issue + start orchestration
mu serve         # start server + terminal operator
mu status        # show DAG state (CLI)
mu issues create "build the thing" --body "details here" --pretty
mu issues ready  # show executable leaf issues
mu forum post research:topic -m "found something" --author worker
```

### Terminal operator session

`mu serve` is the primary interactive surface:

```bash
mu serve              # Start server + attach terminal operator session
mu serve --port 8080  # Custom API/operator port
```

The `mu serve` command:
- Starts the API on a single port (default 3000, configurable with `--port`)
- Attaches an interactive terminal operator session in the same shell
- Supports headless/SSH usage via normal port forwarding
- Auto-mounts control-plane webhook routes from `<store>/config.json`

Type `/exit` (or press Ctrl+C) to leave the attached terminal operator session.
The server continues running in the background; use `mu stop` when you want to shut it down.

### `mu serve` operator quickstart

The attached terminal operator session uses generic tools (`bash`, `read`, `write`, `edit`) and
invokes `mu` CLI directly for state reads and mutations.

In the attached terminal chat, ask naturally (for example: “show status”,
“list ready issues”, “start a run for this prompt”).
The operator executes the corresponding CLI commands directly (for example: `mu status`,
`mu issues ready`, `mu runs start ...`).

Useful slash commands still available in-chat:

- `/mu events tail 20` — quick event log snapshot
- `/mu events watch on` — live event watch widget
- `/mu brand on|off|toggle` — toggle UI branding
- `/mu help` — list registered slash subcommands

By default, `mu serve` uses a compact, information-dense chrome with a built-in
`mu-gruvbox-dark` theme.

Operator CLI discipline (context-safe by default):

- Start with bounded discovery (`--limit` + scoped filters).
- Then inspect specific entities via targeted commands (`mu issues get <id>`, `mu runs trace <id>`).
- Prefer focused commands over repeated broad scans of issues/forum/events.

### Terminal Operator Chat

`mu serve` attaches an interactive terminal operator session in the same shell as the server.

Operator sessions are persisted by default under `<store>/operator/sessions`.
Use `mu session` to reconnect to the latest session, `mu session list` to browse persisted sessions,
or `mu session <session-id>` to reopen a specific one.

### Control Plane

Control-plane runtime configuration is file-based:

- Source of truth: `<store>/config.json`
- Live config API: `GET /api/control-plane/config`, `POST /api/control-plane/config` (patch)
- Runtime remount: `POST /api/control-plane/reload`
- Explicit rollback trigger: `POST /api/control-plane/rollback`
- Channel capability discovery: `GET /api/control-plane/channels`
- Session turn injection: `POST /api/control-plane/turn` (run real turn in target session, return reply + context cursor)

Use `mu store paths` to resolve `<store>` for the current repo/workspace.

Slack example:

```json
{
  "version": 1,
  "control_plane": {
    "adapters": {
      "slack": {
        "signing_secret": "..."
      }
    },
    "operator": {
      "enabled": true,
      "run_triggers_enabled": true,
      "provider": null,
      "model": null,
      "thinking": null
    }
  }
}
```

Use `mu control status` plus `<store>/config.json` edits to configure adapters, then reload control-plane (`POST /api/control-plane/reload` or `mu control reload`).

When adapters are active, `mu serve` prints mounted routes:

```
mu server connected at http://localhost:3000
Repository: /home/user/project
Control plane: active
  slack        /webhooks/slack
  telegram     /webhooks/telegram
Operator terminal: connecting...
Operator terminal: connected
```

`/api/control-plane/status` includes `control_plane` runtime state (active adapters/routes, generation supervisor snapshot, and reload observability counters).

Business state reads/mutations are CLI-first (`mu issues ...`, `mu forum ...`, `mu memory ...`).

## Packages

| Package | Description |
|---------|-------------|
| [`@femtomc/mu-core`](packages/core/README.md) | Types, JSONL persistence, DAG algorithms, event system. Runtime-agnostic core with Node and browser adapters. |
| [`@femtomc/mu-agent`](packages/agent/README.md) | Shared agent runtime primitives (operator runtime/backends, orchestration role prompts, pi agent backends, and prompt helpers). |
| [`@femtomc/mu-control-plane`](packages/control-plane/README.md) | Messaging control-plane runtime (Slack/Discord/Telegram adapters, policy/confirmation/idempotency pipeline, outbox + DLQ tooling). |
| [`@femtomc/mu-issue`](packages/issue/README.md) | Issue store — create, update, close, plus DAG queries (ready leaves, subtree, validate, collapsible). |
| [`@femtomc/mu-forum`](packages/forum/README.md) | Forum store — topic-keyed messages with read filtering and event emission. |
| [`@femtomc/mu-orchestrator`](packages/orchestrator/README.md) | DAG runner — walks the issue tree, dispatches to LLM backends, manages run lifecycle. |
| [`@femtomc/mu`](packages/cli/README.md) | Bun CLI wrapping the above into `mu` commands. |
| [`@femtomc/mu-server`](packages/server/README.md) | HTTP API server — control-plane transport/session/realtime plus run/activity coordination and heartbeat/cron operator-wake scheduling for `mu serve` and channel adapters. |
| [`mu.nvim`](packages/neovim/README.md) | First-party Neovim frontend channel (`:Mu`, optional `:mu` alias) for control-plane ingress. |

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

### Guardrails and CI parity checks

```bash
bun run guardrails:architecture  # fast architecture invariants (CI gate)
bun run guardrails               # architecture invariants + phase-critical regression suite
bun run check                    # guardrails + typecheck/build/full test
bun run pack:smoke               # package smoke validation
```

`bun run check` mirrors the CI core gate sequence.

Architecture dependency invariants are enforced from `scripts/guardrails.ts`
using the audit baseline plus explicit temporary overrides from:

- `scripts/guardrails-allowlist.json`

Override entries must include:
- `from` / `to` package names
- `reason`
- `issue` (tracking link/id)
- `expiresOn` (`YYYY-MM-DD`)

Expired or malformed overrides fail guardrails/CI.

For deliberate boundary dry-run failures, use:

```bash
MU_GUARDRAILS_DRY_RUN_FAIL=1 bun run guardrails:architecture
MU_GUARDRAILS_DRY_RUN_DEPENDENCY_FAIL=1 bun run guardrails:architecture
```

### Formatting

```bash
bun run fmt
bun run lint
```

### Pack smoke test

```bash
bun run pack:smoke
```

Builds `dist/`, packs each publishable package, installs them into a temp
project, verifies imports under Bun, and verifies the `mu` CLI runs.

## Workspace store layout

mu keeps runtime state in a global workspace store (default `~/.mu`, override with `$MU_HOME`):

```
~/.mu/
└── workspaces/
    └── <workspace-id>/
        ├── .gitignore
        ├── config.json
        ├── issues.jsonl
        ├── forum.jsonl
        ├── events.jsonl
        ├── logs/
        ├── operator/
        │   └── sessions/
        └── control-plane/
            ├── server.json
            ├── commands.jsonl
            ├── outbox.jsonl
            ├── identities.jsonl
            ├── idempotency.jsonl
            ├── adapter_audit.jsonl
            ├── operator-sessions/
            ├── operator_conversations.json
            ├── policy.json
            └── writer.lock
```

The store contains both JSONL logs/journals and JSON config/state files.
Workspace IDs are derived from repo root identity; use `mu store paths` to inspect
exact paths for your current repo.


