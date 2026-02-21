---
name: planning
description: Investigate first, then propose a concrete issue plan and refine it with the user until approved.
---

# Planning

Use this skill when the user asks for planning, decomposition, or a staged execution roadmap.

## Core contract

1. **Investigate first**
   - Read relevant code/docs/state before proposing work.
   - Avoid speculative plans when evidence is cheap to gather.

2. **Materialize the plan in mu issues**
   - Create a root planning issue and concrete child issues.
   - Encode dependencies so the DAG reflects execution order.
   - Add clear titles, scope, acceptance criteria, and role tags.

3. **Present the plan to the user**
   - Summarize goals, sequencing, risks, and tradeoffs.
   - Include issue IDs so the user can reference exact nodes.

4. **Iterate until user approval**
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

Also inspect repo files directly (read/bash) for implementation constraints.

### B) Draft DAG in mu-issue

```bash
# 1) Create root planning issue
mu issues create "<Goal>" --body "<scope + success criteria>" --tag node:root --role orchestrator --pretty

# 2) Create child work items
mu issues create "<Subtask A>" --parent <root-id> --role worker --priority 2 --pretty
mu issues create "<Subtask B>" --parent <root-id> --role worker --priority 2 --pretty

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

### D) Revision loop

- Apply feedback with `mu issues update` / `mu issues dep` / additional issues.
- Re-run `mu issues ready --root <root-id> --pretty`.
- Present a concise diff of what changed and why.

## Quality bar

- Every issue should be actionable and testable.
- Keep tasks small enough to complete in one focused pass.
- Explicitly call out uncertain assumptions for user confirmation.
- Prefer reversible plans and incremental checkpoints.
