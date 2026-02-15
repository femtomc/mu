# @femtomc/mu-issue

Issue store backed by a JSONL store, with dependency edges and DAG helpers (ready leaves, validate, deps).

## Install

After publishing:

```bash
npm install @femtomc/mu-issue
# or: bun add @femtomc/mu-issue
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
import { IssueStore } from "@femtomc/mu-issue";

const issues = new IssueStore(new InMemoryJsonlStore());

const root = await issues.create("root");
const leaf = await issues.create("do work", { tags: ["node:agent"] });
await issues.add_dep(leaf.id, "parent", root.id);

console.log(await issues.ready(root.id));
```

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/issue
bun run typecheck
```

## Runtime

- Runtime-agnostic: works in Node or the browser.
- You provide a `JsonlStore` implementation (see `@femtomc/mu-core/node` for `FsJsonlStore`, or `@femtomc/mu-core/browser` for IndexedDB/localStorage stores).
