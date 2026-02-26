---
name: programmable-ui
description: "Builds and debugs mu_ui UiDocs with schema-valid payloads, interaction wiring, and status/snapshot verification."
---

# programmable-ui

Use this skill when the task involves `mu_ui`, `UiDoc` payloads, interactive actions, or `/mu ui ...` inspection commands.

## Contents

- [Core contract](#core-contract)
- [60-second quickstart](#60-second-quickstart)
- [UiDoc schema cheat sheet](#uidoc-schema-cheat-sheet)
- [mu_ui action semantics](#mu_ui-action-semantics)
- [Canonical templates](#canonical-templates)
- [Status-profile rules](#status-profile-rules)
- [Debugging playbook](#debugging-playbook)
- [Verify and teardown checklist](#verify-and-teardown-checklist)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

1. **Publish schema-valid docs only**
   - `mu_ui` accepts `doc: object`, but runtime validation is strict (`UiDoc` schema).
   - Invalid payloads fail with `Invalid UiDoc.`.

2. **Keep interaction command-driven**
   - Interactive actions must set `action.metadata.command_text` (for example `/answer yes`).
   - User clicks/taps are translated back into normal command turns.

3. **Separate status and decisions**
   - Keep one non-interactive status doc per active profile (`metadata.profile.variant: "status"`).
   - Use separate interactive docs for user decisions.

4. **Use monotonic revisions**
   - Increment `revision.version` on each update for the same `ui_id`.
   - Replays/reconnects keep the highest revision deterministically.

5. **Read -> act -> verify**
   - After each `set|update|replace|remove|clear`, check `/mu ui status` and `/mu ui snapshot`.

6. **Close docs explicitly**
   - Resolve prompts with `mu_ui remove` (preferred) or `mu_ui clear`.

## 60-second quickstart

1. Publish one interactive doc:

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:demo",
    "title": "Demo",
    "summary": "Minimal interactive panel",
    "components": [
      { "kind": "text", "id": "intro", "text": "Choose an option", "metadata": {} }
    ],
    "actions": [
      {
        "id": "ack",
        "label": "Acknowledge",
        "kind": "primary",
        "payload": { "choice": "ack" },
        "metadata": { "command_text": "/answer ack" }
      }
    ],
    "revision": { "id": "rev:demo:1", "version": 1 },
    "updated_at_ms": 1,
    "metadata": {}
  }
}
```

2. Verify live state:

```text
/mu ui status
/mu ui snapshot compact
/mu ui snapshot multiline
```

3. Handle command (`/answer ack`) in normal skill logic.

4. Remove prompt doc:

```json
{ "action": "remove", "ui_id": "ui:demo" }
```

## UiDoc schema cheat sheet

Required top-level fields for each doc:

- `v`: `1`
- `ui_id`: non-empty string (max 64)
- `title`: non-empty string
- `components`: non-empty array (`text|list|key_value|divider`)
- `revision`: `{ id: string, version: nonnegative int }`
- `updated_at_ms`: nonnegative integer

Common optional fields (recommended):

- `summary`: deterministic fallback summary
- `actions`: interactive options (empty for pure status)
- `metadata`: profile/snapshot metadata and custom annotations

Component minimums:

- `text`: `id`, `text`
- `list`: `id`, `items[]` (`id`, `label`, optional `detail`, optional `tone`)
- `key_value`: `id`, `rows[]` (`key`, `value`, optional `tone`)
- `divider`: `id`

Action minimums:

- `id`, `label`
- `metadata.command_text` required for interactive routing
- optional: `kind`, `description`, `payload`, `component_id`, `callback_token`

## mu_ui action semantics

- `status`
  - Returns count, `ui_id` list, status-profile counts/warnings, and awaiting counts.
- `snapshot`
  - `snapshot_format`: `compact|multiline` (defaults to `compact`).
- `set`
  - Upsert one doc by `ui_id`.
- `update`
  - Same behavior as `set` (single-doc upsert).
- `replace`
  - Replace entire active doc set with `docs[]`.
- `remove`
  - Remove one doc by `ui_id`.
- `clear`
  - Remove all docs for the session.

## Canonical templates

### 1) Interactive `/answer` prompt

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:answer",
    "title": "Answer",
    "summary": "Please choose yes or no",
    "components": [
      { "kind": "text", "id": "prompt", "text": "Choose an answer", "metadata": {} }
    ],
    "actions": [
      {
        "id": "answer_yes",
        "label": "Yes",
        "kind": "primary",
        "payload": { "choice": "yes" },
        "metadata": { "command_text": "/answer yes" }
      },
      {
        "id": "answer_no",
        "label": "No",
        "kind": "secondary",
        "payload": { "choice": "no" },
        "metadata": { "command_text": "/answer no" }
      }
    ],
    "revision": { "id": "rev:answer:1", "version": 1 },
    "updated_at_ms": 1,
    "metadata": {}
  }
}
```

Handler contract:

1. Parse `/answer <choice>`.
2. Validate choice.
3. `mu_ui remove` (or `clear`) for `ui:answer`.
4. Emit normal response.

### 2) Status-profile doc (non-interactive)

```json
{
  "action": "set",
  "doc": {
    "v": 1,
    "ui_id": "ui:planning",
    "title": "Planning status",
    "summary": "Drafting issue DAG",
    "components": [
      {
        "kind": "key_value",
        "id": "kv",
        "rows": [
          { "key": "phase", "value": "decomposition" },
          { "key": "next", "value": "approval prompt" }
        ],
        "metadata": {}
      },
      {
        "kind": "list",
        "id": "milestones",
        "items": [
          { "id": "m1", "label": "Root issue captured" },
          { "id": "m2", "label": "Leaf tasks drafted" }
        ],
        "metadata": {}
      }
    ],
    "actions": [],
    "revision": { "id": "rev:planning:12", "version": 12 },
    "updated_at_ms": 1730000000000,
    "metadata": {
      "profile": {
        "id": "planning",
        "variant": "status",
        "snapshot": {
          "compact": "planning: DAG draft ready",
          "multiline": "phase: decomposition\nnext: approval prompt"
        }
      }
    }
  }
}
```

### 3) Parameterized command text with payload defaults

```json
{
  "id": "approve",
  "label": "Approve",
  "payload": { "choice": "approve", "note": "looks good" },
  "metadata": { "command_text": "/answer choice={{choice}} note={{note}}" }
}
```

In terminal UI interaction flow, placeholders are auto-filled from `payload` when possible, and unresolved fields are prompted.

## Status-profile rules

When `metadata.profile.id` is one of `planning|subagents|control-flow|model-routing` and variant is `status`:

- expected `ui_id` values:
  - `planning` -> `ui:planning`
  - `subagents` -> `ui:subagents`
  - `control-flow` -> `ui:control-flow`
  - `model-routing` -> `ui:model-routing`
- keep `actions: []` (status docs are non-interactive)
- include `summary` plus `metadata.profile.snapshot.compact`
- preferred components by profile:
  - `planning`: `key_value` + `list`
  - `subagents`: `key_value` + `list`
  - `control-flow`: `key_value`
  - `model-routing`: `key_value` + `list`

Use `/mu ui status` to catch profile warnings early.

## Debugging playbook

- **`doc is required`**
  - Missing `doc` parameter for `set|update`.
- **`Invalid UiDoc.`**
  - Schema mismatch. Re-check required fields and component/action shapes.
- **`docs must be an array` / `docs[i]: invalid UiDoc`**
  - `replace` payload malformed.
- **Action appears but cannot run**
  - Missing/empty `metadata.command_text`, or status-profile doc (actions intentionally non-runnable).
- **`awaiting` stays non-zero**
  - Prompt doc still active. Remove with `mu_ui remove` once handled.

## Verify and teardown checklist

After each change:

1. `/mu ui status` shows expected doc count and ids.
2. `/mu ui snapshot compact` shows deterministic summary.
3. `/mu ui snapshot multiline` shows readable panel/action projection.
4. Prompt resolved? Remove/clear doc explicitly.
5. Keep issue/forum truth in sync; `mu_ui` is communication state, not source-of-truth task state.

## Evaluation scenarios

1. **First-time interactive prompt**
   - Publish `ui:answer`, click action, confirm `/answer ...` reaches normal handler, remove prompt doc.

2. **Status + decision split**
   - Keep `ui:planning` status-profile doc active; open separate interactive approval doc; verify status remains non-interactive.

3. **Replay/reconnect safety**
   - Publish revisions 1 then 2; replay stale rev 1; verify highest revision remains active.

4. **Channel degrade resilience**
   - Ensure every actionable row has deterministic `command_text` fallback so manual command entry always works.
