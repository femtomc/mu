---
name: model-routing
description: "Adds a model-selection overlay for issue DAG execution, recommending provider/model/thinking per issue from live harness capabilities."
---

# model-routing

Use this skill when execution should choose different models for different issue
kinds (for example code vs docs), while preserving protocol
semantics.

## Contents

- [Purpose](#purpose)
- [Required dependencies](#required-dependencies)
- [Core contract](#core-contract)
- [Quality profile policy (high-stakes orchestration)](#quality-profile-policy-high-stakes-orchestration)
- [Overlay identity (`route:model-routing-v1`)](#overlay-identity-routemodel-routing-v1)
- [Tag vocabulary](#tag-vocabulary)
- [Recommendation packet contract](#recommendation-packet-contract)
- [Selection algorithm (deterministic)](#selection-algorithm-deterministic)
- [Transition table](#transition-table)
- [Planning handoff contract](#planning-handoff-contract)
- [Subagents/heartbeat execution contract](#subagentsheartbeat-execution-contract)
- [Failure + fallback policy](#failure--fallback-policy)
- [mu_ui visibility and handoff](#mu_ui-visibility-and-handoff)
- [Evaluation scenarios](#evaluation-scenarios)

## Purpose

Model-routing policies are overlays. They do not replace protocol
semantics.

Examples:
- use a strong coding model for implementation leaves
- use a stronger writing model for docs/synthesis leaves
- choose lower-cost fast models for routine triage
- escalate to deeper thinking for high-risk or complex nodes

## Required dependencies

Load these skills before applying model-routing policies:

- `protocol` (protocol primitives/invariants)
- `execution` (durable execution runtime)
- `heartbeats` and/or `crons` (scheduler clock)
- `mu` (for `/mu ui` inspection commands and communication checks)
- `control-flow` (optional; when loop/termination overlays are also active)

## Core contract

1. **Overlay, don’t fork protocol**
   - Keep `hierarchical-work.protocol/v1` + `proto:hierarchical-work-v1`.
   - Do not redefine `kind:*`, `ctx:*`, issue lifecycle semantics, or DAG validity.

2. **Harness is source-of-truth**
   - Drive recommendations from `mu control harness --json`.
   - Only consider authenticated providers unless policy explicitly allows otherwise.

3. **Recommend, then apply**
   - Route decisions are explicit artifacts (forum packets + optional tags),
     not hidden implicit behavior.

4. **Non-blocking by default**
   - Routing failure should degrade safely (fallback model / default model)
     unless a hard requirement cannot be met.

5. **Bounded pass per tick**
   - One routing decision and one bounded mutation/action bundle per heartbeat pass.

6. **Per-issue/session overrides preferred**
   - Use `mu exec --provider/--model/--thinking` or `mu turn ...` overrides.
   - Avoid changing workspace-global operator defaults for per-issue routing.

## Quality profile policy (high-stakes orchestration)

For protocol/runtime/schema/cross-adapter work, apply an explicit quality floor.
Do not rely on implicit defaults.

Recommended high-stakes profile:

- provider: `openai-codex`
- model: `gpt-5.3-codex`
- thinking: `xhigh`

Required guardrails:

1. Always pass explicit `--provider --model --thinking` when launching workers.
2. Do not use mini/fast profiles for root-close decisions, acceptance-signoff,
   or architecture-contract issues unless the user explicitly requests it.
3. If authenticated capability for the high-stakes profile is unavailable,
   emit a `ROUTE_FALLBACK` packet that explains the downgrade rationale.

## Overlay identity (`route:model-routing-v1`)

- Tag scope root (or selected subtree root) with: `route:model-routing-v1`
- Routing metadata remains orthogonal to `kind:*`, `ctx:*`, and `flow:*`.

## Tag vocabulary

Recommended routing tags (policy metadata):

- Scope:
  - `route:model-routing-v1`
- Task family:
  - `route:task:code`
  - `route:task:docs`
  - `route:task:research`
  - `route:task:ops`
  - `route:task:review`
  - `route:task:synth`
  - `route:task:general`
- Depth intent:
  - `route:depth:fast`
  - `route:depth:balanced`
  - `route:depth:deep`
- Budget intent:
  - `route:budget:low`
  - `route:budget:balanced`
  - `route:budget:premium`
- Hard modality requirement:
  - `route:modality:image` (omit for text-only)
- Pin indicator:
  - `route:pin` (exact provider/model comes from packet metadata)

Notes:
- Keep tags concise and stable.
- Put detailed routing config in forum packets (not in tag strings).

## Recommendation packet contract

Post one `ROUTE_RECOMMENDATION` packet to `issue:<issue-id>` before launching work
with a selected model.

Suggested packet shape (JSON block inside forum message):

```text
ROUTE_RECOMMENDATION:
{
  "version": "route:model-routing-v1",
  "issue_id": "<issue-id>",
  "harness_fingerprint": "<sha256>",
  "selected": {
    "provider": "<provider>",
    "model": "<model>",
    "thinking": "<thinking-level>"
  },
  "alternates": [
    { "provider": "<provider>", "model": "<model>", "thinking": "<thinking-level>" }
  ],
  "constraints": {
    "task": "code|docs|research|ops|review|synth|general",
    "depth": "fast|balanced|deep",
    "budget": "low|balanced|premium",
    "modality": "text|image",
    "min_context_window": 0
  },
  "rationale": [
    "provider authenticated",
    "supports required thinking level",
    "meets context/modality constraints",
    "best score under budget/depth policy"
  ],
  "created_at_ms": 0
}
```

Optional root-level packet for custom preferences:

```text
ROUTE_POLICY:
{
  "version": "route:model-routing-v1",
  "quality_profiles": {
    "orchestration_critical": {
      "provider": "openai-codex",
      "model": "gpt-5.3-codex",
      "thinking": "xhigh"
    }
  },
  "task_preferences": {
    "code": [
      { "provider": "openai-codex", "model": "gpt-5.3-codex", "thinking": "xhigh" }
    ],
    "docs": [
      { "provider": "openrouter", "model": "google/gemini-3.1-pro-preview", "thinking": "high" }
    ]
  }
}
```

If a preference entry is unavailable under current harness/auth state, skip it and
continue deterministic fallback selection.

## Selection algorithm (deterministic)

### Inputs

- Issue tags (`route:task:*`, `route:depth:*`, `route:budget:*`, `route:modality:image`, `route:pin`)
- Optional `ROUTE_POLICY` and per-issue constraints from forum/body
- Live harness snapshot (`mu control harness --json`)

### Step 1: gather live capabilities

```bash
mu control harness --json --pretty
```

### Step 2: build candidate set

1. Start from authenticated providers only.
2. Flatten model entries across providers.
3. Filter by hard requirements:
   - required modality (`text` and optional `image`)
   - minimum context window (if specified)
   - pin requirement (`route:pin`) if specified
4. Resolve target thinking from depth intent:
   - `fast` -> `minimal`
   - `balanced` -> `medium`
   - `deep` -> `xhigh` if available, else `high`
5. Clamp chosen thinking to model-supported `thinking_levels`.

### Step 3: score candidates

Use deterministic score components (example):

- Hard-fit gates (must pass): auth, modality, context, thinking compatibility
- Soft score:
  - task preference match (`ROUTE_POLICY`/task family)
  - reasoning/xhigh capability vs depth
  - context headroom
  - budget penalty from per-token cost

Tie-breaker: lower estimated cost, then lexicographic `provider/model`.

### Step 4: select + alternates

- pick top candidate as `selected`
- keep next N as `alternates` (recommended N=2)
- post `ROUTE_RECOMMENDATION` packet

### Step 5: apply selection

For one-shot execution:

```bash
mu exec --provider <provider> --model <model> --thinking <thinking> \
  "Use skills subagents, protocol, execution, model-routing, and mu. Work issue <issue-id> and keep routing visibility current via mu_ui."
```

For existing session turn:

```bash
mu turn --session-kind cp_operator --session-id <session-id> \
  --provider <provider> --model <model> --thinking <thinking> \
  --body "Continue issue <issue-id> with current routing selection."
```

## Transition table

Given an executable issue under `route:model-routing-v1`:

1. **No routing decision yet**
   - action: compute recommendation + post `ROUTE_RECOMMENDATION` packet

2. **Routing decision exists and still valid**
   - action: execute issue using selected provider/model/thinking

3. **Selected route fails at launch/runtime**
   - action: choose next alternate, post `ROUTE_FALLBACK`, retry bounded once

4. **All alternates exhausted**
   - action: degrade to harness default model, post `ROUTE_DEGRADED`

5. **Hard requirement unmet (no valid candidates)**
   - action: create `kind:ask` node (`ctx:human`, `actor:user`) requesting
     provider auth/config change or constraint relaxation

## Planning handoff contract

When planning a routed subtree:

1. Tag policy scope with `route:model-routing-v1`.
2. Tag executable nodes with task/depth/budget intent.
3. Record any hard constraints (modality/context) in issue body or forum packet.
4. Optionally add root `ROUTE_POLICY` preferences.
5. Ensure DAG remains valid under `protocol` invariants:
   - `mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty`
   - `mu issues validate <root-id>`

## Subagents/heartbeat execution contract

Per orchestrator tick:

1. Read tree + ready set + latest route packet on target issue.
2. Read harness snapshot once per pass.
3. Select one routing transition from the table above.
4. Apply one bounded mutation bundle (recommend/fallback/ask/execute-start).
5. Verify with:
   - `mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty`
   - `mu issues validate <root-id>`
6. Upsert routing visibility via `mu_ui` (`ui_id:"ui:subagents"` when orchestration is shared, or `ui_id:"ui:model-routing"` when standalone).
7. Post one concise `ORCH_PASS` status update.
8. If root is final, disable supervising heartbeat.

Reusable heartbeat prompt fragment:

```text
Use skills subagents, protocol, execution, model-routing, and mu.
For root <root-id>, enforce route:model-routing-v1.
Run exactly one bounded routing/orchestration transition pass: compute or validate
one issue's model recommendation from live `mu control harness` capabilities,
apply one action, keep route status current via mu_ui (`ui:subagents` or
`ui:model-routing`), verify DAG state, post one ORCH_PASS, then stop.
If validate is final, disable the supervising heartbeat and report completion.
```

## Failure + fallback policy

1. **Provider/model unavailable or auth drift**
   - post `ROUTE_FALLBACK`
   - move to next alternate

2. **Thinking level unsupported for selected model**
   - clamp to nearest supported lower level
   - post rationale in fallback packet

3. **No candidates satisfy hard constraints**
   - create `kind:ask` escalation with clear options:
     - authenticate provider X
     - relax modality/context/depth constraint
     - approve default-model execution

4. **Auditability requirement**
   - every route change emits forum packet (`ROUTE_RECOMMENDATION`,
     `ROUTE_FALLBACK`, `ROUTE_DEGRADED`)

## mu_ui visibility and handoff

Use `mu_ui` as the primary communication surface for active model-routing
execution.

- Publish routing status in one status-profile doc:
  - shared orchestration: `ui_id:"ui:subagents"`
  - standalone model-routing loop: `ui_id:"ui:model-routing"`
- Set status profile metadata for deterministic snapshots:
  - `metadata.profile.id: "subagents"` or `"model-routing"`
  - `metadata.profile.variant: "status"`
  - `metadata.profile.snapshot.compact|multiline`
- Keep status docs non-interactive (`actions: []`).
- For user decisions (for example hard-constraint escalation), publish a separate
  interactive prompt doc (for example `ui_id:"ui:model-routing:escalation"`).
- Update routing status docs each bounded pass before posting `ORCH_PASS`.
- On completion or handoff, remove model-routing-owned docs with explicit
  `mu_ui remove` actions. Prefer `remove` over `clear`.

### Canonical status doc (`ui:model-routing`)

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:model-routing",
    "title": "Model-routing status",
    "summary": "issue=<issue-id> · selected=openai-codex/gpt-5.3-codex/xhigh · alternates=2",
    "components": [
      {
        "kind": "key_value",
        "id": "route",
        "title": "Current route",
        "rows": [
          { "key": "policy", "value": "route:model-routing-v1" },
          { "key": "issue", "value": "<issue-id>" },
          { "key": "selected", "value": "openai-codex/gpt-5.3-codex/xhigh" },
          { "key": "alternates", "value": "2" },
          { "key": "next", "value": "Launch worker with explicit overrides" }
        ],
        "metadata": {}
      },
      {
        "kind": "list",
        "id": "recent",
        "title": "Recent routing events",
        "items": [
          {
            "id": "e1",
            "label": "ROUTE_RECOMMENDATION posted",
            "detail": "selected openai-codex/gpt-5.3-codex/xhigh"
          },
          {
            "id": "e2",
            "label": "fallback budget",
            "detail": "openrouter/google/gemini-3.1-pro-preview/high"
          }
        ],
        "metadata": {}
      }
    ],
    "actions": [],
    "revision": { "id": "model-routing-status", "version": 7 },
    "updated_at_ms": 1772069500000,
    "metadata": {
      "profile": {
        "id": "model-routing",
        "variant": "status",
        "snapshot": {
          "compact": "selected=openai-codex/gpt-5.3-codex/xhigh · alternates=2",
          "multiline": "issue: <issue-id>\nselected: openai-codex/gpt-5.3-codex/xhigh\nalternates: 2\nnext: launch worker"
        }
      }
    }
  }
}
```

### Canonical escalation prompt (`ui:model-routing:escalation`)

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:model-routing:escalation",
    "title": "Routing escalation required",
    "summary": "No authenticated model satisfies image + deep reasoning constraints.",
    "components": [
      {
        "kind": "text",
        "id": "question",
        "text": "Routing is blocked by missing provider capability. Should execution wait for provider auth or run with degraded constraints?",
        "metadata": {}
      },
      {
        "kind": "list",
        "id": "options",
        "title": "Choices",
        "items": [
          { "id": "opt-auth", "label": "Pause and authenticate provider" },
          { "id": "opt-degrade", "label": "Proceed with degraded route" }
        ],
        "metadata": {}
      }
    ],
    "actions": [
      {
        "id": "wait-for-auth",
        "label": "Wait for provider auth",
        "kind": "primary",
        "payload": {},
        "metadata": { "command_text": "/answer wait-for-auth" }
      },
      {
        "id": "approve-degraded-route",
        "label": "Approve degraded route",
        "kind": "secondary",
        "payload": {},
        "metadata": { "command_text": "/answer approve-degraded-route" }
      }
    ],
    "revision": { "id": "model-routing-escalation", "version": 1 },
    "updated_at_ms": 1772069510000,
    "metadata": {
      "profile": {
        "id": "model-routing-escalation",
        "variant": "interactive"
      }
    }
  }
}
```

### Teardown / handoff

```json
{"action":"remove","ui_id":"ui:model-routing:escalation"}
{"action":"remove","ui_id":"ui:model-routing"}
```

## Evaluation scenarios

1. **Coding leaf selects deep coding model**
   - Setup: `route:task:code`, `route:depth:deep`, authenticated coding provider.
   - Expected: recommendation picks a deep reasoning coding model and starts work.

2. **Docs leaf prefers writing model**
   - Setup: `route:task:docs` with root `ROUTE_POLICY` preference for docs.
   - Expected: recommendation uses preferred docs model when available, otherwise fallback.

3. **Auth/provider drift fallback**
   - Setup: selected provider becomes unauthenticated mid-run.
   - Expected: `ROUTE_FALLBACK` packet and alternate selection in next bounded pass.

4. **Hard requirement escalation**
   - Setup: issue requires image input but no authenticated image-capable models.
   - Expected: `kind:ask` node created; downstream remains blocked until user action.
