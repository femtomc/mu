# @femtomc/mu-orchestrator

Long-running execution engine for mu work plans. It dispatches ready work and records outcomes.

## Install

After publishing:

```bash
npm install @femtomc/mu-orchestrator
# or: bun add @femtomc/mu-orchestrator
```

From this repo:

```bash
cd mu
bun install
bun run build
```

## Usage

```ts
import { FsJsonlStore, fsEventLog, getStorePaths } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { DagRunner } from "@femtomc/mu-orchestrator";

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

- **Node-only** (uses filesystem + pi SDK in-process).
- Default backend is `PiSdkBackend` (from `@femtomc/mu-agent`). Pass a custom `BackendRunner` to override.
