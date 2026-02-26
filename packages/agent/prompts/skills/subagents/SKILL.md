---
name: subagents
description: "Meta-skill for protocol-driven planning and execution. Routes to planning, protocol, execution, control-flow, and model-routing with mu_ui-first communication."
---

# subagents

Use this meta-skill when work should run through the full multi-agent DAG stack.

## Subskills

- `planning` — build/refine issue DAGs and approval loops.
- `protocol` — canonical DAG protocol contract and primitives.
- `execution` — durable orchestration/supervision loop over the DAG.
- `control-flow` — loop/termination overlays (`flow:*`) on top of protocol primitives.
- `model-routing` — provider/model/thinking overlays (`route:*`) from live harness capabilities.

## Naming conventions

- Use `protocol` (not `orchestration`).
- Use `execution` for execution/supervision workflows.

## Recommended bundles

- Planning bundle: `planning` + `protocol`
- Execution bundle: `execution` + `protocol`
- Policy overlays: add `control-flow` and/or `model-routing` as needed

## Canonical mu_ui communication pattern

Use `mu_ui` as the shared operator↔human surface during planning/execution passes.

```bash
/mu ui status
/mu ui snapshot compact
/mu ui snapshot multiline
```

Status doc example (`ui:subagents`):

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:subagents",
    "title": "Subagents execution status",
    "summary": "ready=2 · active=1 · blocked=0",
    "components": [
      {
        "kind": "key_value",
        "id": "queue",
        "title": "Queue",
        "rows": [
          { "key": "ready", "value": "2" },
          { "key": "active", "value": "1" },
          { "key": "blocked", "value": "0" }
        ],
        "metadata": {}
      }
    ],
    "actions": [],
    "revision": { "id": "subagents-status", "version": 3 },
    "updated_at_ms": 1772060000000,
    "metadata": {
      "profile": {
        "id": "subagents",
        "variant": "status",
        "snapshot": {
          "compact": "ready=2 · active=1 · blocked=0",
          "multiline": "ready: 2\nactive: 1\nblocked: 0"
        }
      }
    }
  }
}
```

Interactive prompt example (`ui:subagents:handoff`):

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:subagents:handoff",
    "title": "Execution handoff decision",
    "components": [
      { "kind": "text", "id": "question", "text": "Close root now?", "metadata": {} }
    ],
    "actions": [
      {
        "id": "close-root",
        "label": "Close root",
        "kind": "primary",
        "payload": {},
        "metadata": { "command_text": "/answer close-root" }
      }
    ],
    "revision": { "id": "subagents-handoff", "version": 1 },
    "updated_at_ms": 1772060005000,
    "metadata": { "profile": { "id": "subagents-handoff", "variant": "interactive" } }
  }
}
```

Teardown/handoff uses explicit removes:

```json
{"action":"remove","ui_id":"ui:subagents:handoff"}
{"action":"remove","ui_id":"ui:subagents"}
```

## Common patterns

- **End-to-End Orchestration**: Route to `planning` to get a structured issue DAG, publish plan state in `ui:planning` (status) plus `ui:planning:approval` (interactive prompt) when needed, then route to `execution` to drive workers until DAG completion.
- **DAG Recovery / Unblocking**: If a DAG stalls, route to `protocol` to inspect `mu issues ready` constraints, followed by a bounded `execution` pass to claim and manually unblock the stalled task.
- **Differentiated Model Provisioning**: If different nodes need different abilities (for example specialized docs vs. complex refactoring), add `model-routing` to set `route:model-routing-v1` policies per issue. The `execution` worker shell will then launch the required model profiles based on those policies.
