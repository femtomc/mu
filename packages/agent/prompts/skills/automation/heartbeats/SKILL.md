---
name: heartbeats
description: "Runs heartbeat-program lifecycle workflows for durable operator wake loops, bounded tick prompts, and diagnostics. Use when scheduling, tuning, or repairing recurring automation."
---

# heartbeats

Use this skill when the user asks to schedule, inspect, tune, or debug `mu heartbeats` automation.

## Contents

- [Core contract](#core-contract)
- [Preflight checks](#preflight-checks)
- [Heartbeat lifecycle workflow](#heartbeat-lifecycle-workflow)
- [Prompt design for bounded ticks](#prompt-design-for-bounded-ticks)
- [Reusable status-voice snippet](#reusable-status-voice-snippet)
- [Diagnostics and recovery](#diagnostics-and-recovery)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

1. **One bounded pass per wake**
   - Heartbeats should run one small control-loop pass, verify, and exit.
   - Avoid unbounded prompts that try to complete an entire project in one wake.

2. **CLI-first lifecycle control**
   - Create/update/trigger/enable/disable via `mu heartbeats ...` commands.
   - Do not hand-edit `heartbeats.jsonl`.

3. **Read -> mutate -> verify**
   - Inspect current heartbeat state first.
   - After mutation, re-read with `list/get` and run a trigger smoke test.

4. **Reason-coded automation**
   - Use clear `--reason` values so wake and scheduler intent is auditable.

## Preflight checks

```bash
mu status --pretty
mu control status --pretty
mu control identities --all --pretty
mu heartbeats list --limit 20 --pretty
```

If user expects channel delivery (for example Telegram/Slack), verify operator identities
are linked for the target channel before treating heartbeat execution as broken.

## Heartbeat lifecycle workflow

### 1) Inspect existing programs

```bash
mu heartbeats list --limit 20 --pretty
mu heartbeats get <program-id> --pretty
```

Use `--json --pretty` when you need full records.

### 2) Create a periodic heartbeat

```bash
mu heartbeats create \
  --title "<descriptive title>" \
  --prompt "<bounded control-loop instruction>" \
  --every-ms 15000 \
  --reason <reason_code>
```

Notes:
- Omit `--every-ms` to use the default cadence (15000ms).
- `--every-ms 0` creates event-driven mode (no periodic timer).

### 3) Update cadence/prompt/enabled state

```bash
mu heartbeats update <program-id> --every-ms 300000
mu heartbeats update <program-id> --prompt "<revised bounded instruction>"
mu heartbeats enable <program-id>
mu heartbeats disable <program-id>
```

### 4) Trigger smoke pass

```bash
mu heartbeats trigger <program-id> --reason smoke_test
```

Then verify state and recent effects:

```bash
mu heartbeats get <program-id> --pretty
mu store tail events --limit 30 --pretty
mu store tail cp_operator_turns --limit 30 --pretty
```

### 5) Remove obsolete programs

```bash
mu heartbeats delete <program-id>
```

## Prompt design for bounded ticks

Use prompts that explicitly constrain each wake to one bounded pass.

Good pattern:
- inspect queue/state
- do exactly one action
- verify
- report project-level progress as a titled status note plus a concise narrative paragraph
- narrative should cover project context, what milestone moved, impact, overall progress, and next step
- keep low-level queue/worker internals out of default reporting; include them only for blocker/anomaly diagnosis
- exit

Example bounded prompt:

```text
Review issues under root <root-id>. Perform exactly one bounded orchestration step,
verify state, then report for a human as:
- a short title that summarizes status
- one concise paragraph: project context, what moved this pass, impact,
  where the project stands overall, and what comes next
Only include queue/worker details if diagnosing a blocker/anomaly.
Then exit.
```

## Reusable status-voice snippet

Use this copy/paste block in heartbeat prompts when updates should be written for
non-operator humans:

```text
Write the update as a short status note for a human reader.
- First line: a plain-language title that captures the status.
- Then one concise paragraph explaining:
  - what this project is trying to achieve,
  - what meaningful milestone moved in this pass,
  - what impact that creates (or what precondition was completed),
  - where the overall project stands,
  - what comes next and why it matters.
Avoid low-level orchestration internals by default (queue snapshots, worker/session IDs,
packet mechanics, raw issue-ID lists). Include them only when diagnosing a blocker/anomaly.
```

For hierarchical DAG execution, pair this skill with:
- `planning`
- `protocol`
- `control-flow` (when explicit loop/termination policy is required)
- `model-routing` (when per-issue model/provider/thinking policy is required)
- `execution`

For wall-clock scheduling semantics (`at`, `every`, `cron`), use `crons`.

## Diagnostics and recovery

If heartbeat automation appears stalled:

1. Confirm program exists and is enabled:

```bash
mu heartbeats list --enabled true --limit 50 --pretty
mu heartbeats get <program-id> --pretty
```

2. Force a manual trigger to isolate scheduler cadence issues:

```bash
mu heartbeats trigger <program-id> --reason manual_recovery_test
```

3. Inspect runtime artifacts:

```bash
mu store tail heartbeats --limit 20 --pretty
mu store tail events --limit 50 --pretty
mu store tail cp_operator_turns --limit 50 --pretty
mu store tail cp_outbox --limit 30 --pretty
```

4. Apply smallest recovery action:
- tighten or loosen `--every-ms`
- simplify prompt scope
- disable noisy/obsolete programs
- relink channel identity when delivery is missing

## Evaluation scenarios

1. **Periodic progress heartbeat**
   - Setup: heartbeat created with bounded control-loop prompt and `--every-ms 15000`.
   - Expected: each wake performs one bounded pass, emits a high-level titled narrative status update, and exits; no unbounded run behavior.

2. **Event-driven heartbeat mode**
   - Setup: heartbeat created/updated with `--every-ms 0`.
   - Expected: no periodic timer firing; manual/explicit triggers still execute correctly.

3. **Stall recovery via trigger + audit**
   - Setup: user reports no visible progress from heartbeat.
   - Expected: manual trigger works, events/operator-turn logs reveal root cause, and one minimal config change resolves progression.
