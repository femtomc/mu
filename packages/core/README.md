# @femtomc/mu-core

Core runtime primitives shared across mu packages.

## Install

After publishing:

```bash
npm install @femtomc/mu-core
# or: bun add @femtomc/mu-core
```

From this repo:

```bash
cd mu
bun install
bun run build
```

## Usage

```ts
import { EventLog, InMemoryJsonlStore, JsonlEventSink, newRunId, runContext } from "@femtomc/mu-core/node";

const jsonl = new InMemoryJsonlStore();
const events = new EventLog(new JsonlEventSink(jsonl));

await runContext({ runId: newRunId() }, async () => {
	await events.emit("demo.event", { source: "readme", payload: { ok: true } });
});

console.log(await jsonl.read());
```

## UI contract helpers

Interactive UI documents are modeled as first-class, versioned contracts that describe renderable components, actions, and revisions so any rendering surface can stay in sync with agents. `@femtomc/mu-core` exposes the following helpers:

- `UI_CONTRACT_VERSION`, `UiDocSchema`, `UiRevisionSchema`, `UiComponentSchema`, and `UiActionSchema` for validating document payloads.
- `parseUiDoc(...)`, `normalizeUiDocs(...)`, and `uiDocRevisionConflict(...)` for deterministic selection, conflict detection, and safe merging of candidate documents.
- `resolveUiStatusProfileName(...)` and `uiStatusProfileWarnings(...)` for advisory validation of profile-scoped status docs (`planning`, `subagents`, `control-flow`, `model-routing`) carried in `metadata.profile`.
- `UiEventSchema` + `parseUiEvent(...)` for structured event payloads emitted by frontends (every event includes `ui_id`, `action_id`, the originating `revision`, optional `callback_token`, `payload`, and `created_at_ms`).
- `stableSerializeJson(...)` for deterministic metadata serialization and revision tie-breaking.

### Field limits

The UI contract enforces strict bounds to keep cross-frontends renderable:

- titles are capped at 256 characters and summaries at 1024 characters.
- documents can contain at most 64 components, where text segments are limited to 2048 characters, lists can hold at most 32 items, and key/value rows are capped at 32 entries.
- actions are limited to 32 entries; labels are 128 characters, descriptions 512, and callback tokens 128.

### Deterministic ordering

`normalizeUiDocs(...)` deduplicates by `ui_id`, chooses the highest `revision.version`, breaks ties with `updated_at_ms`, and falls back to a stable JSON comparison (`stableSerializeJson`) so every renderer observes the same ordering. Use `uiDocRevisionConflict(...)` to detect when two docs claim the same revision but differ, enabling agents to guard against race conditions.

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/core
bun run typecheck
```

## Runtime

- `@femtomc/mu-core` is runtime-agnostic (no Node builtins).
- `@femtomc/mu-core/node` is **Node-only** (`node:fs`, `node:async_hooks`).
- `@femtomc/mu-core/browser` is **browser-only** (IndexedDB/localStorage).
