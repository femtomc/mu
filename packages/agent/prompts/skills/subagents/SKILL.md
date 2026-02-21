---
name: subagents
description: Orchestrate issue-driven subagent work with heartbeat supervision and tmux worker fan-out.
---

# Subagents

## Purpose (what this skill is for)

Use this skill for **durable multi-agent orchestration**: work that must keep moving over time, not just one-shot execution.

This skill combines `mu` primitives into one orchestration model:

- `mu issues` = executable DAG, dependencies, lifecycle state
- `mu forum` = durable task/result packets
- `mu heartbeats` / `mu cron` = orchestrator wake cadence
- `tmux` + `mu exec` = parallel worker execution
- subagents HUD = observability/control board

Protocol truth lives in **issues + forum**. HUD/tmux are execution and visibility surfaces.

## When to use

- Work can be represented as issue-scoped deliverables with explicit outcomes.
- Dependencies may unblock over time.
- You want unattended progress between manual check-ins.

## Success condition

- Each executable issue is claimed, worked, and closed with an explicit outcome.
- Results are posted in `issue:<id>` forum topics.
- Root completion is validated via `mu issues validate <root-id>`.

## Dispatch modes

### 1) Heartbeat dispatch (orchestrator cadence)

Use when you want the orchestration loop to keep running over time.

Each heartbeat tick should run **one bounded control-loop pass**:

1. Read queue/tree state.
2. Choose one primitive (`ask`, `expand`, `complete`, etc.).
3. Apply one action.
4. Verify state + log progress.
5. Exit.

Heartbeat dispatch is the **orchestrator clock**. It should supervise/advance the graph, not run unbounded worker sessions.

### 2) tmux dispatch (parallel workers)

Use when multiple ready leaves should execute concurrently now.

Spawn one tmux session per ready issue. Each worker should claim one issue, run one full issue loop, then exit.

## Protocol: `subagents.protocol/v1` (how the skill executes)

### Primitive: `read_tree`

Before every mutation, inspect root + local node state:

```bash
mu issues get <issue-id> --pretty
mu issues children <issue-id> --pretty
mu issues ready --root <root-id> --tag proto:subagents-v1 --pretty
mu forum read issue:<issue-id> --limit 20 --pretty
```

### Primitive: `claim`

Claim before doing work on an executable issue:

```bash
mu issues claim <issue-id>
mu forum post issue:<issue-id> -m "START: <plan for this pass>" --author operator
```

### Primitive: `spawn` (clean-context child)

Create independent child tasks with scoped context:

```bash
child_json="$(mu issues create "<title>" \
  --parent <issue-id> \
  --body "<prompt + acceptance criteria>" \
  --tag proto:subagents-v1 \
  --tag kind:spawn \
  --tag ctx:clean \
  --priority 2 \
  --json)"
child_id="$(echo "$child_json" | jq -r '.id')"
mu forum post issue:"$child_id" -m "<task packet>" --author operator
```

Use dependencies to control timing:

```bash
mu issues dep <blocker-id> blocks <child-id>
```

### Primitive: `fork` (inherited-context child)

Create analysis/synthesis children that depend on sibling outputs.
Before creation, summarize dependency results from `mu forum read issue:<dep-id>`.
Then create with `kind:fork` + `ctx:inherit`.

### Primitive: `ask` (human input node)

Represent user questions as first-class nodes:

```bash
ask_json="$(mu issues create "Question: <question>" \
  --parent <issue-id> \
  --tag proto:subagents-v1 \
  --priority 1 \
  --json)"
ask_id="$(echo "$ask_json" | jq -r '.id')"
mu issues update "$ask_id" \
  --remove-tag node:agent \
  --add-tag kind:ask \
  --add-tag ctx:human \
  --add-tag actor:user
mu forum post issue:"$ask_id" \
  -m "QUESTION: <question>\nOPTIONS: <list or free-form>\nReply in this topic, then close this issue." \
  --author operator
```

If downstream work depends on the answer:

```bash
mu issues dep <ask-id> blocks <child-id>
```

### Primitive: `complete`

Always write a result packet, then close the issue:

```bash
mu forum post issue:<issue-id> -m "RESULT:\n<result>" --author operator
mu issues close <issue-id> --outcome success
```

Use explicit non-success outcomes when needed (`failure`, `needs_work`, `skipped`).

### Primitive: `expand`

When decomposition is needed:

