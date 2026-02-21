---
name: reviewer
description: Run a dedicated reviewer pass in tmux and return a strict verdict with evidence.
---

# Reviewer

Use this skill when you want a separate reviewer lane that audits work before finalizing.

## Goals

- Isolate review from implementation context.
- Require explicit pass/fail criteria.
- Produce concrete evidence (tests, diffs, traces) for the verdict.

## Reviewer lane pattern

```bash
run_id="$(date +%Y%m%d-%H%M%S)"
review_session="mu-review-${run_id}"

# Start a dedicated reviewer session
# (Use the same repo and server port as the main workflow.)
tmux new-session -d -s "$review_session" \
  "cd '$PWD' && mu session --new --port 3000 ; rc=\$?; echo __MU_DONE__:\$rc"
```

Then inject a strict reviewer prompt in that tmux pane (attach or send keys) with:

- Scope under review
- Acceptance criteria
- Required checks (build/test/lint, edge cases, regressions)
- Required output format: `PASS` or `FAIL`, plus blockers and fixes

## Suggested reviewer prompt shape

- "Act as a strict reviewer. Validate only against these acceptance criteria..."
- "Run the necessary checks and cite concrete evidence."
- "Return: verdict, evidence, risk list, and required fixes."

## Monitoring and collection

```bash
tmux capture-pane -pt "$review_session" -S -300
tmux attach -t "$review_session"
```

If the reviewer leaves open questions, ask follow-up turns in the same reviewer session:

```bash
mu session list --json --pretty
mu turn --session-kind operator --session-id <session-id> --body "Clarify blocker #2"
```

Use `--session-kind operator` for terminal/tmux reviewer sessions.
If omitted, `mu turn` defaults to control-plane operator sessions (`cp_operator`).

Once complete, summarize reviewer findings back into the main workflow and create follow-up issues for each blocker.

## Safety rules

- Reviewer must not silently relax acceptance criteria.
- Prefer failing with explicit evidence over guessing.
- Keep reviewer output actionable (file paths, commands, failing checks).
- Close/kill temporary tmux sessions after review.
