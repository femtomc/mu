# mu Development Rules

These are operator/agent guidelines for working inside `mu/`.

## First Message / Scoping
If the user has not given a concrete task:
1. Read `README.md`.
2. Ask which package(s) to work on.
3. Then read relevant package docs in parallel:
   - `packages/core/README.md`
   - `packages/agent/README.md`
   - `packages/control-plane/README.md`
   - `packages/forum/README.md`
   - `packages/issue/README.md`
   - `packages/orchestrator/README.md`
   - `packages/cli/README.md`
   - `packages/server/README.md`
   - `packages/neovim/README.md`

## Core Principles
- Prefer CLI-first workflows for runtime state changes (`mu ...` commands).
- Keep edits minimal and scoped to the task.
- Never remove intentionally-existing behavior without explicit user approval.
- Avoid guessed APIs: check source/types before implementing.
- No `any` unless truly unavoidable and justified.

## Code Quality
- Use top-level imports; avoid dynamic/inline import patterns unless explicitly required.
- Preserve configurable behavior (do not hardcode policy/keybinding-like logic).
- Match existing architecture boundaries between packages.

## Required Validation (after code changes)
From `mu/` root:
```bash
bun run check
```
- Fix all failures before asking for review.
- If the user asks for narrower/faster validation, run targeted checks, then report what was skipped.

Useful additional checks:
```bash
bun run guardrails:architecture
bun run guardrails
bun run typecheck
bun test
```

## Commands to Avoid
- Do not run long-lived interactive commands unless user asks (for example `bun run dev`, `mu serve`).
- Do not run destructive shell/git commands without explicit confirmation.

## File Editing Discipline
- Read each file in full before modifying it.
- Prefer surgical edits (`edit`) over full rewrites (`write`) when practical.
- Keep diffs focused; avoid incidental refactors.

## Git Safety (Parallel-Agent Friendly)
- Only stage files you changed in this session.
- Never use `git add .` or `git add -A`.
- Verify staged files with `git status` before commit.
- Never use destructive commands like:
  - `git reset --hard`
  - `git checkout .`
  - `git clean -fd`
  - `git stash` (unless user explicitly requests and understands global effect)
- Never force-push unless explicitly requested.

## Issues / Forum / Runs
When inspecting state, prefer bounded queries first:
```bash
mu status --pretty
mu issues list --status open --limit 20 --pretty
mu forum read issue:<id> --limit 20 --pretty
```
For lifecycle actions, use CLI commands (not manual edits in `.mu/*.jsonl`).

## Style
- Keep responses concise and technical.
- No fluff.
- Be explicit about assumptions, limits, and next steps.

## Docs and Changelogs
- Update docs/changelogs when behavior or public interfaces change.
- Keep release notes additive under the appropriate unreleased section; do not rewrite historical release entries.
