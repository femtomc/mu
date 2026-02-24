---
name: code-mode
description: "Runs lightweight tmux-backed REPL workflows so agents can execute code and engineer context without bloating prompt history."
---

# code-mode

Use this skill when a task is better solved by iterative code execution in a live
REPL than by stuffing intermediate data into chat context.

The core idea is intentionally simple: `tmux` provides a persistent runtime shell,
and the agent drives it with `bash`.

## Contents

- [Core contract](#core-contract)
- [tmux skill dependency](#tmux-skill-dependency)
- [Minimal tmux execution loop](#minimal-tmux-execution-loop)
- [Context engineering contract](#context-engineering-contract)
- [Language-specific quick starts](#language-specific-quick-starts)
- [Integration with other mu skills](#integration-with-other-mu-skills)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

1. **Use persistent runtime state, not prompt state**
   - Keep working data in REPL variables, files, and process memory.
   - Only return compact summaries/artifacts to chat.

2. **One session per task scope**
   - Reuse the same tmux session while solving one problem.
   - Use distinct session names for unrelated tasks to avoid state bleed.

3. **Bounded command passes**
   - Send one coherent code block per pass.
   - Capture output, summarize, decide next pass.

4. **On-demand discovery**
   - Ask runtime for definitions/help only when needed (`help(...)`, `dir(...)`,
     `.help`, etc.) instead of loading everything up front.

5. **No extra harness required**
   - Trusted local workflows can stay minimal: `tmux` + `bash` + REPL.

## tmux skill dependency

Before mutating tmux session state, load **`tmux`** and follow its canonical
session lifecycle and bounded pass protocol.

- Treat `tmux` as source-of-truth for create/reuse, capture, fan-out, and teardown.
- This `code-mode` skill defines REPL/context-engineering behavior only.

## Minimal tmux execution loop

Create/reuse a session:

```bash
session="mu-code-py"
tmux has-session -t "$session" 2>/dev/null || tmux new-session -d -s "$session" "python3 -q"
```

Run one bounded pass with a completion marker:

```bash
token="__MU_DONE_$(date +%s%N)__"
tmux send-keys -t "$session" "import math; print(math.sqrt(144))" C-m
tmux send-keys -t "$session" "print('$token')" C-m

for _ in $(seq 1 40); do
  out="$(tmux capture-pane -pt "$session" -S -200)"
  echo "$out" | grep -q "$token" && break
  sleep 0.05
done

printf "%s\n" "$out"
```

Teardown when done:

```bash
tmux kill-session -t "$session"
```

## Context engineering contract

Use the runtime to compress context before speaking:

1. Load raw data into files/variables.
2. Execute code that filters, slices, or aggregates.
3. Persist useful artifacts (`summary.json`, `notes.md`, `results.csv`).
4. Report only:
   - key findings,
   - confidence/limits,
   - artifact paths and next action.

Practical rules:

- Prefer computed summaries over pasted raw logs.
- Keep long transcripts in files; cite paths.
- Recompute when uncertain instead of guessing from stale text.

## Language-specific quick starts

Python:

```bash
tmux new-session -d -s mu-code-py "python3 -q"
```

Node:

```bash
tmux new-session -d -s mu-code-node "node"
```

SQLite:

```bash
tmux new-session -d -s mu-code-sql "sqlite3 data.db"
```

Shell-only REPL (for pipelines/tools):

```bash
tmux new-session -d -s mu-code-sh "bash --noprofile --norc -i"
```

## Integration with other mu skills

- Use with `planning` when a plan step needs exploratory coding.
- Use with `orchestration`/`subagents` by assigning one tmux session per worker.
- Use with `control-flow` for explicit retry/termination policy around code passes.
- Use with `heartbeats`/`crons` when bounded code passes should run on schedule.

## Evaluation scenarios

1. **Exploratory data pass**
   - Setup: large raw text/log corpus.
   - Expected: agent uses REPL transforms to produce concise findings + artifact path,
     without dumping full corpus into chat.

2. **Multi-pass debugging**
   - Setup: bug reproduction requires iterative commands.
   - Expected: same tmux session is reused across passes; state continuity reduces
     repeated setup and prompt churn.

3. **Language swap with same control pattern**
   - Setup: compare Python and Node approaches.
   - Expected: same tmux send/capture loop works across both REPLs with only session
     bootstrap command changed.
