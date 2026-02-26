---
name: control-flow
description: "Defines compositional control-flow policies for orchestration DAGs (for example review-gated retry loops) using protocol-preserving transitions."
---

# control-flow

Use this skill when work needs explicit loop/termination policy on top of the
shared protocol.

## Contents

- [Purpose](#purpose)
- [Required dependencies](#required-dependencies)
- [Core contract](#core-contract)
- [Review-gated policy (`flow:review-gated-v1`)](#review-gated-policy-flowreview-gated-v1)
- [Transition table](#transition-table)
- [Planning handoff contract](#planning-handoff-contract)
- [Subagents/heartbeat execution contract](#subagentsheartbeat-execution-contract)
- [mu_ui visibility and handoff](#mu_ui-visibility-and-handoff)
- [Evaluation scenarios](#evaluation-scenarios)

## Purpose

Control-flow policies are overlays. They do not replace protocol
semantics; they guide which protocol primitive to apply next.

Examples:
- review-gated retries
- bounded retry + human escalation
- checkpoint/approval gates

## Required dependencies

Load these skills before applying control-flow policies:

- `protocol` (protocol primitives/invariants)
- `execution` (durable execution runtime)
- `heartbeats` and/or `crons` (scheduler clock)
- `mu` (for `/mu ui` inspection commands and communication checks)

## Core contract

1. **Overlay, don’t fork protocol**
   - Keep `hierarchical-work.protocol/v1` + `proto:hierarchical-work-v1`.
   - Do not invent new protocol IDs for policy variants.

2. **Policy metadata lives in `flow:*`**
   - Keep policy tags/metadata orthogonal to `kind:*` and `ctx:*`.

3. **Transitions compile to protocol primitives**
   - Use only `spawn|fork|expand|ask|complete|serial` plus normal issue lifecycle
     commands (`claim/open/close/dep`).

4. **Bounded pass per tick**
   - One control-flow transition decision and one bounded mutation bundle per
     heartbeat pass; verify then exit.

## Review-gated policy (`flow:review-gated-v1`)

### Tag vocabulary

- `flow:review-gated-v1` — subtree uses review-gated policy
- `flow:attempt` — implementation attempt node
- `flow:review` — review gate node

Optional metadata in issue body/forum packet:
- `max_review_rounds=<N>` (default recommended: 3)

### Required shape per round

For round `k` under policy scope:

- `attempt_k` (executable; usually `kind:spawn` or `kind:fork`)
- `review_k` (executable; usually `kind:fork`, `ctx:inherit`)
- edge: `attempt_k blocks review_k`

### Critical invariant

When review fails, **do not leave the review node closed as `needs_work`**.
That keeps the DAG non-final forever.

Instead:
1. record verdict in forum (`VERDICT: needs_work`)
2. spawn `attempt_{k+1}` + `review_{k+1}`
3. add `attempt_{k+1} blocks review_{k+1}`
4. close `review_k` with `outcome=expanded`

This preserves full audit history while keeping finalization reachable.

## Transition table

Given current round `(attempt_k, review_k)`:

1. **attempt not finished**
   - action: continue attempt execution (normal worker loop)

2. **attempt finished, review pending**
   - action: run review_k

3. **review verdict = pass**
   - action: `complete(review_k)` with `success`
   - if subtree validates final, disable supervising heartbeat

4. **review verdict = needs_work, rounds < max**
   - action: apply fail->expand transition (spawn next round + close review_k as `expanded`)

5. **review verdict = needs_work, rounds >= max**
   - action: create `kind:ask` escalation node (`ctx:human`, `actor:user`)
   - downstream work blocks on that ask node

## Planning handoff contract

When planning a review-gated subtree:

1. Tag policy scope root (or selected goal node) with `flow:review-gated-v1`.
2. Create round-1 pair (`flow:attempt`, `flow:review`) + dependency edge.
3. Encode acceptance criteria for attempt + review explicitly.
4. Record max rounds policy in body/forum packet.

## Subagents/heartbeat execution contract

Per orchestrator tick:

1. `read_tree` + ready-set + round-state inspection.
2. Select one transition from the table above.
3. Apply one bounded transition bundle.
4. Verify with:
   - `mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty`
   - `mu issues validate <root-id>`
5. Upsert control-flow visibility via `mu_ui` (`ui_id:"ui:subagents"` when orchestration is shared, or `ui_id:"ui:control-flow"` when standalone).
6. Post one concise ORCH_PASS update.
7. If final: disable heartbeat program.

Reusable bounded heartbeat prompt fragment:

```text
Use skills subagents, protocol, execution, control-flow, and mu.
For root <root-id>, enforce flow:review-gated-v1 with spawn-per-attempt rounds.
Run exactly one bounded control-flow transition pass, keep control-flow visibility
current via mu_ui (`ui:subagents` or `ui:control-flow`), verify DAG state,
post one ORCH_PASS, and stop. If validate is final, disable the supervising
heartbeat and report completion.
```

## mu_ui visibility and handoff

Use `mu_ui` as the primary communication surface for active control-flow
execution.

- Publish control-flow status in one status-profile doc:
  - shared orchestration: `ui_id:"ui:subagents"`
  - standalone control-flow loop: `ui_id:"ui:control-flow"`
- Set profile metadata for deterministic snapshots:
  - `metadata.profile.id: "subagents"` or `"control-flow"`
  - `metadata.profile.variant: "status"`
  - `metadata.profile.snapshot.compact|multiline`
- Keep status docs non-interactive (`actions: []`).
- For user decisions (for example max-round escalation), publish a separate
  interactive prompt doc (for example `ui_id:"ui:control-flow:escalation"`).
- Update status docs each bounded pass before posting `ORCH_PASS`.
- On completion or handoff, remove control-flow-owned docs with explicit
  `mu_ui remove` actions. Prefer `remove` over `clear`.

### Canonical status doc (`ui:control-flow`)

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:control-flow",
    "title": "Control-flow status",
    "summary": "policy=review-gated · round=2/3 · state=review_pending",
    "components": [
      {
        "kind": "key_value",
        "id": "policy",
        "title": "Review gate",
        "rows": [
          { "key": "policy", "value": "flow:review-gated-v1" },
          { "key": "round", "value": "2/3" },
          { "key": "attempt", "value": "mu-attempt-2" },
          { "key": "review", "value": "mu-review-2" },
          { "key": "next", "value": "Run review_2" }
        ],
        "metadata": {}
      }
    ],
    "actions": [],
    "revision": { "id": "control-flow-status", "version": 5 },
    "updated_at_ms": 1772067720000,
    "metadata": {
      "profile": {
        "id": "control-flow",
        "variant": "status",
        "snapshot": {
          "compact": "round=2/3 · state=review_pending",
          "multiline": "policy: review-gated\nround: 2/3\nstate: review_pending\nnext: run review_2"
        }
      }
    }
  }
}
```

### Canonical escalation prompt (`ui:control-flow:escalation`)

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:control-flow:escalation",
    "title": "Review rounds exhausted",
    "summary": "Need user decision after max failed review rounds.",
    "components": [
      {
        "kind": "text",
        "id": "question",
        "text": "Max review rounds were reached. Should execution open another attempt or stop for manual intervention?",
        "metadata": {}
      }
    ],
    "actions": [
      {
        "id": "open-extra-round",
        "label": "Open one extra round",
        "kind": "primary",
        "payload": {},
        "metadata": { "command_text": "/answer open-extra-round" }
      },
      {
        "id": "stop-and-handoff",
        "label": "Stop and hand off",
        "kind": "secondary",
        "payload": {},
        "metadata": { "command_text": "/answer stop-and-handoff" }
      }
    ],
    "revision": { "id": "control-flow-escalation", "version": 1 },
    "updated_at_ms": 1772067730000,
    "metadata": {
      "profile": {
        "id": "control-flow-escalation",
        "variant": "interactive"
      }
    }
  }
}
```

### Teardown / handoff

```json
{"action":"remove","ui_id":"ui:control-flow:escalation"}
{"action":"remove","ui_id":"ui:control-flow"}
```

## Evaluation scenarios

1. **Single-pass review success**
   - attempt_1 succeeds, review_1 succeeds, subtree validates final, heartbeat disables.

2. **One failed review then success**
   - review_1 fails -> expand to round 2; review_2 succeeds -> final.

3. **Max-round escalation**
   - repeated failed reviews hit `max_review_rounds`; ask node created and execution blocks awaiting human input.
