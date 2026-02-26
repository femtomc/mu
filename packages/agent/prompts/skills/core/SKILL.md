---
name: core
description: "Meta-skill for core mu operating primitives. Routes to mu, programmable-ui, memory, tmux, and code-mode based on task shape."
---

# core

Use this meta-skill when the user asks for general `mu` operation guidance and you need to pick the correct foundational skill.

## Subskills

- `mu` — default CLI-first operating workflow (inspect, mutate, verify, handoff).
- `programmable-ui` — canonical `mu_ui`/`UiDoc` workflow for publishing, inspecting, and debugging interactive UI docs.
- `memory` — prior-context retrieval, timeline reconstruction, and memory-index maintenance.
- `tmux` — persistent terminal/session substrate for bounded command execution and fan-out.
- `code-mode` — tmux-backed REPL loops for iterative execution and context compression.

## Selection guide

1. Start with `mu` for most day-to-day operator work.
2. Route to `programmable-ui` when the user asks about `mu_ui`, `/mu ui ...`, `UiDoc` payloads, action wiring, or interactive prompt behavior.
3. Add `memory` when prior context or timeline anchors are required.
4. Add `tmux` when durable shell state or parallel worker shells are needed.
5. Add `code-mode` when solving by live execution is cheaper than chat-only reasoning.

## Common patterns

- **Bounded investigation**: Use `mu` commands (`get`, `read`, `health`) to inspect current state, then use `memory` to find "when did this last work?" before attempting a fix.
- **Programmable UI scaffolding**: Route to `programmable-ui` to emit schema-valid `UiDoc` templates quickly, verify state with `/mu ui status|snapshot`, and close docs with `mu_ui remove|clear`.
- **Context compression**: If a user asks for complex debugging that involves running code and printing huge errors, route to `code-mode`. The agent can spin up a REPL, iterate on a fix offline, and return only the root cause to the chat.
- **Parallel fan-out**: If a command takes a long time, or needs to run across multiple directories, route to `tmux` to spawn parallel worker shells, keep them running in the background, and periodically read their output.
