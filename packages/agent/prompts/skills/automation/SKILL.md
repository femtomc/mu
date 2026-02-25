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

## Common patterns

- **Durable Orchestration**: Create a heartbeat (`heartbeats`) that runs one bounded `execution` pass per tick to supervise a `subagents` DAG over time, keeping the main chat clear.
- **Scheduled Maintenance / Memory Update**: Set up a cron job (`crons`) to periodically invoke `memory` to rebuild indexes, fetch new docs, or clean up obsolete logs on a schedule.
- **Continuous Diagnostics**: A heartbeat that periodically tails application logs or runs bounded check scripts locally. If a failure condition is met, the wake loop exits cleanly and notifies the user via the active channel.
