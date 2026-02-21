---
name: planning
description: Investigate first, use the planning HUD as the user-facing status channel, then propose and refine a concrete issue DAG until approved.
---

# Planning

Use this skill when the user asks for planning, decomposition, or a staged execution roadmap.

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

## Core contract

1. **Investigate first**
   - Read relevant code/docs/state before proposing work.
   - Avoid speculative plans when evidence is cheap to gather.

2. **Materialize the plan in mu issues**
   - Create a root planning issue and concrete child issues.
   - Encode dependencies so the DAG reflects execution order.
   - Add clear titles, scope, acceptance criteria, and role tags.

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
# 1) Create root planning issue
mu issues create "<Goal>" --body "<scope + success criteria>" --tag node:root --pretty

# 2) Create child work items
mu issues create "<Subtask A>" --parent <root-id> --priority 2 --pretty
mu issues create "<Subtask B>" --parent <root-id> --priority 2 --pretty

# 3) Add dependency edges where needed
mu issues dep <child-a-id> blocks <child-b-id>

# 4) Validate ready set
mu issues ready --root <root-id> --pretty
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
- Re-run `mu issues ready --root <root-id> --pretty`.
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

## Quality bar

- Every issue should be actionable and testable.
- Keep tasks small enough to complete in one focused pass.
- Explicitly call out uncertain assumptions for user confirmation.
- Prefer reversible plans and incremental checkpoints.
- HUD state must be fresh, accurate, and aligned with user-visible status updates.
