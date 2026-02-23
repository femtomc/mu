---
name: planning
description: "Builds and refines issue-DAG plans using the planning HUD and approval loops. Use when the user asks for planning, decomposition, sequencing, or plan review."
---

# Planning

Use this skill when the user asks for planning, decomposition, or a staged execution roadmap.

## Contents

- [Planning HUD is required](#planning-hud-is-required)
- [Shared protocol dependency](#shared-protocol-dependency)
- [Core contract](#core-contract)
- [Suggested workflow](#suggested-workflow)
- [Effective HUD usage heuristics](#effective-hud-usage-heuristics)
- [Evaluation scenarios](#evaluation-scenarios)
- [Quality bar](#quality-bar)

## Planning HUD is required

For this skill, the planning HUD is the primary status/communication surface.

- Keep HUD state in sync with real planning progress.
- Update HUD before and after each major planning turn.
- Use `waiting_on_user`, `next_action`, and `blocker` to communicate exactly what the user needs to do.
- Include a HUD snapshot in user-facing planning updates.

Default per-turn HUD loop:

1. Apply an atomic `update` with current `phase`, `waiting_on_user`, `next_action`, `blocker`, and `confidence`.
2. Synchronize checklist items and `root_issue_id` with the issue DAG.
3. Emit `snapshot` (`compact` or `multiline`) and reflect it in your response.

## Shared protocol dependency

This skill plans DAGs for execution by `subagents`, so planning must follow the
shared protocol in **`hierarchical-work-protocol`**.

Before creating or reshaping DAG nodes, load that skill and use its canonical:

- protocol identity/tag (`hierarchical-work.protocol/v1`, `proto:hierarchical-work-v1`)
- node kinds and context tags
- invariants for executable vs non-executable nodes
- planning handoff contract

Do not invent alternate protocol names or tag schemas.

## Core contract

1. **Investigate first**
   - Read relevant code/docs/state before proposing work.
   - Avoid speculative plans when evidence is cheap to gather.

2. **Materialize the plan in mu issues using the shared protocol**
   - Create root and child issues that comply with `hierarchical-work.protocol/v1`.
   - Encode dependencies so the DAG reflects execution order and synth fan-in.
   - Add clear titles, scope, acceptance criteria, and protocol tags.

3. **Drive communication through the planning HUD**
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

6. **After user approval, ask user about next steps*
   - On user acceptance of the plan, turn the planning HUD off
   - Read the `subagents` skill and offer to supervise subagents to execute the plan

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
/mu plan on
/mu plan phase investigating
/mu plan waiting off
/mu plan confidence medium
/mu plan next "Investigate constraints and gather evidence"
/mu plan snapshot
```

Tool contract (preferred when tools are available):

- Tool: `mu_planning_hud`
- Actions:
  - state: `status`, `snapshot`, `on`, `off`, `toggle`, `reset`, `phase`, `root`
  - checklist: `check`, `uncheck`, `toggle_step`, `set_steps`, `add_step`, `remove_step`, `set_step_label`
  - communication: `set_waiting`, `set_next`, `set_blocker`, `set_confidence`
  - atomic: `update`
- Key parameters:
  - `phase`: `investigating|drafting|reviewing|waiting_user|blocked|executing|approved|done`
  - `root_issue_id`: issue ID or `clear`
  - `waiting_on_user`: boolean
  - `next_action`, `blocker`: string or `clear`
  - `confidence`: `low|medium|high`
  - `steps`: string[]
  - `step_updates`: array of `{index, done?, label?}`

Example tool calls:
- Atomic status update for an investigation turn:
  - `{"action":"update","phase":"investigating","waiting_on_user":false,"next_action":"Draft root issue and child DAG","blocker":"clear","confidence":"medium"}`
- Atomic handoff when waiting for approval:
  - `{"action":"update","phase":"waiting_user","waiting_on_user":true,"next_action":"Confirm scope change","blocker":"Need approval","confidence":"low"}`
- Clear communication fields after user reply:
  - `{"action":"update","waiting_on_user":false,"blocker":"clear","next_action":"Incorporate feedback and re-draft DAG"}`
- Customize checklist:
  - `{"action":"set_steps","steps":["Investigate","Draft DAG","Review with user","Finalize"]}`
- Human-facing status line:
  - `{"action":"snapshot","snapshot_format":"compact"}`

If HUD behavior is unclear, inspect implementation/tests before guessing:
- `packages/agent/src/extensions/planning-ui.ts`
- `packages/agent/test/planning_ui_tool.test.ts`

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

```text
/mu plan root <root-id>
/mu plan phase drafting
/mu plan check 1
/mu plan phase waiting-user
/mu plan waiting on
/mu plan next "Need your approval on tradeoff A/B"
/mu plan snapshot
```

## Effective HUD usage heuristics

- Prefer `update` for multi-field changes to avoid inconsistent intermediate state.
- Reserve `waiting_user` for explicit user input/decision waits; use `blocked` for non-user blockers.
- Keep `next_action` as one concrete action, not a paragraph.
- Adjust `confidence` as evidence quality changes (`low` when assumptions are unresolved).
- Customize checklist steps once scope is understood; check them off as milestones complete.

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
- HUD state must be fresh, accurate, and aligned with user-visible status updates.
