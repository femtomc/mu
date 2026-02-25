---
name: execution
description: "Runs issue-driven execution supervision with heartbeat orchestration and tmux fan-out. Use when work should progress through durable parallel execution loops."
---

# execution

## Contents

- [Purpose (what this skill is for)](#purpose-what-this-skill-is-for)
- [Shared protocol dependency](#shared-protocol-dependency)
- [Control-flow dependency](#control-flow-dependency)
- [Model-routing dependency](#model-routing-dependency)
- [Model quality defaults for orchestration](#model-quality-defaults-for-orchestration)
- [HUD skill dependency](#hud-skill-dependency)
- [tmux skill dependency](#tmux-skill-dependency)
- [When to use](#when-to-use)
- [Success condition](#success-condition)
- [Dispatch modes](#dispatch-modes)
- [Orchestration loops](#orchestration-loops)
- [Bootstrap and queue targeting](#bootstrap-and-queue-targeting)
- [Dispatch templates](#dispatch-templates)
- [Execution HUD (subagents profile)](#execution-hud-subagents-profile)
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

This skill executes DAG work defined by **`protocol`**.

Before execution begins, load that skill and enforce:

- Protocol ID/tag: `hierarchical-work.protocol/v1` + `proto:hierarchical-work-v1`
- Canonical node kinds, context tags, and invariants
- Primitive semantics (`read_tree`, `claim`, `spawn`, `fork`, `ask`, `expand`, `complete`, `serial`)

Do not run subagent orchestration against alternate protocol tags.

## Control-flow dependency

When a subtree declares explicit loop/termination policy (for example
`flow:review-gated-v1`), load **`control-flow`** and apply policy transitions as
an overlay on orchestration primitives.

- Keep DAG structure protocol-valid (`protocol` remains source-of-truth).
- Compile control-flow decisions into protocol primitives (`spawn`, `expand`,
  `ask`, `complete`, `serial`), not ad-hoc mutations.

## Model-routing dependency

When a subtree declares per-issue model/provider/thinking policy (for example
`route:model-routing-v1`), load **`model-routing`** and apply routing transitions
as an overlay on orchestration primitives.

- Keep DAG structure protocol-valid (`protocol` remains source-of-truth).
- Drive recommendations from live harness capabilities (`mu control harness --json`).
- Apply route selections with per-turn/per-session overrides (`mu exec`/`mu turn`
  `--provider --model --thinking`) instead of mutating workspace-global defaults.
- Emit auditable route packets (`ROUTE_RECOMMENDATION`, `ROUTE_FALLBACK`,
  `ROUTE_DEGRADED`) in forum topics.

## Model quality defaults for orchestration

When executing protocol/runtime/schema/cross-adapter DAGs, enforce an explicit
high-quality model profile unless the user overrides it.

Default high-quality profile:

- provider: `openai-codex`
- model: `gpt-5.3-codex`
- thinking: `xhigh`

Operational rules:

1. Worker launches must pass explicit `--provider --model --thinking`.
2. Do not use mini/fast profiles for close/validate/signoff passes.
3. If you must downgrade, post a `ROUTE_FALLBACK` packet with rationale and
   expected risk/tradeoff before continuing.
4. Keep profile policy in `model-routing` (`ROUTE_POLICY`) so skills can update
   behavior without extension-code changes.
5. Helper shell workflows must fail fast with actionable usage text whenever
   required provider/model/thinking args are missing.

## HUD skill dependency

Before emitting or mutating subagent HUD state, load **`hud`** and follow its canonical contract.
HUD usage is not optional for this skill.

- Treat `hud` as source-of-truth for generic `mu_hud` actions, `HudDoc` shape, and rendering constraints.
- This execution skill defines orchestration-specific conventions only (for example `hud_id: "subagents"`, queue/activity semantics).

## tmux skill dependency

Before spawning/inspecting worker sessions, load **`tmux`** and follow its
canonical session lifecycle and bounded send/capture protocol.

- Treat `tmux` as source-of-truth for session ownership, completion markers, and teardown.
- This execution skill defines orchestration semantics and queue policy.

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

2. Choose exactly one action/primitive from `protocol`.
3. Apply it.
4. Verify (`get`, `children`, `ready`, `validate`).
5. Update `hud_id:"subagents"` (required) and emit a compact snapshot.
6. Post a human-facing `ORCH_PASS` update to forum:
   - start with a short title that captures status in plain language
   - follow with one concise paragraph covering: project objective context, milestone moved this pass, impact, overall progress, and next high-level step
   - include queue/worker/drift internals only when diagnosing blocker/anomaly.
7. Exit tick.

Stop automation when `mu issues validate <root-id>` returns final.

### Worker issue loop (single issue pass)

For claimed issue `<issue-id>` under `<root-id>`:

1. Run `read_tree`.
2. Choose one primitive:
   - route policy present and no valid route decision -> apply one `model-routing` transition
   - missing input -> `ask`
   - needs decomposition -> `expand`
   - directly solvable -> `complete`
3. Apply primitive.
4. Verify state.
5. Post progress to `issue:<issue-id>` focused on deliverable status, capability impact, and next step.

Repeat bounded passes until issue closes.

## Bootstrap and queue targeting

If root DAG does not yet exist, create it using the
`protocol` bootstrap template first.

During orchestration, always scope queue reads with protocol tag:

```bash
mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty
```

## Dispatch templates

### A) Heartbeat autopilot (preferred for supervision)

```bash
root_id="${1:-}"
provider="${2:-}"
model="${3:-}"
thinking="${4:-}"

if [ -z "$root_id" ] || [ -z "$provider" ] || [ -z "$model" ] || [ -z "$thinking" ]; then
  cat >&2 <<'USAGE'
usage: ./orch-heartbeat.sh <root-id> <provider> <model> <thinking>
example: ./orch-heartbeat.sh mu-4be265df openai-codex gpt-5.3-codex xhigh
USAGE
  exit 64
fi

mu heartbeats create \
  --title "hierarchical-work-v1 ${root_id}" \
  --reason orchestration_v1 \
  --every-ms 15000 \
  --prompt "Use skills subagents, protocol, execution, control-flow, model-routing, and hud for root ${root_id}. Run exactly one bounded orchestration pass: inspect the proto:hierarchical-work-v1 queue, perform exactly one corrective orchestration action (including in_progress-without-worker drift recovery) or claim/work-start one ready issue, then verify state. If flow:* policy tags are present, apply one control-flow transition from the control-flow skill in this pass. If route:* policy tags are present, apply one model-routing transition from the model-routing skill in this pass using live `mu control harness` capabilities and per-turn provider/model/thinking overrides. If route:* policy tags are absent, use the high-quality orchestration profile (openai-codex / gpt-5.3-codex / xhigh) for any execution launch in this pass. Any execution launch in this pass must pass explicit overrides: --provider ${provider} --model ${model} --thinking ${thinking}; if this tuple cannot be used, stop and post BLOCKED with remediation options. Report human-facing progress as a titled status note plus one concise paragraph that explains project context, milestone moved, impact, overall progress, and next high-level step; avoid low-level orchestration internals unless diagnosing a blocker/anomaly. Post a matching ORCH_PASS update to issue:${root_id}. Stop when 'mu issues validate ${root_id}' is final."
```

Reusable status-voice add-on for heartbeat prompts (copy/paste):

```text
Write each ORCH_PASS as a human status note, not operator telemetry.
Use a short plain-language title + one concise paragraph covering:
project objective, milestone moved this pass, impact/precondition,
overall progress, and next high-level step.
Keep queue/worker/session internals out unless diagnosing a blocker.
```

### B) tmux fan-out (parallel workers)

```bash
root_id="${1:-}"
provider="${2:-}"
model="${3:-}"
thinking="${4:-}"
limit="${5:-3}"

if [ -z "$root_id" ] || [ -z "$provider" ] || [ -z "$model" ] || [ -z "$thinking" ]; then
  cat >&2 <<'USAGE'
usage: ./orch-fanout.sh <root-id> <provider> <model> <thinking> [limit]
example: ./orch-fanout.sh mu-4be265df openai-codex gpt-5.3-codex xhigh 3
USAGE
  exit 64
fi

run_id="$(date +%Y%m%d-%H%M%S)"
for issue_id in $(mu issues ready --root "$root_id" --tag proto:hierarchical-work-v1 --json | jq -r '.[].id' | head -n "$limit"); do
  session="mu-sub-${run_id}-${issue_id}"
  tmux new-session -d -s "$session" \
    "cd '$PWD' && mu exec --provider '$provider' --model '$model' --thinking '$thinking' 'Use skills subagents, protocol, execution, control-flow, model-routing, and hud. Work issue ${issue_id} using hierarchical-work.protocol/v1. If flow:* policy tags are present, apply the control-flow overlay before selecting the next primitive. If route:* policy tags are present, apply the model-routing overlay using live harness capabilities before selecting the next primitive. Claim first, then run one full control loop.' ; rc=\$?; echo __MU_DONE__:\$rc"
done
```

## Execution HUD (subagents profile)

HUD usage is required for this skill. Truth still lives in issues/forum.

```text
/mu hud on
/mu hud status
/mu hud snapshot
```

Tool: `mu_hud`

- Canonical contract: see skill `hud`
- Actions: `status`, `snapshot`, `on`, `off`, `toggle`, `set`, `update`, `replace`, `remove`, `clear`
- Subagents convention: maintain a HUD doc with `hud_id: "subagents"`
- Suggested subagents doc structure:
  - chips: health, mode, paused
  - sections: queue counts + recent activity lines
  - actions: refresh/spawn command hooks (if desired)
  - metadata: include `style_preset:"subagents"` for consistent renderer emphasis
- Example update:
  - `{"action":"set", "doc": {"hud_id":"subagents", ...}}` (see `hud` skill for exact shape)
- Follow the HUD ownership and teardown protocol from `hud` skill for completion and handoff.

## Evaluation scenarios

1. **Heartbeat bounded-orchestration tick**
   - Setup: root issue with multiple ready leaves tagged `proto:hierarchical-work-v1`.
   - Expected: one heartbeat tick performs exactly one bounded orchestration action, verifies state, posts a high-level titled narrative status update, and exits.

2. **tmux fan-out on ready leaves**
   - Setup: at least three independent ready issues under one root.
   - Expected: one worker session per issue is spawned, each worker claims before work, and each writes `START`/`RESULT` packets to `issue:<id>`.

3. **Human-question blocking flow (`ask`)**
   - Setup: worker encounters missing critical input.
   - Expected: skill applies protocol `ask` semantics, creates a human-input node, and downstream work remains blocked until the answer issue closes.

4. **Model-routing overlay with fallback**
   - Setup: ready issue tagged `route:model-routing-v1` and selected model fails at launch.
   - Expected: one bounded pass emits `ROUTE_FALLBACK`, selects alternate/provider fallback deterministically, and continues execution without violating DAG protocol rules.

## Reconciliation

- Run `mu issues validate <root-id>` before declaring completion.
- Merge synth-node outputs into one final user-facing result.
- Convert unresolved gaps into new child issues tagged `proto:hierarchical-work-v1`.
- Tear down temporary tmux sessions.
- Tear down/handoff `hud_id:"subagents"` ownership following the `hud` skill protocol.

## Safety

- Prefer small, reversible child issues.
- Keep child prompts explicit about deliverables + acceptance criteria.
- Pause spawning while queue semantics are unclear.
- Never overwrite unrelated files across shards.
