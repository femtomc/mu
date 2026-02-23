---
name: mu
description: "Use this when you need core mu operator workflow guidance for bounded investigation, CLI-first state operations, and session handoffs."
---

# mu

Use this skill for day-to-day operator work in `mu`: inspect state, mutate state safely,
run focused execution loops, and hand off to specialized skills when needed.

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

When work is multi-step and issue-graph driven, use `subagents`.
When work is planning/decomposition with explicit approval loops, use `planning`.

## Escalation map

- Planning/decomposition and DAG review: **`planning`**
- Durable multi-agent orchestration: **`subagents`**
- Messaging adapter onboarding:
  - **`setup-slack`**
  - **`setup-discord`**
  - **`setup-telegram`**
  - **`setup-neovim`**
