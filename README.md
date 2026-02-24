<p align="center">
  <img src="assets/mu-periodic-logo.svg" alt="mu periodic table style logo" width="180" />
</p>

# mu

**The little assistant that could.**

`mu` is a personal assistant for technical work, designed for long-running execution,
persistence, and reactivity.

It is a _programmable_ assistant, in much the same spirit of systems like OpenClaw (and, under the surface, [`pi`](https://github.com/badlogic/pi-mono) -- to which we owe a lot), but it's a bit more measured (in our claims, and our code) and focused on technical work.

Features that are baked into other harnesses (Claude Code I'm looking at you) are expressed through a composition of modular primitives.

As Mario and Armin say, _bash is all you need_.

---

`mu` is a "pi distribution" (analogous to Emacs or Neovim distributions -- layers which customize or extend the base system in a particular way): we take [`pi`](https://github.com/badlogic/pi-mono) and
add a small set of capabilities -- good modular ideas inspired by (`beads`, `jules`, `openclaw`, etc). We retain the programmable spirit of pi, but
_add programmable batteries_: we can emulate _anything_ added to any other harness (including Claude Code, Codex, your favorite *Claw) with a few compositional 
ideas.

The ideas:
1. CLI issue tracker and forum
2. Programmable (by your agent!) HUD
3. Heartbeats and crons
4. Skills first

For instance, Claude's "plan mode" -- well, that's just a skill which directs the agent to work with the user to create a plan in the issue tracker, and communicate progress via the programmable HUD. Subagents ... skill, tmux, programmable HUD. Complex work orchestration project which you call GasTown? CLI issue tracker + forum, programmable HUD, heartbeats, and skills.

The core of this assistant is about _composition and modularity_ -- we want the minimal set of ingredients to express any harness idea.

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

## Skills-first workflows

`mu` ships with bundled starter skills (bootstrapped into `~/.mu/skills/`
or `$MU_HOME/skills/` during store initialization):

- `mu` — core operator workflow (bounded investigation, CLI-first state operations,
  session/handoff patterns)
- `memory` — cross-store context retrieval and index maintenance workflows
- `planning` — investigate first, then draft/refine an issue DAG plan with user approval loops
- `hud` — canonical HUD contract/workflow for `mu_hud` and `/mu hud`
- `hierarchical-work-protocol` — shared DAG planning/execution protocol used by both planning and subagents
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

- Ask your operator to use a relevant skill (for historical context: `memory`; for DAG work: `planning` -> `hud` -> `hierarchical-work-protocol` -> `subagents`; for recurring automation: `heartbeats` and/or `crons`; for docs/prose: `writing`).

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
