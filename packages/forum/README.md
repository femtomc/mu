# @mu/forum

Forum/message store backed by a JSONL store, with helpers for posting, reading, and listing topics.

## Install

After publishing:

```bash
npm install @mu/forum
# or: bun add @mu/forum
```

From this repo:

```bash
cd mu
bun install
bun run build
```

## Usage

```ts
import { InMemoryJsonlStore } from "@mu/core";
import { ForumStore } from "@mu/forum";

const forum = new ForumStore(new InMemoryJsonlStore());

await forum.post("issue:demo", "hello", "worker");
console.log(await forum.read("issue:demo"));
console.log(await forum.topics("issue:"));
```

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/forum
bun run typecheck
```

## Runtime

- Runtime-agnostic: works in Node or the browser.
- You provide a `JsonlStore` implementation (see `@mu/core/node` for `FsJsonlStore`, or `@mu/core/browser` for IndexedDB/localStorage stores).
