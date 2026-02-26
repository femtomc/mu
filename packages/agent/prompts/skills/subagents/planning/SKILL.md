---
name: planning
description: "Builds and refines issue-DAG plans using mu_ui status/prompt docs and approval loops. Use when the user asks for planning, decomposition, sequencing, or plan review."
---

# planning

Use this skill when the user asks for planning, decomposition, or a staged
execution roadmap.

## Contents

- [Planning communication contract (mu_ui-first)](#planning-communication-contract-mu_ui-first)
- [mu_ui communication dependency](#mu_ui-communication-dependency)
- [Shared protocol dependency](#shared-protocol-dependency)
- [Core contract](#core-contract)
- [Suggested workflow](#suggested-workflow)
- [Planning UI canonical docs](#planning-ui-canonical-docs)
- [Effective mu_ui usage heuristics](#effective-mu_ui-usage-heuristics)
- [Evaluation scenarios](#evaluation-scenarios)
- [Quality bar](#quality-bar)

## Planning communication contract (mu_ui-first)

For this skill, `mu_ui` is the primary operator↔human communication surface.

- Keep one status doc at `ui_id:"ui:planning"` during active planning turns.
- Keep status docs non-interactive (`actions: []`).
- Publish user-decision prompts in a separate interactive doc (for example
  `ui_id:"ui:planning:approval"`) with `action.metadata.command_text`.
- Update planning UI docs before and after each major planning turn.
- Keep status-profile metadata current:
  - `metadata.profile.id: "planning"`
  - `metadata.profile.variant: "status"`
  - `metadata.profile.snapshot.compact|multiline`
- Teardown or hand off planning-owned docs explicitly when planning completes.

Default per-turn planning UI loop:

1. Upsert `ui:planning` with current `phase`, `waiting_on_user`,
   `next_action`, `blocker`, and `confidence`.
2. Keep checklist progress and root-issue linkage synchronized with the live DAG.
3. If user input is needed, upsert `ui:planning:approval` with concrete choices.
4. Use `mu_ui` snapshot/status output in user-facing planning updates.

## mu_ui communication dependency

Before publishing planning visibility or user prompts, use **`mu_ui`** and the
`/mu ui` command surface.

- Tool: `mu_ui`
- Actions: `status`, `snapshot`, `set`, `update`, `replace`, `remove`, `clear`
- Operator commands:
  - `/mu ui status`
  - `/mu ui snapshot compact`
  - `/mu ui snapshot multiline`
  - `/mu ui interact [ui_id [action_id]]`

If behavior is unclear, inspect implementation/tests before guessing:

- `packages/agent/src/extensions/ui.ts`
- `packages/agent/test/ui_extension.test.ts`
- `docs/mu-ui.md`

## Shared protocol dependency

This skill plans DAGs for execution by `execution`, so planning must follow the
shared protocol in **`protocol`**.

Before creating or reshaping DAG nodes, load that skill and use its canonical:

- protocol identity/tag (`hierarchical-work.protocol/v1`,
  `proto:hierarchical-work-v1`)
- node kinds and context tags
- invariants for executable vs non-executable nodes
- planning handoff contract

Do not invent alternate protocol names or tag schemas.

If the user asks for explicit loop/termination behavior (for example
review-gated retry rounds), load **`control-flow`** and encode policy via
`flow:*` overlays without changing protocol semantics.

If the user asks for per-issue model/provider/thinking recommendations based on
live harness capabilities, load **`model-routing`** and encode policy via
`route:*` overlays plus route packets (for example `ROUTE_POLICY`) without
changing protocol semantics.

## Core contract

1. **Investigate first**
   - Read relevant code/docs/state before proposing work.
   - Avoid speculative plans when evidence is cheap to gather.

2. **Materialize the plan in mu issues using the shared protocol**
   - Create root and child issues that comply with
     `hierarchical-work.protocol/v1`.
   - Encode dependencies so the DAG reflects execution order and synth fan-in.
   - Add clear titles, scope, acceptance criteria, and protocol tags.
   - When model specialization is required, attach explicit `route:*`
     intent tags/constraints to executable nodes.

3. **Drive communication through mu_ui**
   - Keep `ui:planning` current as the canonical short planning status.
   - Keep `phase`, `waiting_on_user`, `next_action`, `blocker`, and
     `confidence` current in doc metadata/components.
   - Keep status docs non-interactive; isolate user decisions in separate
     interactive docs.
   - Ensure UI doc state and natural-language responses never contradict each
     other.

4. **Present the plan to the user**
   - Summarize goals, sequencing, risks, and tradeoffs.
   - Include issue IDs so the user can reference exact nodes.
   - Include one compact planning UI snapshot line.

5. **Iterate until user approval**
   - Treat user feedback as first-class constraints.
   - Update issues/dependencies and re-present deltas.
   - Do not begin broad execution until the user signals satisfaction.

6. **After user approval, ask user about next steps**
   - Remove resolved interactive planning docs (for example
     `ui:planning:approval`).
   - If handing off to `execution`, remove or replace `ui:planning` so
     ownership is unambiguous.
   - If no immediate follow-on skill starts, remove planning docs explicitly.
   - Read the `execution` skill and offer to supervise execution to realize the
     plan.

## Suggested workflow

### A) Investigation pass

```bash
mu status --pretty
mu issues list --status open --limit 50 --pretty
mu forum read user:context --limit 50 --pretty
mu memory search --query "<topic>" --limit 30
```

Inspect active planning UI state:

```text
/mu ui status
/mu ui snapshot compact
```

Tool checks (when tools are available):

```json
{"action":"status"}
{"action":"snapshot","snapshot_format":"compact"}
```

### B) Draft DAG in mu-issue

```bash
# 1) Create protocol root container
root_json="$(mu issues create "<Goal>" \
  --body "<scope + success criteria>" \
  --tag node:root \
  --tag kind:root \
  --tag proto:hierarchical-work-v1 \
  --json)"
root_id="$(echo "$root_json" | jq -r '.id')"
mu issues update "$root_id" --remove-tag node:agent

# 2) Create executable child work nodes
mu issues create "<Subtask A>" \
  --parent "$root_id" \
  --body "<acceptance criteria>" \
  --tag kind:spawn \
  --tag ctx:clean \
  --tag proto:hierarchical-work-v1 \
  --priority 2 --pretty

mu issues create "<Subtask B>" \
  --parent "$root_id" \
  --body "<acceptance criteria>" \
  --tag kind:fork \
  --tag ctx:inherit \
  --tag proto:hierarchical-work-v1 \
  --priority 2 --pretty

# 3) Add dependency edges where needed
mu issues dep <child-a-id> blocks <child-b-id>

# 4) Validate ready set + protocol scope
mu issues ready --root "$root_id" --tag proto:hierarchical-work-v1 --pretty
mu issues validate "$root_id"
```

### C) Plan presentation template

- Objective
- Assumptions and constraints discovered in investigation
- Proposed issue DAG (IDs + titles + ordering)
- Risks and mitigations
- Open questions for user approval
- Planning UI snapshot (compact line)

### D) Revision loop

- Apply feedback with `mu issues update` / `mu issues dep` / additional issues.
- Re-run `mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty`.
- Validate protocol-root status via `mu issues validate <root-id>`.
- Present a concise diff of what changed and why.
- Keep planning UI docs aligned with latest state each turn.

Required UI updates during the loop:

- Re-emit `ui:planning` with current `phase`, checklist progress,
  `waiting_on_user`, `next_action`, and `blocker` after each meaningful
  planning step.
- Use `{"action":"snapshot","snapshot_format":"compact"}` for concise
  user-facing snapshot lines.
- Keep `revision.version` and `updated_at_ms` monotonic across updates.
- On plan completion/handoff, remove planning-owned docs explicitly with
  `mu_ui remove`.

## Planning UI canonical docs

Use these as copy/paste templates for planning communication.

### Canonical status doc (`ui:planning`)

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:planning",
    "title": "Planning status",
    "summary": "phase=investigating · steps=1/4 · waiting=no · conf=medium",
    "components": [
      {
        "kind": "key_value",
        "id": "status",
        "title": "Status",
        "rows": [
          { "key": "phase", "value": "investigating" },
          { "key": "root", "value": "mu-root-123" },
          { "key": "waiting", "value": "no" },
          { "key": "confidence", "value": "medium" },
          { "key": "next", "value": "Draft root DAG" },
          { "key": "blocker", "value": "(none)" }
        ],
        "metadata": {}
      },
      {
        "kind": "list",
        "id": "checklist",
        "title": "Checklist",
        "items": [
          { "id": "c1", "label": "Investigate relevant code/docs/state", "detail": "done" },
          { "id": "c2", "label": "Create root + child issue DAG", "detail": "pending" },
          { "id": "c3", "label": "Present plan + tradeoffs", "detail": "pending" },
          { "id": "c4", "label": "Refine until approved", "detail": "pending" }
        ],
        "metadata": {}
      }
    ],
    "actions": [],
    "revision": { "id": "planning-status", "version": 3 },
    "updated_at_ms": 1772069100000,
    "metadata": {
      "phase": "investigating",
      "waiting_on_user": false,
      "confidence": "medium",
      "profile": {
        "id": "planning",
        "variant": "status",
        "snapshot": {
          "compact": "phase=investigating · steps=1/4 · waiting=no · conf=medium",
          "multiline": "phase: investigating\nsteps: 1/4\nwaiting_on_user: no\nconfidence: medium\nnext_action: Draft root DAG"
        }
      }
    }
  }
}
```

### Canonical approval prompt (`ui:planning:approval`)

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:planning:approval",
    "title": "Plan approval",
    "summary": "Need user decision before execution handoff.",
    "components": [
      {
        "kind": "text",
        "id": "question",
        "text": "Approve this plan for execution, or request one targeted revision?",
        "metadata": {}
      },
      {
        "kind": "list",
        "id": "options",
        "title": "Choices",
        "items": [
          { "id": "opt-approve", "label": "Approve and move to execution" },
          { "id": "opt-revise", "label": "Request one revision" }
        ],
        "metadata": {}
      }
    ],
    "actions": [
      {
        "id": "approve-plan",
        "label": "Approve plan",
        "kind": "primary",
        "payload": {},
        "metadata": { "command_text": "/answer approve-plan" }
      },
      {
        "id": "request-revision",
        "label": "Request revision",
        "kind": "secondary",
        "payload": { "reason": "<reason>" },
        "metadata": { "command_text": "/answer request-revision {{reason}}" }
      }
    ],
    "revision": { "id": "planning-approval", "version": 1 },
    "updated_at_ms": 1772069110000,
    "metadata": {
      "profile": {
        "id": "planning-approval",
        "variant": "interactive"
      }
    }
  }
}
```

### Teardown / handoff semantics

- Remove resolved decision prompts immediately.
- Remove or replace `ui:planning` when planning ends or execution takes over.
- Prefer `remove` over `clear` to avoid deleting docs owned by other skills.

```json
{"action":"remove","ui_id":"ui:planning:approval"}
{"action":"remove","ui_id":"ui:planning"}
```

## Effective mu_ui usage heuristics

- Keep one canonical status doc (`ui:planning`) and refresh it whenever planning
  state changes.
- Keep `revision.version` and `updated_at_ms` monotonic so replay/reconnect
  keeps the newest state deterministically.
- Keep status docs non-interactive; place user decisions in separate interactive
  docs.
- Keep `next_action` to one concrete action, not a paragraph.
- Keep approval prompts decision-shaped with explicit command-text actions.

## Evaluation scenarios

1. **Initial decomposition request**
   - Prompt: user asks for a staged roadmap.
   - Expected: investigation pass runs first, root + child issues are created
     with `proto:hierarchical-work-v1`, and `ui:planning` reflects
     `phase=drafting`, `waiting_on_user=false`.

2. **Feedback-driven replan**
   - Prompt: user requests scope change after first DAG draft.
   - Expected: dependency/issue updates are applied, concise change diff is
     presented, and planning UI transitions through `reviewing` and
     `waiting_on_user` states.

3. **Blocked-by-missing-input planning turn**
   - Prompt: required architecture constraint is unknown.
   - Expected: plan captures explicit assumption gap, `ui:planning` shows
     blocked/waiting status, and an interactive planning prompt asks one concrete
     unblock decision.

## Quality bar

- Every issue should be actionable and testable.
- DAG nodes must satisfy `hierarchical-work.protocol/v1` before execution
  handoff.
- Keep tasks small enough to complete in one focused pass.
- Explicitly call out uncertain assumptions for user confirmation.
- Prefer reversible plans and incremental checkpoints.
- If `model-routing` is in scope, route intent/constraints are explicit and
  non-conflicting.
- Planning UI state must be fresh, accurate, and aligned with user-visible
  status updates.
