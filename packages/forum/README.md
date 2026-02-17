# @femtomc/mu-forum

Topic-based coordination message store used by mu.

## Install

After publishing:

```bash
npm install @femtomc/mu-forum
# or: bun add @femtomc/mu-forum
```

From this repo:

```bash
cd mu
bun install
bun run build
```

## Usage

```ts
import { InMemoryJsonlStore } from "@femtomc/mu-core";
import { ForumStore } from "@femtomc/mu-forum";

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
- You provide a `JsonlStore` implementation (see `@femtomc/mu-core/node` for `FsJsonlStore`, or `@femtomc/mu-core/browser` for IndexedDB/localStorage stores).
