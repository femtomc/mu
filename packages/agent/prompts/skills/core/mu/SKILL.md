---
name: mu
description: "Runs core mu operator workflows for bounded investigation, CLI-first state operations, and session handoffs. Use when general mu execution or state-management guidance is needed."
---

# mu

Use this skill for day-to-day operator work in `mu`: inspect state, mutate state safely,
run focused execution loops, and hand off to specialized skills when needed.

## Contents

- [Core contract](#core-contract)
- [CLI capability map](#cli-capability-map)
- [Default bounded investigation loop](#default-bounded-investigation-loop)
- [Common mutation and diagnostics patterns](#common-mutation-and-diagnostics-patterns)
- [Reference `/answer` flow (mu_ui-only)](#reference-answer-flow-mu_ui-only)
- [Session, serve, and one-shot surfaces](#session-serve-and-one-shot-surfaces)
- [Durable automation handoff](#durable-automation-handoff)
- [Evaluation scenarios](#evaluation-scenarios)
- [Escalation map](#escalation-map)

## Core contract

1. **Investigate first**
   - Prefer cheap evidence over assumptions.
   - Start with bounded queries (`--limit`, scoped filters), then drill into specific entities.

2. **CLI-first state operations**
   - Use `mu` command surfaces for state reads/writes (`issues`, `forum`, `memory`, `events`, `control`, `store`, `session`).
   - Avoid hand-editing JSONL runtime journals for normal operations.

3. **Read -> act -> verify loop**
   - Before writes: inspect relevant current state.
   - After writes: re-read to confirm effect.

4. **Prefer self-discovery when uncertain**
   - Run `mu --help` and `mu <command> --help` instead of guessing flags/subcommands.
   - Use `mu guide` for the canonical in-CLI workflow map.

5. **Keep work reversible and explicit**
   - Prefer small, composable steps.
   - State assumptions and blockers clearly.

## CLI capability map

Use these command groups as the source of truth for current capabilities:

- Orientation + summaries:
  - `mu --help`
  - `mu guide`
  - `mu status --pretty`
- Work graph + coordination:
  - `mu issues <subcmd>`
  - `mu forum <subcmd>`
- Context retrieval + traces:
  - `mu memory <search|timeline|stats|index ...>`
  - `mu events <list|trace ...>`
- Control-plane + operator config:
  - `mu control status`
  - `mu control harness`
  - `mu control identities`
  - `mu control operator <...>`
  - `mu control config <get|set|unset ...>`
  - `mu control reload`
  - `mu control diagnose-operator`
- Session/runtime surfaces:
  - `mu serve`, `mu stop`
  - `mu session [list|config|<id>]`
  - `mu turn ...`
  - `mu exec ...`
- Durable automation:
  - `mu heartbeats <...>`
  - `mu cron <...>`
- Store forensics + replay:
  - `mu store <paths|ls|tail ...>`
  - `mu replay <id|path>`
- Provider auth:
  - `mu login [<provider>] [--list] [--logout]`

## Default bounded investigation loop

```bash
mu status --pretty
mu issues list --status open --limit 20 --pretty
mu issues ready --limit 20 --pretty
mu forum topics --prefix issue: --limit 20 --pretty
mu memory search --query "<topic>" --limit 20
mu events list --limit 20 --pretty
mu store tail events --limit 20 --pretty
```

Then inspect concrete targets:

```bash
mu issues get <id> --pretty
mu forum read issue:<id> --limit 20 --pretty
mu memory timeline --issue-id <id> --order desc --limit 40 --pretty
```

## Common mutation and diagnostics patterns

Issue/forum lifecycle:

```bash
mu issues claim <id> --pretty
mu issues update <id> --status in_progress --pretty
mu forum post issue:<id> -m "START: <plan>" --author operator
mu forum post issue:<id> -m "RESULT: <summary>" --author operator
mu issues close <id> --outcome success --pretty
```

Control-plane lifecycle and config:

```bash
mu control status --pretty
mu control harness --pretty
mu control identities --all --pretty
mu control config get --pretty
mu control operator get --pretty
mu control reload
```

Targeted config/operator updates:

```bash
mu control config set control_plane.operator.enabled false
mu control config set control_plane.memory_index.every_ms 120000
mu control operator set openai-codex gpt-5.3-codex high
mu control diagnose-operator --limit 40 --pretty
```

Store forensics and run replay:

```bash
mu store paths --pretty
mu store ls --pretty
mu store tail cp_commands --limit 20 --pretty
mu store tail cp_outbox --limit 20 --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
mu store tail cp_operator_turns --limit 20 --pretty
mu replay <issue-id-or-log-path>
```

## Reference `/answer` flow (mu_ui-only)

Use this as the canonical interactive-skill pattern. Keep all behavior in skill logic and
`mu_ui` documents/events; do not add adapter- or extension-specific branches.

1. Publish the answer prompt as a `UiDoc` via `mu_ui`:

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:answer",
    "title": "Answer",
    "components": [{ "kind": "text", "id": "prompt", "text": "Choose an answer", "metadata": {} }],
    "actions": [
      { "id": "answer_yes", "label": "Answer yes", "payload": { "choice": "yes" }, "metadata": { "command_text": "/answer yes" } },
      { "id": "answer_no", "label": "Answer no", "payload": { "choice": "no" }, "metadata": { "command_text": "/answer no" } }
    ],
    "revision": { "id": "rev:answer:1", "version": 1 },
    "updated_at_ms": 1
  }
}
```

2. On `/answer <choice>` input, validate choice, clear/remove `ui:answer` via `mu_ui`, then emit a
   normal response.
3. Keep revisions monotonic (`revision.version`) so reconnect/replay keeps the highest revision.
4. Rely on `metadata.command_text` for cross-surface parity: TUI + messaging channels should route
   the same `/answer ...` command text.

## Session, serve, and one-shot surfaces

Primary interactive surface:

```bash
mu serve
```

Session follow-ups/handoffs:

```bash
mu session list --kind all --all-workspaces --limit 50 --json --pretty
mu session <session-id>
mu turn --session-kind operator --session-id <session-id> --body "<follow-up>"
mu session config get --session-id <session-id>
mu session config set-thinking --session-id <session-id> --thinking minimal
```

One-shot prompt (no durable session):

```bash
mu exec --message "<task>" --json
```

In attached terminal operator chat, `/mu` helpers are available (`/mu events`, `/mu hud ...`, `/mu help`).

## Durable automation handoff

Use heartbeat/cron programs for recurring or unattended progression:

```bash
mu heartbeats --help
mu cron --help
```

When work is multi-step and issue-graph driven, use `planning` to shape the DAG,
then `hud` for canonical HUD behavior, then `protocol` to keep DAG
semantics consistent, then `control-flow` for explicit loop/termination policy,
then `model-routing` for per-issue provider/model/thinking selection overlays,
then `execution` for durable execution supervision.
For REPL-driven exploration and context compression, use `code-mode`.
For persistent terminal sessions and worker fan-out mechanics, use `tmux`.
For recurring bounded automation loops, use `heartbeats`.
For wall-clock schedules (one-shot, interval, cron-expression), use `crons`.

## Evaluation scenarios

1. **Bounded investigation before mutation**
   - Prompt: user asks for status + targeted change.
   - Expected: gather scoped evidence first (`mu status`, `issues`, `forum`, `memory`/`events`), then perform minimal write and verify post-state.

2. **Control-plane diagnostics loop**
   - Prompt: messaging channel stopped responding.
   - Expected: inspect `mu control status`, `harness`, identities, adapter audit/outbox logs; then apply smallest reversible fix (`config set`, relink, `reload`) and verify.

3. **Session continuity + scope-safe config**
   - Prompt: continue prior operator thread with model/thinking tweaks.
   - Expected: use `mu session list` + `mu session <id>`/`mu turn`; when needed, apply `mu session config ...` (session-scoped) instead of mutating global defaults.

## Escalation map

- Historical context retrieval and index maintenance: **`memory`**
- Planning/decomposition and DAG review: **`planning`**
- HUD contract/state updates across surfaces: **`hud`**
- Shared DAG semantics for planning + execution: **`protocol`**
- Loop/termination policy overlays (review gates, retries, escalation): **`control-flow`**
- Per-issue model/provider/thinking selection overlays: **`model-routing`**
- Live REPL execution and context engineering via tmux: **`code-mode`**
- Persistent tmux session management + worker fan-out primitives: **`tmux`**
- Durable multi-agent orchestration: **`execution`**
- Recurring bounded automation scheduling: **`heartbeats`**
- Wall-clock scheduling workflows: **`crons`**
- Messaging adapter onboarding:
  - **`setup-slack`**
  - **`setup-discord`**
  - **`setup-telegram`**
  - **`setup-neovim`**
- Technical writing/docs polish: **`writing`**
