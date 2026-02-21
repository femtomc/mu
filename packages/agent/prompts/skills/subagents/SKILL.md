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
mu issues create "Root: <goal>" --tag node:root

# Child issues (repeat as needed)
mu issues create "<child-1 deliverable>" --parent <root-id> --priority 2
mu issues create "<child-2 deliverable>" --parent <root-id> --priority 2

# Optional ordering constraints
mu issues dep <child-1> blocks <child-2>

# Verify queue before fan-out
mu issues ready --root <root-id> --pretty
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
For durable wake loops, use `mu heartbeats ...` / `mu cron ...`.

## Monitoring

```bash
tmux ls | rg '^mu-sub-'
tmux capture-pane -pt mu-sub-<run-id>-<issue-id> -S -200
tmux attach -t mu-sub-<run-id>-<issue-id>

# Issue queue visibility (same root used for dispatch)
mu issues ready --root <root-id> --pretty
mu issues list --root <root-id> --status in_progress --pretty
```

Optional live monitor widget (interactive operator session):

```text
/mu subagents on
/mu subagents prefix mu-sub-
/mu subagents root <root-id>
/mu subagents tag node:agent
/mu subagents mode operator
/mu subagents refresh-interval 8
/mu subagents stale-after 60
/mu subagents pause off
/mu subagents refresh
/mu subagents spawn 3
/mu subagents snapshot
```

The widget tracks queue and tmux drift, supports spawn profiles, and can pause spawning.
Use `snapshot` for a user-facing status summary.

Tool contract (preferred when tools are available):

- Tool: `mu_subagents_hud`
- Actions:
  - state: `status`, `snapshot`, `on`, `off`, `toggle`, `refresh`
  - scope: `set_prefix`, `set_root`, `set_tag`
  - policy: `set_mode`, `set_refresh_interval`, `set_stale_after`, `set_spawn_paused`
  - dispatch: `spawn`
  - atomic: `update`
- Key parameters:
  - `prefix`: tmux prefix or `clear`
  - `root_issue_id`: issue root ID or `clear`
  - `issue_tag`: issue tag filter (for example `node:agent`) or `clear`
  - `spawn_mode`: `operator|researcher`
  - `refresh_seconds`: 2..120
  - `stale_after_seconds`: 10..3600
  - `spawn_paused`: boolean
  - `count`: integer 1..40 or `"all"` for spawn

Example tool calls:
- Configure root + tag + mode atomically:
  - `{"action":"update","root_issue_id":"<root-id>","issue_tag":"node:agent","spawn_mode":"operator","spawn_paused":false}`
- Tune monitor policy:
  - `{"action":"set_refresh_interval","refresh_seconds":5}`
  - `{"action":"set_stale_after","stale_after_seconds":45}`
- Spawn from ready queue:
  - `{"action":"spawn","count":3}`

## Handoffs and follow-up turns

With `mu exec`, follow up by issuing another `mu exec` command in the same tmux pane
(scoped to the same issue id):

```bash
mu exec "Continue issue <issue-id>. Address feedback: ..."
```

If you intentionally use long-lived terminal operator sessions (`mu serve`),
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
- Pause spawning when the queue is unstable or blocked.
- Tear down temporary tmux sessions when done.
