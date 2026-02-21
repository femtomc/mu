---
name: subagents
description: Define and run a protocol-driven multi-agent workflow over mu issues, forum, and heartbeats.
---

# Subagents (protocol-driven)

Use this skill when work should decompose and coordinate itself at runtime.

## Core model

Treat this skill as the orchestration protocol spec.
Do not depend on hardcoded orchestrator/worker role behavior.

Shared primitives:

- `mu issues` = task tree, dependencies, and lifecycle state
- `mu forum` = durable context/result packets
- `mu heartbeats` / `mu cron` = wake/scheduling loop
- `tmux` + subagents HUD = execution surfaces and observability

## Protocol: `subagents.protocol/v1`

### Primitive: `read_tree`

Before every mutation, inspect root + local node state:

```bash
mu issues get <issue-id> --pretty
mu issues children <issue-id> --pretty
mu issues ready --root <root-id> --tag proto:subagents-v1 --pretty
mu forum read issue:<issue-id> --limit 20 --pretty
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

Create analysis/synthesis children that need sibling outputs.
Before creation, summarize completed dependency results from
`mu forum read issue:<dep-id>`. Then create with `kind:fork` + `ctx:inherit`.

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
3. Close the current node with `mu issues close <issue-id> --outcome expanded`.

This expresses two-phase execution (decompose -> synthesize) as explicit DAG nodes.

### Primitive: `serial`

Encode ordered execution with dependency edges:

```bash
mu issues dep <step-a> blocks <step-b>
```

## Required invariants

- **Read-before-act-verify:** every write is followed by a state re-read.
- **Claim-before-work:** claim issues before doing file work or execution logging.
- **Scoped authority:** mutate only the current issue + descendants.
- **Container hygiene:** remove `node:agent` from non-executable root/ask/container nodes.
- **Idempotent logging:** forum updates should be append-only and resumable.
- **Explicit outcomes:** every executable issue must close with a concrete outcome.

## Agent control loop (normative)

For a claimed issue `<issue-id>` under `<root-id>`:

1. `read_tree`
2. Choose exactly one primitive:
   - Missing user input -> `ask`
   - Needs decomposition -> `expand` (`spawn`/`fork` children + synth node)
   - Directly solvable -> `complete`
3. Apply one primitive
4. Verify state (`mu issues get`, `children`, `ready`)
5. Post concise progress to `issue:<issue-id>`

Repeat until the issue is closed.

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

## Autonomous dispatch options

### A) Heartbeat autopilot (preferred)

Let a recurring heartbeat wake an operator prompt that follows this protocol:

```bash
mu heartbeats create \
  --title "subagents-v1 <root-id>" \
  --reason subagents_protocol_v1 \
  --every-ms 15000 \
  --prompt "Use skill subagents (protocol v1) for root <root-id>. Claim one ready issue tagged proto:subagents-v1, execute one control-loop pass, and report status. Stop when 'mu issues validate <root-id>' is final."
```

### B) tmux fan-out

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
