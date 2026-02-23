# mu

**The little long-running assistant that could.**

`mu` is a personal assistant for technical work, designed for long-running execution,
persistence, and reactivity.

## Quickstart

```bash
npm install -g @femtomc/mu
cd /path/to/your/repo

mu --help
mu serve
```

In another terminal:

```bash
mu status --pretty
mu issues ready --pretty
mu forum post research:topic -m "found something" --author operator
mu memory search --query "reload" --limit 20
```

## Skills-first workflows

`mu` ships with bundled starter skills (bootstrapped into `~/.mu/skills/`
or `$MU_HOME/skills/` when missing):

- `mu` — core operator workflow (bounded investigation, CLI-first state operations,
  session/handoff patterns)
- `planning` — investigate first, then draft/refine an issue DAG plan with user approval loops
- `subagents` — durable issue-driven subagent orchestration (heartbeat + tmux fan-out)
- `setup-slack` — Slack adapter onboarding
- `setup-discord` — Discord adapter onboarding
- `setup-telegram` — Telegram adapter onboarding
- `setup-neovim` — Neovim frontend onboarding

Recommended usage pattern:

- Ask your operator to use a relevant skill (or mention the capability, e.g. "planning" or "subagents").

Examples:

- “Can we plan and setup an implementation issue DAG?”
- “Can you help me setup the slack messaging service?"
- “Summarize current ready work in our tracker.”

### Skill loading + precedence

- Mu global: `~/.mu/skills/`
- Mu workspace: `~/.mu/workspaces/<workspace-id>/skills/`
- Repo top-level: `skills/`
- Pi project/global (also loaded): `.pi/skills/`, `~/.pi/agent/skills/`

On name collisions, mu-prefixed roots are preferred by default.

## Messaging setup (recommended)

The messaging setup skills are agent-first: the agent patches config, reloads
control-plane, verifies routes/capabilities, and asks the user only for
required external-console steps and secret handoff.

Baseline control-plane commands:

```bash
mu control status --pretty
mu store paths --pretty
mu control reload
mu control identities --all --pretty
```

Detailed adapter internals and API contracts are in package docs:

- `packages/control-plane/README.md`
- `packages/server/README.md`
- `packages/neovim/README.md`

## Terminal operator sessions

`mu serve` is the primary interactive surface:

```bash
mu serve              # start server + attach terminal operator session
mu serve --port 8080  # custom port
```

Session follow-up:

```bash
mu session list --json --pretty
mu session <session-id>
mu turn --session-kind operator --session-id <session-id> --body "follow-up"
```

## Packages

| Package | Description |
|---------|-------------|
| [`@femtomc/mu-core`](packages/core/README.md) | Types, JSONL persistence, IDs, and event primitives. |
| [`@femtomc/mu-agent`](packages/agent/README.md) | Agent runtime primitives, prompt/skill loading, and operator integration. |
| [`@femtomc/mu-control-plane`](packages/control-plane/README.md) | Messaging control-plane runtime (Slack/Discord/Telegram/Neovim adapters). |
| [`@femtomc/mu-issue`](packages/issue/README.md) | Issue DAG store and lifecycle operations. |
| [`@femtomc/mu-forum`](packages/forum/README.md) | Topic-keyed forum message store. |
| [`@femtomc/mu`](packages/cli/README.md) | Bun CLI and programmatic entrypoint. |
| [`@femtomc/mu-server`](packages/server/README.md) | HTTP API server + control-plane/runtime coordination surfaces. |
| [`mu.nvim`](packages/neovim/README.md) | First-party Neovim frontend channel. |

When installed from npm, package READMEs are available under the install tree
(for example `<mu-install>/node_modules/@femtomc/mu-control-plane/README.md`).

## Development

```bash
bun install
bun run check
```

Additional commands:

```bash
bun run guardrails:architecture
bun run guardrails
bun run typecheck
bun test
bun run fmt
bun run lint
bun run pack:smoke
```

## Workspace store

Runtime state is workspace-scoped under:

- `~/.mu/workspaces/<workspace-id>/`
- or `$MU_HOME/workspaces/<workspace-id>/`

Use `mu store paths --pretty` to resolve exact paths for the current repo.
