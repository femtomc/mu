---
name: subagents
description: "Orchestrates issue-driven subagent execution with heartbeat supervision and tmux fan-out. Use when work should progress through durable parallel subagent loops."
---

# Subagents

## Contents

- [Purpose (what this skill is for)](#purpose-what-this-skill-is-for)
- [Shared protocol dependency](#shared-protocol-dependency)
- [When to use](#when-to-use)
- [Success condition](#success-condition)
- [Dispatch modes](#dispatch-modes)
- [Orchestration loops](#orchestration-loops)
- [Bootstrap and queue targeting](#bootstrap-and-queue-targeting)
- [Dispatch templates](#dispatch-templates)
- [Subagents HUD](#subagents-hud)
- [Evaluation scenarios](#evaluation-scenarios)
- [Reconciliation](#reconciliation)
- [Safety](#safety)

## Purpose (what this skill is for)

Use this skill for **durable multi-agent orchestration**: work that must keep moving
over time, not just one-shot execution.

This skill is execution-supervision focused:

- `mu heartbeats` / `mu cron` = orchestrator wake cadence
- `tmux` + `mu exec` = parallel worker execution
- subagents HUD = operator observability/control board

Source of truth remains in `mu issues` + `mu forum`.

## Shared protocol dependency

This skill executes DAG work defined by **`hierarchical-work-protocol`**.

Before orchestration begins, load that skill and enforce:

- Protocol ID/tag: `hierarchical-work.protocol/v1` + `proto:hierarchical-work-v1`
- Canonical node kinds, context tags, and invariants
- Primitive semantics (`read_tree`, `claim`, `spawn`, `fork`, `ask`, `expand`, `complete`, `serial`)

Do not run subagent orchestration against alternate protocol tags.

## When to use

- Work is represented as issue-scoped deliverables with explicit outcomes.
- Dependencies may unblock over time.
- You want unattended progress between manual check-ins.

## Success condition

- Each executable issue is claimed, worked, and closed with an explicit outcome.
- Results are posted in `issue:<id>` forum topics.
- Root completion is validated via `mu issues validate <root-id>`.

## Dispatch modes

### 1) Heartbeat dispatch (orchestrator cadence)

Use when you want orchestration to continue over time.

Each heartbeat tick runs **one bounded orchestration pass**:

1. Read queue/tree state.
2. Select one protocol primitive/action.
3. Apply one bounded action.
4. Verify state + log progress.
5. Exit.

Heartbeat dispatch is the orchestrator clock. It should supervise/advance the graph,
not run unbounded worker sessions.

### 2) tmux dispatch (parallel workers)

Use when several ready leaves should execute concurrently now.

Spawn one tmux session per ready issue. Each worker claims one issue, executes one
full issue loop, then exits.

## Orchestration loops

### Orchestrator heartbeat tick loop

For root `<root-id>`:

1. Inspect queue and local protocol state:

```bash
mu issues get <root-id> --pretty
mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty
mu forum read issue:<root-id> --limit 20 --pretty
```

2. Choose exactly one action/primitive from `hierarchical-work-protocol`.
3. Apply it.
4. Verify (`get`, `children`, `ready`, `validate`).
5. Post concise progress to forum.
6. Exit tick.

Stop automation when `mu issues validate <root-id>` returns final.

### Worker issue loop (single issue pass)

For claimed issue `<issue-id>` under `<root-id>`:

1. Run `read_tree`.
2. Choose one primitive:
   - missing input -> `ask`
   - needs decomposition -> `expand`
   - directly solvable -> `complete`
3. Apply primitive.
4. Verify state.
5. Post concise progress to `issue:<issue-id>`.

Repeat bounded passes until issue closes.

## Bootstrap and queue targeting

If root DAG does not yet exist, create it using the
`hierarchical-work-protocol` bootstrap template first.

During orchestration, always scope queue reads with protocol tag:

```bash
mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty
```

## Dispatch templates

### A) Heartbeat autopilot (preferred for supervision)

```bash
mu heartbeats create \
  --title "hierarchical-work-v1 <root-id>" \
  --reason hierarchical_work_protocol_v1 \
  --every-ms 15000 \
  --prompt "Use skills subagents and hierarchical-work-protocol for root <root-id>. Run exactly one bounded orchestration pass: claim/work one ready proto:hierarchical-work-v1 issue (or perform one orchestration action), verify state, and report status. Stop when 'mu issues validate <root-id>' is final."
```

### B) tmux fan-out (parallel workers)

```bash
run_id="$(date +%Y%m%d-%H%M%S)"
for issue_id in $(mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --json | jq -r '.[].id' | head -n 3); do
  session="mu-sub-${run_id}-${issue_id}"
  tmux new-session -d -s "$session" \
    "cd '$PWD' && mu exec 'Use skills subagents and hierarchical-work-protocol. Work issue ${issue_id} using hierarchical-work.protocol/v1. Claim first, then run one full control loop.' ; rc=\$?; echo __MU_DONE__:\$rc"
done
```

## Subagents HUD

Use HUD for user visibility. Truth still lives in issues/forum.

```text
/mu subagents on
/mu subagents prefix mu-sub-
/mu subagents root <root-id>
/mu subagents tag proto:hierarchical-work-v1
/mu subagents mode operator
/mu subagents refresh
/mu subagents snapshot
```

Tool: `mu_subagents_hud`

- Actions: `status`, `snapshot`, `on`, `off`, `toggle`, `refresh`,
  `set_prefix`, `set_root`, `set_tag`, `set_mode`, `set_refresh_interval`,
  `set_stale_after`, `set_spawn_paused`, `update`, `spawn`

## Evaluation scenarios

1. **Heartbeat bounded-orchestration tick**
   - Setup: root issue with multiple ready leaves tagged `proto:hierarchical-work-v1`.
   - Expected: one heartbeat tick performs exactly one bounded orchestration action, verifies state, posts concise progress, and exits.

2. **tmux fan-out on ready leaves**
   - Setup: at least three independent ready issues under one root.
   - Expected: one worker session per issue is spawned, each worker claims before work, and each writes `START`/`RESULT` packets to `issue:<id>`.

3. **Human-question blocking flow (`ask`)**
   - Setup: worker encounters missing critical input.
   - Expected: skill applies protocol `ask` semantics, creates a human-input node, and downstream work remains blocked until the answer issue closes.

## Reconciliation

- Run `mu issues validate <root-id>` before declaring completion.
- Merge synth-node outputs into one final user-facing result.
- Convert unresolved gaps into new child issues tagged `proto:hierarchical-work-v1`.
- Tear down temporary tmux sessions.

## Safety

- Prefer small, reversible child issues.
- Keep child prompts explicit about deliverables + acceptance criteria.
- Pause spawning while queue semantics are unclear.
- Never overwrite unrelated files across shards.
