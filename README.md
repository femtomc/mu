# mu

<p align="center">
  <img src="assets/mu-periodic-logo.svg" alt="mu periodic table style logo" width="180" />
</p>

```
npm install -g @femtomc/mu
```

**The little assistant that could.**

`mu` is a personal assistant for technical work, designed for long-running execution,
persistence, and reactivity.

It is a _programmable_ assistant: features that are baked into other harnesses are expressed through a composition of modular primitives.

As [Mario](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) and [Armin](https://lucumr.pocoo.org/2026/1/31/pi/) say, _bash is all you need_.

## The pitch for (natural language) programmability

`mu` is a "pi distribution" (analogous to Emacs or Neovim distributions -- layers which customize or extend the base system in a particular way): we take [`pi`](https://github.com/badlogic/pi-mono), retain the programmable (customize it yourself) spirit of pi, and
_add programmable batteries_:

1. CLI issue tracker and forum (thank [beads](https://github.com/steveyegge/beads) for the idea)
2. Heartbeats and crons (thank [openclaw](https://github.com/openclaw/openclaw) for the idea)
3. Programmable (by your agent!) HUD

These additions form a programmable substrate which you use to program via skills (already handled by `pi`).

For instance, Claude's "plan mode" -- well, that's just a skill which directs the agent to work with the user to create a plan in the issue tracker, and communicate progress via the programmable HUD. Subagents ... skill, tmux, programmable HUD. Complex work orchestration project which you call Gas Town? CLI issue tracker + forum, programmable HUD, heartbeats, and skills.

The core of this assistant is about _composition and modularity_ -- we want the minimal set of ingredients which _you compose_ to get more complex harness ideas.
Then, you have the power to take our ingredients and do whatever you want with them.

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
mu control harness --pretty
mu issues ready --pretty
mu forum post research:topic -m "found something" --author operator
mu memory search --query "reload" --limit 20
```

## Skills are behavioral programs

With the correct programmable substrate for your agent (_bash + CLI tools are all you need_), skills should be all that 
you really need to customize. Skills can be dynamically improved, optimized by reflecting
on traces of interaction ... they're just Markdown, easy to change and modify, and immediately
reflected in the agent's policy distribution.

`mu` ships with a set of starter skills (bootstrapped into `~/.mu/skills/`
or `$MU_HOME/skills/` during store initialization):

- `mu` — core instruction concerning the `mu` CLI
- `memory` — context retrieval and index maintenance
- `planning` — investigate first, then draft/refine an issue DAG plan with user approval loops
- `hud` — canonical HUD contract/workflow
- `orchestration` — shared DAG planning/execution protocol used by both planning and subagents
- `control-flow` — compositional loop/termination policy overlays (for example review-gated retries)
- `subagents` — durable issue-driven subagent orchestration (heartbeat + tmux fan-out)
- `heartbeats` — heartbeat program lifecycle for durable, bounded automation loops
- `crons` — wall-clock scheduling workflows for recurring/one-shot automation
- `setup-slack` — Slack adapter onboarding
- `setup-discord` — Discord adapter onboarding
- `setup-telegram` — Telegram adapter onboarding
- `setup-neovim` — Neovim frontend onboarding
- `writing` — technical writing workflow for docs/READMEs/PR descriptions and operator-facing prose

Starter skills are version-synced. Initial bootstrap seeds missing skills; bundled-version
changes refresh installed starter skill files in `~/.mu/skills/` (or `$MU_HOME/skills/`).

Recommended usage pattern:

- Ask your operator to use a relevant skill (for historical context: `memory`; for DAG work: `planning` -> `hud` -> `orchestration` -> `control-flow` -> `subagents`; for recurring automation: `heartbeats` and/or `crons`; for docs/prose: `writing`).

Examples:

- “Can we plan and setup an implementation issue DAG?”
- “Can you help me setup the slack messaging service?"
- “Summarize current ready work in our tracker.”

### Skill loading + precedence

First-match precedence is:

- Mu workspace: `~/.mu/workspaces/<workspace-id>/skills/`
- Mu global: `~/.mu/skills/`
- Repo top-level: `skills/`
- Pi project/global (also loaded): `.pi/skills/`, `~/.pi/agent/skills/`

On name collisions, roots earlier in this list win.

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

Session follow-up (`mu session list` defaults to both `operator` + `cp_operator`):

```bash
mu session list --json --pretty
mu session list --kind cp_operator --json --pretty
mu session list --kind all --all-workspaces --limit 50 --json --pretty
mu session <session-id>  # auto-resolves operator/cp_operator stores by id
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
