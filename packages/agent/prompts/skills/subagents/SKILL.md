---
name: subagents
description: Break a task into independent parts and dispatch mu subagents in tmux sessions.
---

# Subagents

Use this skill when work can be split into independent shards and run concurrently.

## When to use

- The task can be decomposed into parallelizable parts.
- Each shard can be specified with a clear prompt and bounded outcome.
- You need a durable terminal surface to inspect each shard separately.

## Workflow

1. Decompose into 2–4 independent subtasks with explicit deliverables.
2. Launch one detached tmux session per subtask.
3. Run a `mu` invocation in each session.
4. Monitor each pane, then reconcile outputs into one final synthesis.

## Launch pattern

```bash
run_id="$(date +%Y%m%d-%H%M%S)"

# Optional: keep one shared server alive for all shards
mu serve --port 3000

# In another terminal, dispatch shards
for shard in 1 2 3; do
  session="mu-sub-${run_id}-${shard}"
  tmux new-session -d -s "$session" \
    "cd '$PWD' && mu run 'SUBTASK_PROMPT_${shard}' ; rc=\$?; echo __MU_DONE__:\$rc"
done
```

If you need non-interactive queueing, use `mu runs start ...` in tmux windows instead of `mu run ...`.

## Monitoring

```bash
tmux ls | rg '^mu-sub-'
tmux capture-pane -pt mu-sub-<run-id>-1 -S -200
tmux attach -t mu-sub-<run-id>-1
```

## Handoffs and follow-up turns

When a subagent session already exists, ask direct follow-ups in that same session:

```bash
mu session list --json --pretty
mu turn --session-kind operator --session-id <session-id> --body "Follow-up question"
```

Use `--session-kind operator` for terminal/tmux subagent sessions.
If omitted, `mu turn` defaults to control-plane operator sessions (`cp_operator`).

## Reconciliation checklist

- Collect outputs from each shard.
- Identify conflicts or overlaps.
- Produce one merged plan/result with explicit decisions.
- Record any follow-up tasks in `mu issues` / `mu forum`.

## Safety rules

- Keep shard prompts scoped and explicit.
- Prefer fewer, higher-quality shards over many noisy shards.
- Do not overwrite unrelated files across shards.
- Tear down temporary tmux sessions when done.
