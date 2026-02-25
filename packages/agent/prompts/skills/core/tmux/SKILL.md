---
name: tmux
description: "Provides canonical tmux session patterns for persistent REPLs, bounded command execution, and parallel worker fan-out."
---

# tmux

Use this skill when other workflows need durable shell state, long-lived REPLs,
or parallel worker sessions.

This is a transport/runtime primitive skill. It does not define task semantics;
it defines how to run sessions reliably.

## Contents

- [Core contract](#core-contract)
- [Session lifecycle primitives](#session-lifecycle-primitives)
- [Bounded execution protocol](#bounded-execution-protocol)
- [Parallel fan-out pattern](#parallel-fan-out-pattern)
- [Teardown and diagnostics](#teardown-and-diagnostics)
- [Integration map](#integration-map)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

1. **One logical task scope per session**
   - Reuse a session for one task/thread.
   - Use distinct names for unrelated tasks.

2. **Create-or-reuse, do not assume**
   - Always check `tmux has-session` before creating.

3. **Bound command passes**
   - Send one coherent pass, capture output, then decide the next pass.
   - Use completion markers when possible.

4. **Prefer explicit ownership**
   - Track which sessions this run created.
   - Tear down owned sessions at completion/handoff.

5. **Keep it simple**
   - `tmux` is a substrate; avoid extra protocol complexity unless the task requires it.

## Session lifecycle primitives

List and inspect:

```bash
tmux list-sessions
```

Create or reuse a shell session:

```bash
session="mu-shell-main"
tmux has-session -t "$session" 2>/dev/null || tmux new-session -d -s "$session" "bash --noprofile --norc -i"
```

Attach for manual inspection:

```bash
tmux attach -t "$session"
```

## Bounded execution protocol

Send one command pass and wait for a marker:

```bash
session="mu-shell-main"
token="__MU_DONE_$(date +%s%N)__"

tmux send-keys -t "$session" "echo start && pwd && ls" C-m
tmux send-keys -t "$session" "echo $token" C-m

for _ in $(seq 1 80); do
  out="$(tmux capture-pane -pt "$session" -S -200)"
  echo "$out" | grep -q "$token" && break
  sleep 0.05
done

printf "%s\n" "$out"
```

Use this same pattern for REPL sessions (`python3 -q`, `node`, `sqlite3`, etc.).

## Parallel fan-out pattern

Spawn one session per independent unit of work:

```bash
run_id="$(date +%Y%m%d-%H%M%S)"
for work_id in a b c; do
  session="mu-worker-${run_id}-${work_id}"
  tmux new-session -d -s "$session" "bash -lc 'echo START:${work_id}; sleep 1; echo DONE:${work_id}'"
done
```

Inspect recent output from all workers:

```bash
for s in $(tmux list-sessions -F '#S' | grep '^mu-worker-'); do
  echo "=== $s ==="
  tmux capture-pane -pt "$s" -S -60 | tail -n 20
done
```

## Teardown and diagnostics

Kill one session:

```bash
tmux kill-session -t "$session"
```

Kill owned worker set by prefix:

```bash
for s in $(tmux list-sessions -F '#S' | grep '^mu-worker-20260224-'); do
  tmux kill-session -t "$s"
done
```

Quick diagnostics checklist:

1. `tmux list-sessions` (does session exist?)
2. `tmux capture-pane -pt <session> -S -200` (what actually happened?)
3. check marker presence / timeout behavior
4. recreate session if shell state is irrecoverably bad

## Integration map

- `code-mode`: tmux-backed REPL persistence and context engineering loops
- `execution`: tmux fan-out for parallel worker execution
- `heartbeats` / `crons`: schedule bounded passes that dispatch into tmux workers

## Evaluation scenarios

1. **Persistent REPL continuity**
   - Setup: run multi-pass Python debugging task.
   - Expected: same session reused; state persists across passes.

2. **Bounded pass completion**
   - Setup: command that emits long output.
   - Expected: completion marker reliably terminates capture loop.

3. **Parallel worker fan-out**
   - Setup: three independent work items.
   - Expected: one session per item, inspectable output, clean teardown.
