# @mu/orchestrator

Node DAG runner that drives `@mu/issue` and `@mu/forum` to execute ready leaf issues and log outcomes.

## Install

After publishing:

```bash
npm install @mu/orchestrator
# or: bun add @mu/orchestrator
```

From this repo:

```bash
cd mu
bun install
bun run build
```

## Usage

```ts
import { FsJsonlStore, fsEventLog, getStorePaths } from "@mu/core/node";
import { ForumStore } from "@mu/forum";
import { IssueStore } from "@mu/issue";
import { DagRunner } from "@mu/orchestrator";

const repoRoot = process.cwd();
const paths = getStorePaths(repoRoot);
const events = fsEventLog(paths.eventsPath);

const issues = new IssueStore(new FsJsonlStore(paths.issuesPath), { events });
const forum = new ForumStore(new FsJsonlStore(paths.forumPath), { events });

const runner = new DagRunner(issues, forum, repoRoot);
const result = await runner.run("mu-<root-id>");
console.log(result);
```

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/orchestrator
bun run typecheck
```

## Runtime

- **Node-only** (uses `node:child_process` + filesystem).
- Default backend is the `pi` CLI (`pi --mode json ...`). If you don't have `pi`, pass a custom `BackendRunner`.