1. Create child work nodes via `spawn` / `fork`.
2. Create one synthesis child (`kind:synth`, `ctx:inherit`) blocked by all child work nodes.
3. Close current node with `mu issues close <issue-id> --outcome expanded`.

This encodes decompose→synthesize as explicit DAG nodes.

### Primitive: `serial`

Encode ordered execution with dependency edges:

```bash
mu issues dep <step-a> blocks <step-b>
```

## Required invariants

- **Read-before-act-verify:** every write is followed by a re-read.
- **Claim-before-work:** claim executable issues before file/work execution.
- **Scoped authority:** mutate only current issue + descendants.
- **Container hygiene:** remove `node:agent` from non-executable root/ask/container nodes.
- **Idempotent logging:** forum updates should be append-only and resumable.
- **Explicit outcomes:** every executable issue closes with concrete outcome.

## Control loops

### Orchestrator heartbeat tick loop (bounded)

For root `<root-id>`:

1. `read_tree` at root/selected node
2. Choose exactly one primitive to apply
3. Apply it
4. Verify state (`mu issues get`, `children`, `ready`, `validate`)
5. Post concise progress to forum
6. Exit tick

Stop automation when `mu issues validate <root-id>` returns final.

### Worker issue loop (single issue pass)

For claimed issue `<issue-id>` under `<root-id>`:

1. `read_tree`
2. Choose one primitive:
   - missing input -> `ask`
   - needs decomposition -> `expand`
   - directly solvable -> `complete`
3. Apply primitive
4. Verify state
5. Post concise progress to `issue:<issue-id>`

Repeat until issue closes.

## Bootstrap template

```bash
root_json="$(mu issues create "Root: <goal>" --tag node:root --tag proto:subagents-v1 --json)"
root_id="$(echo "$root_json" | jq -r '.id')"
mu issues update "$root_id" --remove-tag node:agent

goal_json="$(mu issues create "Goal execution" \
  --parent "$root_id" \
  --tag proto:subagents-v1 \
  --tag kind:goal \
  --tag ctx:clean \
  --priority 2 \
  --json)"
goal_id="$(echo "$goal_json" | jq -r '.id')"

mu forum post issue:"$goal_id" -m "<goal brief + acceptance criteria>" --author operator
```

## Dispatch templates

### A) Heartbeat autopilot (preferred for supervision)

```bash
mu heartbeats create \
  --title "subagents-v1 <root-id>" \
  --reason subagents_protocol_v1 \
  --every-ms 15000 \
  --prompt "Use skill subagents for root <root-id>. Run exactly one bounded orchestration pass: claim/work one ready proto:subagents-v1 issue (or perform one orchestration action), verify state, and report status. Stop when 'mu issues validate <root-id>' is final."
```

### B) tmux fan-out (parallel workers)

```bash
run_id="$(date +%Y%m%d-%H%M%S)"
for issue_id in $(mu issues ready --root <root-id> --tag proto:subagents-v1 --json | jq -r '.[].id' | head -n 3); do
  session="mu-sub-${run_id}-${issue_id}"
  tmux new-session -d -s "$session" \
    "cd '$PWD' && mu exec 'Work issue ${issue_id} using subagents.protocol/v1. Claim first, then run one full control loop.' ; rc=\$?; echo __MU_DONE__:\$rc"
done
```

## Subagents HUD (optional board)

Use HUD for visibility and bounded spawning. Protocol truth still lives in issues/forum.

```text
/mu subagents on
/mu subagents prefix mu-sub-
/mu subagents root <root-id>
/mu subagents tag proto:subagents-v1
/mu subagents mode operator
/mu subagents refresh
/mu subagents snapshot
```

Tool: `mu_subagents_hud`

- Actions: `status`, `snapshot`, `on`, `off`, `toggle`, `refresh`, `set_prefix`, `set_root`, `set_tag`, `set_mode`, `set_refresh_interval`, `set_stale_after`, `set_spawn_paused`, `update`, `spawn`

## Reconciliation

- Run `mu issues validate <root-id>` before declaring completion.
- Merge synth-node outputs into one final user-facing result.
- Convert unresolved gaps into new child issues tagged `proto:subagents-v1`.
- Tear down temporary tmux sessions.

## Safety

- Prefer small, reversible child issues.
- Keep child prompts explicit about deliverables + acceptance criteria.
- Pause spawning while queue semantics are unclear.
- Never overwrite unrelated files across shards.
