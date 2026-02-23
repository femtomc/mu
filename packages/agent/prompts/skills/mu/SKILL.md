---
name: mu
description: "Runs core mu operator workflows for bounded investigation, CLI-first state operations, and session handoffs. Use when general mu execution or state-management guidance is needed."
---

# mu

Use this skill for day-to-day operator work in `mu`: inspect state, mutate state safely,
run focused execution loops, and hand off to specialized skills when needed.

## Contents

- [Core contract](#core-contract)
- [Default bounded investigation loop](#default-bounded-investigation-loop)
- [Common mutation patterns](#common-mutation-patterns)
- [Session and serve surfaces](#session-and-serve-surfaces)
- [Durable automation handoff](#durable-automation-handoff)
- [Evaluation scenarios](#evaluation-scenarios)
- [Escalation map](#escalation-map)

## Core contract

1. **Investigate first**
   - Prefer cheap evidence over assumptions.
   - Start with bounded queries (`--limit`, scoped filters), then drill into specific entities.

2. **CLI-first state operations**
   - Read/mutate `issues`, `forum`, `memory`, and `control-plane` via `mu` CLI commands.
   - Avoid hand-editing JSONL runtime journals for normal operations.

3. **Read -> act -> verify loop**
   - Before writes: inspect relevant current state.
   - After writes: re-read to confirm effect.

4. **Keep work reversible and explicit**
   - Prefer small, composable steps.
   - State assumptions and blockers clearly.

## Default bounded investigation loop

```bash
mu status --pretty
mu issues list --status open --limit 20 --pretty
mu issues ready --limit 20 --pretty
mu forum read user:context --limit 20 --pretty
mu memory search --query "<topic>" --limit 20
mu store tail events --limit 20 --pretty
```

Then inspect concrete targets:

```bash
mu issues get <id> --pretty
mu forum read issue:<id> --limit 20 --pretty
```

## Common mutation patterns

Issue/forum lifecycle:

```bash
mu issues update <id> --status in_progress --pretty
mu forum post issue:<id> -m "START: <plan>" --author operator
mu forum post issue:<id> -m "RESULT: <summary>" --author operator
mu issues close <id> --outcome success --pretty
```

Control-plane lifecycle:

```bash
mu control status --pretty
mu control identities --all --pretty
mu control reload
```

Store forensics:

```bash
mu store ls --pretty
mu store tail cp_commands --limit 20 --pretty
mu store tail cp_outbox --limit 20 --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
```

## Session and serve surfaces

Primary interactive surface:

```bash
mu serve
```

Session follow-ups/handoffs:

```bash
mu session list --json --pretty
mu session <session-id>
mu turn --session-kind operator --session-id <session-id> --body "<follow-up>"
```

In attached terminal operator chat, `/mu` helpers are available (`/mu events`, `/mu plan`, `/mu subagents`, `/mu help`).

## Durable automation handoff

Use heartbeat/cron programs for recurring or unattended progression:

```bash
mu heartbeats --help
mu cron --help
```

When work is multi-step and issue-graph driven, use `planning` to shape the DAG,
then `hierarchical-work-protocol` to keep DAG semantics consistent, then
`subagents` for durable execution.
For recurring bounded automation loops, use `heartbeats`.
For wall-clock schedules (one-shot, interval, cron-expression), use `crons`.

## Evaluation scenarios

1. **Bounded investigation before mutation**
   - Prompt: user asks for status + targeted change.
   - Expected: skill gathers scoped evidence first (`mu status`, `issues`, `forum`, `memory`), then performs minimal write and verifies post-state.

2. **Control-plane diagnostics loop**
   - Prompt: user reports messaging channel stopped responding.
   - Expected: skill inspects `mu control status`, identities, and adapter audit/outbox logs, then proposes smallest reversible recovery step (`reload`, relink, or config fix).

3. **Session handoff continuity**
   - Prompt: user asks to continue prior operator thread.
   - Expected: skill inspects `mu session list`, resumes by ID, and keeps follow-up actions scoped to the resumed session context.

## Escalation map

- Historical context retrieval and index maintenance: **`memory`**
- Planning/decomposition and DAG review: **`planning`**
- Shared DAG semantics for planning + execution: **`hierarchical-work-protocol`**
- Durable multi-agent orchestration: **`subagents`**
- Recurring bounded automation scheduling: **`heartbeats`**
- Wall-clock scheduling workflows: **`crons`**
- Messaging adapter onboarding:
  - **`setup-slack`**
  - **`setup-discord`**
  - **`setup-telegram`**
  - **`setup-neovim`**
