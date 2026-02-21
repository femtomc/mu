# mu Development Rules

These are operator/agent guidelines for work inside `mu/`.

## First Message / Scoping
If the user did not give a concrete task in their first message:
1. Read `README.md`.
2. Ask which package(s) to work on.
3. Read the relevant package docs in parallel:
   - `packages/core/README.md`
   - `packages/agent/README.md`
   - `packages/control-plane/README.md`
   - `packages/forum/README.md`
   - `packages/issue/README.md`
   - `packages/cli/README.md`
   - `packages/server/README.md`
   - `packages/neovim/README.md`

## Core Principles
- Prefer CLI-first workflows for runtime state changes (`mu ...` commands).
- Keep edits minimal and scoped to the task.
- Never remove intentionally existing behavior without explicit user approval.
- Avoid guessed APIs: check source/types before implementing.
- Prefer explicit assumptions and reversible steps.

## TypeScript / API Quality
- No `any` unless truly unavoidable and justified.
- Check dependency type definitions in `node_modules` instead of guessing external APIs.
- Use standard top-level imports; do not use inline/dynamic imports for type positions.
- Do not hardcode policy or keybinding-like behavior when configurable pathways exist.

## Required Validation (after code changes)
From `mu/` root:
```bash
bun run check
```
- Use full output and fix failures before handoff.
- If the user asks for narrower/faster validation, run targeted checks and clearly report what was skipped.

Useful targeted checks:
```bash
bun run guardrails:architecture
bun run guardrails
bun run typecheck
bun test
```

## Commands to Avoid
- Do not run long-lived interactive commands unless explicitly requested (for example `bun run dev`, `mu serve`).
- Do not run destructive shell/git commands without explicit confirmation.
- Do not run release/publish commands unless explicitly requested.

## File Editing Discipline
- Read each file in full before modifying it.
- Prefer surgical edits over full rewrites when practical.
- Keep diffs focused; avoid incidental refactors.

## Git Safety (Parallel-Agent Friendly)
- Track which files you changed during the session.
- Stage only files you changed.
- Never use `git add .` or `git add -A`.
- Verify staged files with `git status` before commit.
- Never commit unless the user asks.
- Never use destructive commands like:
  - `git reset --hard`
  - `git checkout .`
  - `git clean -fd`
  - `git stash` (unless user explicitly requests and understands global effect)
- Never force-push unless explicitly requested.

## GitHub Issues / PRs
When reading GitHub issues, always include comments:
```bash
gh issue view <number> --json title,body,comments,labels,state
```

- Add package labels (`pkg:*`) when creating issues/PRs if the repo uses them.
- Do not open PRs or perform merge/push workflows unless requested by the user.

## Issues / Forum / Runs (mu state)
When inspecting state, prefer bounded queries first:
```bash
mu status --pretty
mu issues list --status open --limit 20 --pretty
mu forum read issue:<id> --limit 20 --pretty
```

For lifecycle actions, always use `mu` CLI commands.
Never hand-edit `.mu/*.jsonl` for normal operations.

## Docs and Changelogs
- Update docs/changelogs when behavior or public interfaces change.
- Add entries under the appropriate `## [Unreleased]` section.
- Append to existing subsections; do not duplicate section headers.
- Never rewrite historical released sections.

## Style
- Keep responses concise and technical.
- No fluff.
- Be explicit about assumptions, limits, and next steps.
- No emojis in commit messages, issue comments, PR comments, or code.
