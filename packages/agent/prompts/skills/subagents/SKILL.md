---
name: subagents
description: "Meta-skill for protocol-driven planning and execution. Routes to planning, protocol, execution, control-flow, model-routing, and hud."
---

# subagents

Use this meta-skill when work should run through the full multi-agent DAG stack.

## Subskills

- `planning` — build/refine issue DAGs and approval loops.
- `protocol` — canonical DAG protocol contract and primitives.
- `execution` — durable orchestration/supervision loop over the DAG.
- `control-flow` — loop/termination overlays (`flow:*`) on top of protocol primitives.
- `model-routing` — provider/model/thinking overlays (`route:*`) from live harness capabilities.
- `hud` — canonical HUD ownership/update/teardown contract.

## Hard-cutover naming

- Use `protocol` (not `orchestration`).
- Use `execution` (not the old execution leaf named `subagents`).

## Recommended bundles

- Planning bundle: `planning` + `protocol` + `hud`
- Execution bundle: `execution` + `protocol` + `hud`
- Policy overlays: add `control-flow` and/or `model-routing` as needed
