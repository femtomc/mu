---
name: hierarchical-work-protocol
description: "Defines the shared hierarchical planning/work issue-DAG protocol used by planning and subagents. Use when creating, validating, or executing protocol-driven DAG work."
---

# hierarchical-work-protocol

Use this skill when work should flow through one shared protocol from planning to execution.

## Contents

- [Protocol identity](#protocol-identity)
- [Canonical tags and node roles](#canonical-tags-and-node-roles)
- [Protocol primitives](#protocol-primitives)
- [Required invariants](#required-invariants)
- [Planning handoff contract](#planning-handoff-contract)
- [Execution loop contract](#execution-loop-contract)
- [Minimal bootstrap template](#minimal-bootstrap-template)
- [Evaluation scenarios](#evaluation-scenarios)

## Protocol identity

- Protocol ID: `hierarchical-work.protocol/v1`
- Required issue tag on all protocol nodes: `proto:hierarchical-work-v1`

This system does **not** use backward-compatibility aliases for older protocol names.
Use only the protocol ID and tag above.

## Canonical tags and node roles

Use this controlled tag vocabulary:

- Protocol scope:
  - `proto:hierarchical-work-v1`
- Node kind:
  - `kind:root` (root container)
  - `kind:goal` (top-level executable objective under root)
  - `kind:spawn` (independent executable child)
  - `kind:fork` (context-inheriting executable child)
  - `kind:synth` (synthesis executable child)
  - `kind:ask` (human-input node)
- Context mode:
  - `ctx:clean` (independent context)
  - `ctx:inherit` (depends on upstream outputs)
  - `ctx:human` (user input required)
- Actor marker:
  - `actor:user` for human question nodes

Node role rules:

1. Root container node
   - Must include: `node:root`, `kind:root`, `proto:hierarchical-work-v1`
   - Must be non-executable (`node:agent` removed)

2. Executable work nodes (`kind:goal|spawn|fork|synth`)
   - Must include: `proto:hierarchical-work-v1`
   - Must include exactly one `kind:*` from the executable set
   - Must include one `ctx:*` tag (`ctx:clean` or `ctx:inherit`)
   - Must remain executable (`node:agent` present)

3. Human input nodes (`kind:ask`)
   - Must include: `proto:hierarchical-work-v1`, `kind:ask`, `ctx:human`, `actor:user`
   - Must be non-executable (`node:agent` removed)

## Protocol primitives

### `read_tree`

Read current node + local neighborhood before every mutation:

```bash
mu issues get <issue-id> --pretty
mu issues children <issue-id> --pretty
mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty
mu forum read issue:<issue-id> --limit 20 --pretty
```

### `claim`

Claim executable work before execution:

```bash
mu issues claim <issue-id>
mu forum post issue:<issue-id> -m "START: <plan for this pass>" --author operator
```

### `spawn`

Create independent executable child work:

```bash
child_json="$(mu issues create "<title>" \
  --parent <issue-id> \
  --body "<prompt + acceptance criteria>" \
  --tag proto:hierarchical-work-v1 \
  --tag kind:spawn \
  --tag ctx:clean \
  --priority 2 \
  --json)"
child_id="$(echo "$child_json" | jq -r '.id')"
mu forum post issue:"$child_id" -m "<task packet>" --author operator
```

### `fork`

Create context-inheriting executable child work:

1. Summarize dependency outputs from `mu forum read issue:<dep-id>`.
2. Create child with tags `kind:fork` + `ctx:inherit` + `proto:hierarchical-work-v1`.

### `ask`

Create explicit human-input nodes:

```bash
ask_json="$(mu issues create "Question: <question>" \
  --parent <issue-id> \
  --tag proto:hierarchical-work-v1 \
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

### `complete`

Close executable work with explicit result packets:

```bash
mu forum post issue:<issue-id> -m "RESULT:\n<result>" --author operator
mu issues close <issue-id> --outcome success
```

Use explicit non-success outcomes when required (`failure`, `needs_work`, `skipped`).

### `expand`

Encode decomposition as first-class graph transitions:

1. Create child work nodes via `spawn` and/or `fork`.
2. Create one synthesis child tagged `kind:synth`, `ctx:inherit`, `proto:hierarchical-work-v1`.
3. Block synthesis on all created children (`mu issues dep <child> blocks <synth>`).
4. Close expanded node with `mu issues close <issue-id> --outcome expanded`.

### `serial`

Encode ordered execution explicitly with dependency edges:

```bash
mu issues dep <step-a> blocks <step-b>
```

## Required invariants

- Read-before-act-verify for every mutation.
- Claim-before-work on executable nodes.
- Scoped authority: mutate only current issue and descendants.
- Non-executable containers/questions must not retain `node:agent`.
- Forum updates are append-only and resumable (`START`/`RESULT` packets).
- Every executable issue closes with explicit outcome.
- `mu issues validate <root-id>` must pass before declaring completion.

## Planning handoff contract

Before handoff from planning to subagent orchestration:

1. Root exists and is tagged `node:root`, `kind:root`, `proto:hierarchical-work-v1`.
2. Every in-scope node carries `proto:hierarchical-work-v1`.
3. Every node has exactly one `kind:*` tag.
4. Non-executable nodes (`kind:root`, `kind:ask`) have `node:agent` removed.
5. Executable nodes (`kind:goal|spawn|fork|synth`) include `ctx:*` and acceptance criteria.
6. Dependency edges encode required ordering and synth fan-in.
7. Ready set sanity check succeeds:

```bash
mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty
mu issues validate <root-id>
```

## Execution loop contract

Worker/orchestrator passes always choose one primitive at a time:

1. `read_tree`
2. Choose one primitive (`ask` | `expand` | `complete` | orchestration primitive)
3. Apply
4. Verify (`get`, `children`, `ready`, `validate`)
5. Log concise progress to forum
6. Exit bounded pass

## Minimal bootstrap template

```bash
root_json="$(mu issues create "Root: <goal>" \
  --tag node:root \
  --tag kind:root \
  --tag proto:hierarchical-work-v1 \
  --json)"
root_id="$(echo "$root_json" | jq -r '.id')"
mu issues update "$root_id" --remove-tag node:agent

goal_json="$(mu issues create "Goal execution" \
  --parent "$root_id" \
  --tag kind:goal \
  --tag ctx:clean \
  --tag proto:hierarchical-work-v1 \
  --priority 2 \
  --json)"
goal_id="$(echo "$goal_json" | jq -r '.id')"

mu forum post issue:"$goal_id" -m "<goal brief + acceptance criteria>" --author operator
```

## Evaluation scenarios

1. **Planning-to-execution continuity**
   - Setup: a freshly planned DAG.
   - Expected: all nodes satisfy protocol tag/kind/context rules and can be consumed by subagents without re-shaping.

2. **Decomposition with synthesis fan-in**
   - Setup: worker expands a complex node.
   - Expected: spawn/fork children plus one synth child are created, dependencies block synth until all children finish, parent closes as `expanded`.

3. **Human-input interruption**
   - Setup: missing external decision during execution.
   - Expected: `kind:ask` node is created, marked non-executable, downstream nodes are blocked on the ask node, execution resumes after answer issue closes.
