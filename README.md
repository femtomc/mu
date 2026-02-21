# mu

**The little long-running assistant that could.**

`mu` is a personal assistant for technical work, designed for long-running execution, persistence, and reactivity.

## Quickstart

```bash
npm install -g @femtomc/mu
cd /path/to/your/repo

mu --help
mu exec "quickly inspect current ready work and summarize"
mu heartbeats --help
mu status --pretty
mu issues ready --pretty
mu forum post research:topic -m "found something" --author worker
```

For messaging adapter-specific setup (Slack/Discord/Telegram/Neovim), use the package READMEs linked in [Packages](#packages).

## Agent workflow commands

```bash
# Start work
mu exec "quick one-shot analysis"
mu status --pretty
mu issues ready --root <root-id> --pretty
mu heartbeats --help

# Inspect + mutate state (bounded first)
mu issues list --status open --limit 20 --pretty
mu issues get <id> --pretty
mu forum read issue:<id> --limit 20 --pretty
mu issues update <id> --status in_progress --pretty
mu issues close <id> --outcome success --pretty

# Memory + store inspection
mu memory search --query "<text>" --limit 20
mu memory index status
mu store paths --pretty
mu store tail events --limit 20 --pretty

# Messaging/control-plane lifecycle
mu control status --pretty
mu control reload
```

## Minimal orchestration protocol contract

`mu` treats the issue DAG as the executable coordination graph. The protocol kernel is:

- `split/plan` — create child issues and dependency edges
- `claim` — lease ready leaf work
- `publish` — persist durable outputs/summaries to forum/artifacts
- `close` — apply terminal outcomes (`success|failure|needs_work|expanded`)
- `decide` — explicit gate decisions (ask/review/waiver/approval)

Context semantics are operation-specific and deterministic:

- **spawn context**: minimal dependency projection only (bounded, source-linked)
- **fork context**: inherited branch context + deterministic reduction inputs for joins
- **join/review gates**: ordinary DAG nodes with explicit dependencies (no global phase machine)

CLI guidance:

- Use primitive surfaces directly: `mu issues ...`, `mu forum ...`, and `mu exec ...`.
- Durable automation: `mu heartbeats ...` and `mu cron ...`.
- Operator session control: `mu session ...` and `mu turn ...`.

## mu, quickly

`mu` is a modular and compositional system. Broken apart, here are some of the main ideas:

- **Work orchestration: structured work state**
  - **Issue DAG** for decomposition, dependencies, status, and outcomes
  - **Forum** for topic-based coordination and durable agent notes
  - **Event log** for append-only audit trails and run correlation

- **Work orchestration: protocol + skills**
  - Minimal protocol contract over the issue DAG: `split/plan`, `claim`, `publish`, `close`, `decide`
  - Context semantics are explicit: spawn = dependency-minimal projection; fork = inherited branch context + deterministic reductions
  - Execution substrate is operator-driven skills (`planning`, `subagents`, `reviewer`) plus durable wake loops (`mu heartbeats`, `mu cron`)

- **Chat: operators and sessions**
  - Operators are your chat-based portal to `mu`: they are capable coding agent sessions with knowledge of how `mu` works
  - Operators are able to assist you with anything you wish `mu` to do, including extending `mu` for yourself
  - Executing `mu` gives you a terminal operator session (`operator` role)
  - All sessions are stored and can be resumed or connected to

- **Chat: messaging control-plane**
  - Ingress/egress pipeline for Slack, Discord, Telegram, and Neovim
  - Control-plane attaches messaging services to operator sessions
  - Identity binding, policy gates, confirmation workflow, idempotency, and outbox delivery
  - Runtime config + adapter lifecycle control (`mu control status`, `mu control reload`)

- **Reactivity: scheduled automation**
  - Heartbeat programs (`mu heartbeats ...`) and cron programs (`mu cron ...`)
  - Operator-wake driven execution loops for recurring and event-driven work

- **Memory: context retrieval + indexing**
  - `mu memory search|timeline|stats`
  - Local memory index management (`mu memory index status|rebuild`)

Runtime state is workspace-scoped under:
`~/.mu/workspaces/<workspace-id>/` (or `$MU_HOME/workspaces/<workspace-id>/`).
Use `mu store paths` to resolve exact locations for the current repo.

## mu builds on pi

mu uses [`pi`](https://github.com/badlogic/pi-mono) directly -- `pi` is a great agent framework, 
check it out!

mu inherits much of pi's philosophy, which grounds out in 3 main design points:
- customizing mu's behavior is done straightforwardly with SKILLS, AGENTS.md, etc.
- all events are captured and auditable.
- there's good UIs for looking through all the work, event logs, etc.

## Customizing mu: Project Context and Skills

You can customize `mu` behavior as you would any other agent via project context and skills.

- **Project context**: mu only loads `AGENTS.md` (ignores `CLAUDE.md`).
- **Customization**: if you wish to customize the context and behavior of mu's execution, use skills.
  - Pi skills: `.pi/skills/` (project) and `~/.pi/agent/skills/` (global).
  - Mu skills: `~/.mu/skills/` (global) and `~/.mu/workspaces/<workspace-id>/skills/` (workspace-local).
  - Starter skills: mu bootstraps built-ins into `~/.mu/skills/` (or `$MU_HOME/skills/`) when missing:
    - `planning` (investigate first, then draft/refine issue DAG plans with the user)
    - `subagents` (parallel subagent dispatch with tmux)
    - `reviewer` (dedicated reviewer lane with tmux)
  - Repo skills: if a repo has a top-level `skills/` directory, mu loads it too.
  - On skill-name collisions, mu-prefixed roots are preferred by default.


## Terminal operator session

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

Type `/exit`, Ctrl+D, or Ctrl+C to leave the attached terminal operator session.
The server continues running in the background; use `mu stop` when you want to shut it down.

### `mu serve` operator quickstart

The attached terminal operator session uses generic tools (`bash`, `read`, `write`, `edit`) and
invokes `mu` CLI directly for state reads and mutations.

In the attached terminal chat, ask naturally (for example: “show status”,
“list ready issues”, “show heartbeat programs”).
The operator executes the corresponding CLI commands directly (for example: `mu status`,
`mu issues ready`, `mu heartbeats list`).

Useful slash commands still available in-chat:

- `/mu events tail 20` — quick event log snapshot
- `/mu events watch on` — live event watch widget
- `/mu brand on|off|toggle` — toggle UI branding
- `/mu plan ...` — planning HUD (phases, checklist editing, communication state, snapshots)
- `/mu subagents ...` — subagents HUD (tmux + issue queue scope, spawn profiles, pause policy, refresh/staleness health)
- `/mu help` — list registered slash subcommands

By default, `mu serve` uses a compact, information-dense chrome with a built-in
`mu-gruvbox-dark` theme.

Operator CLI discipline (context-safe by default):

- Start with bounded discovery (`--limit` + scoped filters).
- Then inspect specific entities via targeted commands (`mu issues get <id>`, `mu replay <root-id>/<issue-id>`).
- Prefer focused commands over repeated broad scans of issues/forum/events.

### Terminal Operator Chat

`mu serve` attaches an interactive terminal operator session in the same shell as the server.

Operator sessions are persisted by default under `<store>/operator/sessions`.
Use `mu session` to reconnect to the latest session, `mu session list` to browse persisted sessions,
or `mu session <session-id>` to reopen a specific one.

For subagent handoffs and follow-up questions, use `mu turn` against the same session id:

```bash
mu session list --json --pretty
mu turn --session-kind operator --session-id <session-id> --body "Follow-up question"
```

When `--session-kind` is omitted, `mu turn` defaults to control-plane operator sessions
(`cp_operator`, `<store>/control-plane/operator-sessions`).

## Control Plane

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

## Messaging setup (at a glance)

Use this baseline flow for Slack/Discord/Telegram/Neovim:

```bash
mu store paths --pretty      # resolve <store>
mu control status --pretty   # inspect adapter readiness
# edit <store>/config.json   # set adapter secrets
mu control reload            # apply config live
```

Identity linking:

```bash
mu control link --channel slack --actor-id U123 --tenant-id T123
mu control link --channel discord --actor-id <user-id> --tenant-id <guild-id>
mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot
```

`mu control link` currently covers Slack/Discord/Telegram. For Neovim identity binding, use
`:Mu link` from `mu.nvim`.

Detailed adapter runbooks live in package READMEs:

- `packages/server/README.md`
- `packages/control-plane/README.md`
- `packages/neovim/README.md`

## Packages

| Package | Description |
|---------|-------------|
| [`@femtomc/mu-core`](packages/core/README.md) | Types, JSONL persistence, IDs, and event system primitives. Runtime-agnostic core with Node and browser adapters. |
| [`@femtomc/mu-agent`](packages/agent/README.md) | Shared agent runtime primitives (operator runtime/backends, skill loading, pi agent backends, and prompt helpers). |
| [`@femtomc/mu-control-plane`](packages/control-plane/README.md) | Messaging control-plane runtime (Slack/Discord/Telegram adapters, policy/confirmation/idempotency pipeline, outbox + DLQ tooling). |
| [`@femtomc/mu-issue`](packages/issue/README.md) | Issue store — create, update, close, plus DAG queries (ready leaves, subtree, validate, collapsible). |
| [`@femtomc/mu-forum`](packages/forum/README.md) | Forum store — topic-keyed messages with read filtering and event emission. |
| [`@femtomc/mu`](packages/cli/README.md) | Bun CLI wrapping protocol + skills control surfaces into `mu` commands. |
| [`@femtomc/mu-server`](packages/server/README.md) | HTTP API server — control-plane transport/session/realtime plus heartbeat/cron and operator-turn orchestration surfaces for `mu serve` and channel adapters. |
| [`mu.nvim`](packages/neovim/README.md) | First-party Neovim frontend channel (`:Mu`, optional `:mu` alias) for control-plane ingress. |

When `mu` is installed from npm, package READMEs are available under the install tree
(for example `<mu-install>/node_modules/@femtomc/mu-control-plane/README.md`).
The operator prompt injects absolute runtime paths for these package READMEs.

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
