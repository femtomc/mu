# @mu/core

Core types and utilities shared across mu packages: JSONL store abstractions, event logging, DAG helpers, and spec schemas.

## Install

After publishing:

```bash
npm install @mu/core
# or: bun add @mu/core
```

From this repo:

```bash
cd mu
bun install
bun run build
```

## Usage

```ts
import { EventLog, InMemoryJsonlStore, JsonlEventSink, newRunId, runContext } from "@mu/core/node";

const jsonl = new InMemoryJsonlStore();
const events = new EventLog(new JsonlEventSink(jsonl));

await runContext({ runId: newRunId() }, async () => {
	await events.emit("demo.event", { source: "readme", payload: { ok: true } });
});

console.log(await jsonl.read());
```

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/core
bun run typecheck
```

## Runtime

- `@mu/core` is runtime-agnostic (no Node builtins).
- `@mu/core/node` is **Node-only** (`node:fs`, `node:async_hooks`).
- `@mu/core/browser` is **browser-only** (IndexedDB/localStorage).
