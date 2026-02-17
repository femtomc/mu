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
