# @mu/cli

Node CLI (and programmatic wrapper) for the mu `.mu/` issue DAG + forum store.

## Install

After publishing:

```bash
npm install -g @mu/cli
# or: bun add -g @mu/cli
```

From this repo:

```bash
cd mu
bun install
bun run build
packages/cli/dist/cli.js --help
```

## Usage

```ts
import { run } from "@mu/cli";

const r = await run(["status", "--json"]);
if (r.exitCode !== 0) throw new Error(r.stdout);
console.log(r.stdout);
```

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/cli
bun run typecheck
```

## Runtime

- **Node-only** (ESM).
- Reads/writes a `.mu/` store at the git repo root (use `mu init` to create it).
