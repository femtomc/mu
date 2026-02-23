---
name: hud
description: "Defines HUD usage for `mu_hud` and `/mu hud`, including doc schema patterns, deterministic update rules, and rendering-safe conventions."
---

# hud

Use this skill whenever you need to publish, update, or inspect HUD state.

This skill is the canonical HUD reference for:

- `mu_hud` tool calls (structured HUD state)
- `/mu hud ...` command usage (inspection/control)
- `HudDoc` conventions that render well in TUI/Slack/Telegram

## Contents

- [Core contract](#core-contract)
- [HudDoc shape](#huddoc-shape)
- [Recommended turn loop](#recommended-turn-loop)
- [Planning and subagents profiles](#planning-and-subagents-profiles)
- [Determinism and rendering limits](#determinism-and-rendering-limits)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

### Tool (`mu_hud`)

Actions:

- `status`, `snapshot`
- `on`, `off`, `toggle`
- `set`, `update`, `replace`, `remove`, `clear`

Key params:

- `doc` (for `set`/`update`)
- `docs` (for `replace`)
- `hud_id` (for `remove`)
- `snapshot_format` (`compact` or `multiline`)

Notes:

- `set` and `update` are both upsert-style single-doc writes.
- `replace` is whole-inventory replacement.
- Tool results include normalized `hud_docs` for downstream transport/rendering.

### Command (`/mu hud ...`)

Supported subcommands:

- `/mu hud status`
- `/mu hud snapshot [compact|multiline]`
- `/mu hud on|off|toggle`
- `/mu hud clear`
- `/mu hud remove <hud-id>`

Use the tool (`mu_hud`) for structured doc writes.

## HudDoc shape

HUD docs are validated against `HudDoc` (`@femtomc/mu-core`).

Minimum practical fields:

- `v: 1`
- `hud_id: <non-empty>`
- `title: <non-empty>`
- `snapshot_compact: <non-empty>`
- `updated_at_ms: <int>`

Common optional fields:

- `scope` (for root/session/issue scoping)
- `chips` (`[{key,label,tone?}]`)
- `sections`:
  - `kv` (key/value)
  - `checklist` (checkbox-style progress)
  - `activity` (recent lines)
  - `text` (free text)
- `actions` (`[{id,label,command_text,kind?}]`)
- `metadata` (machine-readable extras)

Example checklist doc:

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "hud_id": "planning",
    "title": "Planning HUD",
    "scope": "mu-root-123",
    "chips": [
      { "key": "phase", "label": "phase:drafting", "tone": "accent" },
      { "key": "steps", "label": "steps:2/5", "tone": "dim" }
    ],
    "sections": [
      {
        "kind": "checklist",
        "title": "Checklist",
        "items": [
          { "id": "1", "label": "Investigate", "done": true },
          { "id": "2", "label": "Draft DAG", "done": true },
          { "id": "3", "label": "Review", "done": false }
        ]
      }
    ],
    "actions": [
      { "id": "snapshot", "label": "Snapshot", "command_text": "/mu hud snapshot", "kind": "secondary" }
    ],
    "snapshot_compact": "HUD(plan) · phase=drafting · steps=2/5",
    "updated_at_ms": 1771853115000,
    "metadata": { "phase": "drafting" }
  }
}
```

## Recommended turn loop

1. Ensure HUD is on:

```json
{"action":"on"}
```

2. Upsert exactly the docs you own (`set`/`update`).
3. Emit compact snapshot for user-facing status:

```json
{"action":"snapshot","snapshot_format":"compact"}
```

4. Keep response text and HUD state aligned (no contradictions).

## Planning and subagents profiles

Use profile-specific `hud_id` values:

- planning profile: `hud_id: "planning"`
- subagents profile: `hud_id: "subagents"`

Treat these as conventions layered on top of this generic contract.

## Determinism and rendering limits

- Keep one canonical doc per `hud_id`.
- Keep `updated_at_ms` monotonic for each `hud_id`.
- Prefer a small doc set (usually 1–3 docs total) for channel readability.
- Keep command actions concise; long commands may degrade to text-only fallbacks on some channels.
- Assume channel renderers cap docs/actions/lines; put critical state in `snapshot_compact` and first section items.

If behavior is unclear, inspect implementation/tests before guessing:

- `packages/core/src/hud.ts`
- `packages/agent/src/extensions/hud.ts`
- `packages/server/src/control_plane.ts`
- `packages/agent/test/hud_tool.test.ts`

## Evaluation scenarios

1. **Planning review turn**
   - Expected: `planning` doc updates phase/checklist/waiting state, then emits compact snapshot.

2. **Subagents orchestration pass**
   - Expected: `subagents` doc updates queue/activity/chips after each bounded pass.

3. **HUD reset handoff**
   - Expected: after phase completion, HUD is cleared or removed by `hud_id`, and status reflects no stale docs.
