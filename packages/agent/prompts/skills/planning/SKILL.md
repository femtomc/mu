---
name: planning
description: "Builds and refines issue-DAG plans using the planning HUD and approval loops. Use when the user asks for planning, decomposition, sequencing, or plan review."
---

# Planning

Use this skill when the user asks for planning, decomposition, or a staged execution roadmap.

## Contents

- [Planning HUD is required](#planning-hud-is-required)
- [HUD skill dependency](#hud-skill-dependency)
- [Shared protocol dependency](#shared-protocol-dependency)
- [Core contract](#core-contract)
- [Suggested workflow](#suggested-workflow)
- [Effective HUD usage heuristics](#effective-hud-usage-heuristics)
- [Evaluation scenarios](#evaluation-scenarios)
- [Quality bar](#quality-bar)

## Planning HUD is required

For this skill, the planning HUD is the primary status/communication surface.
HUD usage is not optional for planning turns.

- Keep HUD state in sync with real planning progress.
- Update HUD before and after each major planning turn.
- Use `waiting_on_user`, `next_action`, and `blocker` to communicate exactly what the user needs to do.
- Include a HUD snapshot in user-facing planning updates.
- Teardown/handoff HUD state explicitly when planning ends or transitions to another HUD-owning skill.

Default per-turn HUD loop:

1. Emit a fresh `planning` HUD doc (`mu_hud` action `set` or `update`) with current `phase`, `waiting_on_user`, `next_action`, `blocker`, and `confidence` in sections/metadata.
2. Keep checklist progress and root issue linkage synchronized with the live issue DAG.
3. Emit `snapshot` (`compact` or `multiline`) and reflect it in your response.


## HUD skill dependency

Before emitting or mutating planning HUD state, load **`hud`** and follow its canonical contract.

- Treat `hud` as source-of-truth for generic `mu_hud` actions, `HudDoc` shape, and rendering constraints.
- This planning skill defines planning-specific conventions only (for example `hud_id: "planning"`, planning phases, checklist semantics).

## Shared protocol dependency

This skill plans DAGs for execution by `subagents`, so planning must follow the
shared protocol in **`orchestration`**.

Before creating or reshaping DAG nodes, load that skill and use its canonical:

- protocol identity/tag (`hierarchical-work.protocol/v1`, `proto:hierarchical-work-v1`)
- node kinds and context tags
- invariants for executable vs non-executable nodes
- planning handoff contract

Do not invent alternate protocol names or tag schemas.

If the user asks for explicit loop/termination behavior (for example review-gated
retry rounds), load **`control-flow`** and encode policy via `flow:*` overlays
without changing orchestration protocol semantics.

If the user asks for per-issue model/provider/thinking recommendations based on
live harness capabilities, load **`model-routing`** and encode policy via
`route:*` overlays plus route packets (for example `ROUTE_POLICY`) without
changing orchestration protocol semantics.

## Core contract

1. **Investigate first**
   - Read relevant code/docs/state before proposing work.
   - Avoid speculative plans when evidence is cheap to gather.

2. **Materialize the plan in mu issues using the shared protocol**
   - Create root and child issues that comply with `hierarchical-work.protocol/v1`.
   - Encode dependencies so the DAG reflects execution order and synth fan-in.
   - Add clear titles, scope, acceptance criteria, and protocol tags.
   - When model specialization is required, attach explicit `route:*` intent tags/constraints to executable nodes.

3. **Drive communication through the planning HUD**
   - Load `hud` and use its canonical `mu_hud`/`HudDoc` contract.
   - Treat HUD state as the canonical short status line for planning.
   - Keep `phase`, `waiting_on_user`, `next_action`, `blocker`, and `confidence` current.
   - Ensure HUD state and your natural-language response never contradict each other.

4. **Present the plan to the user**
   - Summarize goals, sequencing, risks, and tradeoffs.
   - Include issue IDs so the user can reference exact nodes.
   - Include a HUD snapshot line.

5. **Iterate until user approval**
   - Treat user feedback as first-class constraints.
   - Update issues/dependencies and re-present deltas.
   - Do not begin broad execution until the user signals satisfaction.

6. **After user approval, ask user about next steps**
   - On user acceptance of the plan, teardown planning HUD ownership.
   - If handing off to another HUD-owning skill (for example `subagents`), remove
     `hud_id:"planning"` and keep HUD on for the next skill.
   - If no next HUD-owning skill starts immediately, remove planning doc and turn HUD off.
   - Read the `subagents` skill and offer to supervise subagents to execute the plan.

## Suggested workflow

### A) Investigation pass

```bash
mu status --pretty
mu issues list --status open --limit 50 --pretty
mu forum read user:context --limit 50 --pretty
mu memory search --query "<topic>" --limit 30
```

Bootstrap HUD immediately (interactive operator session):

```text
/mu hud on
/mu hud status
/mu hud snapshot
```

Tool contract (preferred when tools are available):

- Canonical contract: see skill `hud`
- Tool: `mu_hud`
- Actions: `status`, `snapshot`, `on`, `off`, `toggle`, `set`, `update`, `replace`, `remove`, `clear`
- Planning convention: maintain a HUD doc with `hud_id: "planning"`
- Suggested planning doc structure:
  - `title`: `Planning HUD`
  - chips: `phase:<...>`, `steps:<done>/<total>`, `waiting:<yes|no>`, `conf:<low|medium|high>`
  - sections:
    - `kv` status block (`phase`, `root`, `waiting_on_user`, `confidence`, `next_action`, `blocker`)
    - `checklist` block for plan milestones
  - actions: include useful follow-ups (for example, `snapshot`)
  - metadata: include `style_preset:"planning"` for consistent renderer emphasis without repeating style hints

Example tool calls:
- Turn HUD on:
  - `{"action":"on"}`
- Set/replace planning doc after investigation pass:
  - `{"action":"set","doc":{"v":1,"hud_id":"planning","title":"Planning HUD","scope":"mu-root-123","chips":[{"key":"phase","label":"phase:investigating","tone":"dim"},{"key":"steps","label":"steps:1/4","tone":"accent"},{"key":"waiting","label":"waiting:no","tone":"dim"},{"key":"confidence","label":"conf:medium","tone":"accent"}],"sections":[{"kind":"kv","title":"Status","items":[{"key":"phase","label":"phase","value":"investigating"},{"key":"root","label":"root","value":"mu-root-123"},{"key":"waiting","label":"waiting_on_user","value":"no"},{"key":"confidence","label":"confidence","value":"medium"},{"key":"next","label":"next_action","value":"Draft root DAG"},{"key":"blocker","label":"blocker","value":"(none)"}]},{"kind":"checklist","title":"Checklist","items":[{"id":"1","label":"Investigate relevant code/docs/state","done":true},{"id":"2","label":"Create root + child issue DAG","done":false},{"id":"3","label":"Present plan + tradeoffs","done":false},{"id":"4","label":"Refine until approved","done":false}]}],"actions":[{"id":"snapshot","label":"Snapshot","command_text":"/mu hud snapshot","kind":"secondary"}],"snapshot_compact":"HUD(plan) · phase=investigating · steps=1/4 · waiting=no · conf=medium","updated_at_ms":1771853115000,"metadata":{"style_preset":"planning","phase":"investigating","waiting_on_user":false,"confidence":"medium"}}}`
- Human-facing status line:
  - `{"action":"snapshot","snapshot_format":"compact"}`

If HUD behavior is unclear, inspect implementation/tests before guessing:
- `packages/agent/src/extensions/hud.ts`
- `packages/agent/test/hud_tool.test.ts`

Also inspect repo files directly (read/bash) for implementation constraints.

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
- HUD snapshot (compact line)

### D) Revision loop

- Apply feedback with `mu issues update` / `mu issues dep` / additional issues.
- Re-run `mu issues ready --root <root-id> --tag proto:hierarchical-work-v1 --pretty`.
- Validate protocol-root status via `mu issues validate <root-id>`.
- Present a concise diff of what changed and why.
- Update HUD each turn so phase/waiting/next/blocker/confidence match the latest state.

Required HUD updates during the loop:

- Re-emit the `planning` HUD doc with current `phase`, checklist progress, `waiting_on_user`, `next_action`, and `blocker` after each meaningful planning step.
- Use `{"action":"snapshot","snapshot_format":"compact"}` for concise user-facing HUD lines.
- Keep `updated_at_ms` monotonic across updates so latest doc wins deterministically.
- On plan completion/handoff, remove `hud_id:"planning"` and apply handoff/off semantics from the `hud` skill.

## Effective HUD usage heuristics

- Keep one canonical planning doc (`hud_id: "planning"`) and refresh it whenever planning state changes.
- Keep `updated_at_ms` monotonic so deterministic dedupe/ordering always keeps the latest planning state.
- Use explicit, concise status fields (`phase`, `waiting_on_user`, `next_action`, `blocker`, `confidence`) in sections/metadata.
- Keep `next_action` as one concrete action, not a paragraph.
- Customize checklist steps once scope is understood; mark them complete as milestones land.

## Evaluation scenarios

1. **Initial decomposition request**
   - Prompt: user asks for a staged roadmap.
   - Expected: investigation pass runs first, root + child issues are created with `proto:hierarchical-work-v1`, HUD shows `phase=drafting` and `waiting_on_user=false` until first review checkpoint.

2. **Feedback-driven replan**
   - Prompt: user requests scope change after first DAG draft.
   - Expected: dependency/issue updates are applied, concise change diff is presented, HUD transitions through `reviewing`/`waiting_user` with updated `next_action`.

3. **Blocked-by-missing-input planning turn**
   - Prompt: required architecture constraint is unknown.
   - Expected: plan captures explicit assumption gap, HUD uses `phase=blocked` or `waiting_user` (as appropriate), and asks one concrete unblock question.

## Quality bar

- Every issue should be actionable and testable.
- DAG nodes must satisfy `hierarchical-work.protocol/v1` before execution handoff.
- Keep tasks small enough to complete in one focused pass.
- Explicitly call out uncertain assumptions for user confirmation.
- Prefer reversible plans and incremental checkpoints.
- If `model-routing` is in scope, route intent/constraints are explicit and non-conflicting.
- HUD state must be fresh, accurate, and aligned with user-visible status updates.
