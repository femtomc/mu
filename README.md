# mu

**The little long-running assistant that could.**

`mu` is a personal assistant for technical work.

There's thousands of agents slopped into existence every day: the main distinguishing feature of this one is that it is
designed _to be long running_ (allowing you to prompt, and then leave it running for many hours). 
It bundles tools (within the `mu` CLI! all you need is bash and `mu` installed) designed to make this capability straightforward and practical. 

You can think of the main UX model as a sort of "fire and forget" style: compared to interactive chat, 
**the idea is that you spend a good amount of time thinking upfront about your prompt and context, 
and then expect to let the agent run for many hours.**

The philosophy behind this design arises from an observation: _chat is a terrible interface for serious engineering work_.
Chat is _excellent_ for exploratory work! But ... you know ... if I have a good plan, do I really need to be glued
to my harness? Can't I just ... let it do its thing, and receive updates every so often at the right level to understand
if I need to get involved? 

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

All state lives in a `.mu/` directory at your repo root: three JSONL files
(`issues.jsonl`, `forum.jsonl`, `events.jsonl`) and a `logs/` directory for
per-step backend output.

### Long running operation

mu has two built-in system prompts: `orchestrator` and `worker`. Orchestrators are
essentially planners and reviewers. They do a bunch of reading and thinking, organize the issue DAG, 
and schedule work. Workers are ... workers: they implement things, do tasks, etc.

The **orchestration engine** walks the issue DAG: it finds ready leaves (open issues with no
unresolved blockers or open children), dispatches them to the agent backend, and
manages the lifecycle — claim, execute, close/expand, repeat — until the
root issue is terminal.

## Architecture note (post-refactor)

mu uses an explicit **trusted-as-root** model for all agent roles (`operator`,
`orchestrator`, `worker`, `reviewer`). Role prompts are workflow contracts,
not security boundaries.

- Agent sessions use generic tools (`bash`, `read`, `write`, `edit`) and invoke
  `mu` CLI directly for reads and mutations.
- There is no dedicated `query(...)` vs `command(...)` tool boundary.
- `mu-server` is control-plane runtime infrastructure (transport/session/realtime
  plus run/activity scheduling for heartbeats and cron), not a privileged
  business-logic gateway.

Legacy gateway routes (`/api/commands/submit`, `/api/query`, `/api/issues*`,
`/api/forum*`, `/api/context*`) are removed.

For the concise removed-vs-added module summary and follow-up risk list, see
[`docs/architecture-trust-model-cli-first.md`](docs/architecture-trust-model-cli-first.md).

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
  - Repo skills: if a repo has a top-level `skills/` directory, mu loads it too.

## Quickstart

```bash
npm install -g @femtomc/mu
cd /path/to/your/repo

mu run "build the thing"  # create .mu/ store + root issue + start orchestration
mu serve         # start server + terminal operator + web UI
mu status        # show DAG state (CLI)
mu issues create "build the thing" --body "details here" --pretty
mu issues ready  # show executable leaf issues
mu forum post research:topic -m "found something" --author worker
```

### Web UI

The easiest way to interact with mu is through the web interface:

```bash
mu serve              # Start server, attach terminal chat, and open browser
mu serve --no-open    # Headless mode (shows SSH forwarding instructions)
mu serve --port 8080  # Custom web UI port
```

The `mu serve` command:
- Starts the API + web UI on a single port (default 3000, configurable with `--port`)
- Attaches an interactive terminal operator session in the same shell
- Opens your browser automatically (unless `--no-open` or headless)
- Shows SSH port forwarding instructions in headless environments
- Auto-mounts control-plane webhook routes from `.mu/config.json`

Type `/exit` in the chat prompt (or press Ctrl+C) to stop both chat and server.

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

Operator sessions are persisted by default (`.mu/operator/sessions`). Use `mu session`
to reconnect to the latest session, `mu session list` to browse persisted sessions,
or `mu session <session-id>` to reopen a specific one.

### Control Plane

Control-plane runtime configuration is file-based:

- Source of truth: `.mu/config.json`
- Live config API: `GET /api/config`, `POST /api/config` (patch)
- Runtime remount: `POST /api/control-plane/reload`
- Explicit rollback trigger: `POST /api/control-plane/rollback`
- Channel capability discovery: `GET /api/control-plane/channels`
- Session flash inbox: `POST /api/session-flash`, `GET /api/session-flash`
- Session turn injection: `POST /api/session-turn` (run real turn in target session, return reply + context cursor)

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
      "model": null
    }
  }
}
```

Use `mu control status` plus `.mu/config.json` edits to configure adapters, then reload control-plane (`POST /api/control-plane/reload` or `mu control reload`).

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

`/api/status` includes `control_plane` runtime state (active adapters/routes, generation supervisor snapshot, and reload observability counters).

Business state reads/mutations are CLI-first (`mu issues ...`, `mu forum ...`, `mu context ...`).

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
| [`@femtomc/mu-server`](packages/server/README.md) | HTTP API server — control-plane transport/session/realtime plus run/activity/heartbeat/cron coordination for `mu serve` and channel adapters. |
| [`@femtomc/mu-web`](packages/web/README.md) | Web UI frontend bundled with `mu serve`. |
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

## The `.mu/` directory

```
.mu/
├── .gitignore             # auto-generated; ignores all `.mu` runtime state
├── issues.jsonl           # issue DAG state
├── forum.jsonl            # forum messages
├── events.jsonl           # audit trail
├── logs/                  # per-run output
│   └── <issue-id>.jsonl
└── control-plane/         # (created when adapters are active)
    ├── commands.jsonl     # command journal
    ├── outbox.jsonl       # outbound message queue
    ├── identities.jsonl   # channel identity bindings
    ├── idempotency.jsonl  # dedup ledger
    ├── adapter_audit.jsonl
    ├── policy.json
    └── writer.lock
```

All files are newline-delimited JSON. The store is discovered by walking up from
the current directory until a `.mu/` directory is found.


