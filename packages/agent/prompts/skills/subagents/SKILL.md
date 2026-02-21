---
name: subagents
description: Break work into issue-tracked shards and dispatch mu subagents in tmux sessions.
---

# Subagents

Use this skill when work can be split into independent shards and run concurrently.

## When to use

- The task can be decomposed into parallelizable parts.
- Each shard can be specified with a clear prompt and bounded outcome.
- You need a durable terminal surface to inspect each shard separately.

## Workflow

1. Create a root issue and decompose into 2–4 actionable child issues in `mu issues`.
2. Ensure each child has clear acceptance criteria and dependency edges.
3. Launch one detached tmux session per ready child issue.
4. Monitor both tmux sessions and issue queue state, then reconcile outputs.

## Launch pattern

Issue-first decomposition (required before dispatch):

```bash
# Root issue
mu issues create "Root: <goal>" --tag node:root --role orchestrator

# Child issues (repeat as needed)
mu issues create "<child-1 deliverable>" --parent <root-id> --role worker --priority 2
mu issues create "<child-2 deliverable>" --parent <root-id> --role worker --priority 2

# Optional ordering constraints
mu issues dep <child-1> blocks <child-2>

# Verify queue before fan-out
mu issues ready --root <root-id> --tag role:worker --pretty
```

Dispatch one tmux subagent per ready issue id:

```bash
run_id="$(date +%Y%m%d-%H%M%S)"

# Optional: keep one shared server alive for all shards
mu serve --port 3000

for issue_id in <issue-a> <issue-b> <issue-c>; do
  session="mu-sub-${run_id}-${issue_id}"
  tmux new-session -d -s "$session" \
    "cd '$PWD' && mu exec 'Work issue ${issue_id}. First: mu issues claim ${issue_id}. Keep forum updates on issue:${issue_id}. Close when complete.' ; rc=\$?; echo __MU_DONE__:\$rc"
done
```

Use `mu exec` for lightweight one-shot subagent work.
If you need queued orchestration runs, use `mu runs start ...` / `mu run ...` instead.

## Monitoring

```bash
tmux ls | rg '^mu-sub-'
tmux capture-pane -pt mu-sub-<run-id>-<issue-id> -S -200
tmux attach -t mu-sub-<run-id>-<issue-id>

# Issue queue visibility (same root used for dispatch)
mu issues ready --root <root-id> --tag role:worker --pretty
mu issues list --root <root-id> --status in_progress --tag role:worker --pretty
```

Optional live monitor widget (interactive operator session):

```text
/mu subagents on
/mu subagents prefix mu-sub-
/mu subagents root <root-id>
/mu subagents role role:worker
/mu subagents refresh
/mu subagents spawn 3
```

The widget picks up tracker decomposition by reading `mu issues ready` and
`mu issues list --status in_progress`.
Use `spawn` to launch tmux sessions directly from the ready queue for the
current root/tag filter.

## Handoffs and follow-up turns

With `mu exec`, follow up by issuing another `mu exec` command in the same tmux pane
(scoped to the same issue id):

```bash
mu exec "Continue issue <issue-id>. Address feedback: ..."
```

If you intentionally use long-lived terminal operator sessions (`mu run`/`mu serve`),
you can hand off with `mu turn`:

```bash
mu session list --json --pretty
mu turn --session-kind operator --session-id <session-id> --body "Follow-up question"
```

Use `--session-kind operator` for terminal/tmux sessions.
If omitted, `mu turn` defaults to control-plane operator sessions (`cp_operator`).

## Reconciliation checklist

- Collect outputs from each issue-owned shard.
- Confirm each claimed issue is closed with an explicit outcome.
- Identify conflicts or overlaps across child issues.
- Produce one merged plan/result with explicit decisions.
- Record follow-up tasks in `mu issues` / `mu forum`.

## Safety rules

- Keep shard prompts scoped and explicit.
- Prefer fewer, higher-quality shards over many noisy shards.
- Do not overwrite unrelated files across shards.
- Tear down temporary tmux sessions when done.
