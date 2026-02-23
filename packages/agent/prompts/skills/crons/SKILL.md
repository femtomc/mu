---
name: crons
description: "Runs cron-program lifecycle workflows for wall-clock scheduling, recurring automation, and scheduler diagnostics. Use when creating, tuning, or repairing time-based automation."
---

# crons

Use this skill when the user asks to schedule, inspect, tune, or debug `mu cron` automation.

## Contents

- [Core contract](#core-contract)
- [Preflight checks](#preflight-checks)
- [Schedule kinds](#schedule-kinds)
- [Cron lifecycle workflow](#cron-lifecycle-workflow)
- [Prompt design for scheduled runs](#prompt-design-for-scheduled-runs)
- [Diagnostics and recovery](#diagnostics-and-recovery)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

1. **Use explicit schedule semantics**
   - Choose the right schedule kind (`at`, `every`, or `cron`) instead of overloading one pattern.
   - Keep schedule intent readable in `title` and `reason` fields.

2. **CLI-first lifecycle control**
   - Create/update/trigger/enable/disable/delete via `mu cron ...` commands.
   - Do not hand-edit `cron.jsonl`.

3. **Bounded execution prompts**
   - Scheduled runs should execute one bounded control-loop pass and exit.
   - Avoid prompts that imply unbounded autonomous execution.

4. **Read -> mutate -> verify**
   - Inspect scheduler/program state first.
   - After changes, re-read and trigger a smoke run.

## Preflight checks

```bash
mu status --pretty
mu control status --pretty
mu control identities --all --pretty
mu cron stats --pretty
mu cron list --limit 20 --pretty
```

If user expects channel delivery, verify linked operator identity for that channel
before diagnosing cron execution as broken.

## Schedule kinds

1. **One-shot (`at`)**
   - Run once at an absolute time.
   - Flags: `--schedule-kind at --at <iso8601>` (or `--at-ms <epoch-ms>`)

2. **Fixed interval (`every`)**
   - Run repeatedly on fixed millisecond cadence.
   - Flags: `--schedule-kind every --every-ms <ms>`
   - Optional alignment: `--anchor-ms <epoch-ms>`

3. **Cron expression (`cron`)**
   - Run by cron expression.
   - Flags: `--schedule-kind cron --expr "<cron-expr>" --tz <timezone>`

## Cron lifecycle workflow

### 1) Inspect scheduler and programs

```bash
mu cron stats --pretty
mu cron list --limit 20 --pretty
mu cron get <program-id> --pretty
```

Use `--json --pretty` for full records.

### 2) Create a cron program

One-shot example:

```bash
mu cron create \
  --title "One-shot audit" \
  --schedule-kind at \
  --at 2026-02-22T02:00:00Z \
  --reason oneshot_audit
```

Fixed interval example:

```bash
mu cron create \
  --title "Every 10m check" \
  --schedule-kind every \
  --every-ms 600000 \
  --reason periodic_check
```

Cron-expression example:

```bash
mu cron create \
  --title "Nightly maintenance" \
  --schedule-kind cron \
  --expr "0 2 * * *" \
  --tz UTC \
  --reason nightly_maintenance
```

### 3) Update schedule or enablement

```bash
mu cron update <program-id> --enabled false
mu cron update <program-id> --schedule-kind every --every-ms 300000
mu cron update <program-id> --schedule-kind cron --expr "0 3 * * *" --tz UTC
mu cron enable <program-id>
mu cron disable <program-id>
```

### 4) Trigger smoke run

```bash
mu cron trigger <program-id> --reason smoke_test
```

Then verify:

```bash
mu cron get <program-id> --pretty
mu store tail events --limit 40 --pretty
mu store tail cp_operator_turns --limit 40 --pretty
```

### 5) Delete obsolete programs

```bash
mu cron delete <program-id>
```

## Prompt design for scheduled runs

Use concise prompts with explicit bounded-pass behavior.

Example:

```text
Review open issues for root <root-id>. Perform exactly one bounded step:
select one ready task (or report blocked), apply one action, verify state,
post concise summary, then exit.
```

For DAG execution workloads, combine with:
- `planning`
- `hierarchical-work-protocol`
- `subagents`
- `heartbeats` (for short-cadence wake loops)

## Diagnostics and recovery

When cron automation appears stalled or misfiring:

1. Confirm scheduler + program state:

```bash
mu cron stats --pretty
mu cron list --enabled true --limit 50 --pretty
mu cron get <program-id> --pretty
```

2. Trigger manually to separate scheduler timing issues from execution issues:

```bash
mu cron trigger <program-id> --reason manual_recovery_test
```

3. Inspect runtime evidence:

```bash
mu store tail events --limit 60 --pretty
mu store tail cp_operator_turns --limit 60 --pretty
mu store tail cp_outbox --limit 40 --pretty
```

4. Apply smallest recovery step:
- fix schedule-kind/flags mismatch
- correct timezone (`--tz`)
- simplify prompt scope
- toggle enablement (`disable` -> `enable`)
- relink channel identity if delivery is absent

## Evaluation scenarios

1. **One-shot schedule execution (`at`)**
   - Setup: `mu cron create --schedule-kind at --at <future-iso>`.
   - Expected: program executes once, records deterministic status, then does not re-fire.

2. **Interval schedule retune (`every`)**
   - Setup: active interval schedule at 10m.
   - Expected: `mu cron update ... --every-ms 300000` changes cadence to 5m without recreating program ID.

3. **Cron expression + timezone correctness**
   - Setup: cron expression schedule with explicit timezone.
   - Expected: next-run alignment matches timezone expectations; manual trigger succeeds and logs are auditable.
