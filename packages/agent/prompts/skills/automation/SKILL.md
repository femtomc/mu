---
name: automation
description: "Meta-skill for durable and wall-clock automation. Routes to heartbeats and crons for recurring execution control."
---

# automation

Use this meta-skill when the user wants recurring automation, scheduled execution, or scheduler diagnostics.

## Subskills

- `heartbeats` — durable wake-loop programs that run one bounded pass per tick.
- `crons` — wall-clock scheduling (`at`, `every`, cron expressions) and lifecycle control.

## Selection guide

1. Use `heartbeats` for state-driven wake loops and short recurring supervision.
2. Use `crons` for explicit wall-clock schedules and calendar-style timing.
3. Pair automation with `subagents` stack skills (`protocol`, `execution`, etc.) when the workload is issue-DAG driven.
