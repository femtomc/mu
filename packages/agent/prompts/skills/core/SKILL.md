---
name: core
description: "Meta-skill for core mu operating primitives. Routes to mu, memory, tmux, and code-mode based on task shape."
---

# core

Use this meta-skill when the user asks for general `mu` operation guidance and you need to pick the correct foundational skill.

## Subskills

- `mu` — default CLI-first operating workflow (inspect, mutate, verify, handoff).
- `memory` — historical context retrieval, timeline reconstruction, and memory-index maintenance.
- `tmux` — persistent terminal/session substrate for bounded command execution and fan-out.
- `code-mode` — tmux-backed REPL loops for iterative execution and context compression.

## Selection guide

1. Start with `mu` for most day-to-day operator work.
2. Add `memory` when historical context or timeline anchors are required.
3. Add `tmux` when durable shell state or parallel worker shells are needed.
4. Add `code-mode` when solving by live execution is cheaper than chat-only reasoning.
