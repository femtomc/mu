# mu

Bun + TypeScript monorepo for `mu`: an issue DAG + forum store, plus a Node CLI and runner.

- Dev tooling uses **Bun** (CI uses Bun `1.3.9`).
- Built packages target **Node-compatible ESM** with **`.d.ts`** typings.

## Packaging Target

`mu` packages are built as **Node-compatible ESM** with **`.d.ts`** typings.
Published/packed entrypoints come from `dist/` (not `src/`).

## Quickstart

### Use the CLI (after publishing)

```bash
npm install -g @mu/cli
cd /path/to/your/git/repo

mu init
mu status
mu issues create "hello world" --body "first task" --pretty
```

### From this repo

```bash
cd mu
bun install
bun run build

# run the built CLI (Node ESM)
packages/cli/dist/cli.js --help
packages/cli/dist/cli.js init
packages/cli/dist/cli.js status
```

## Packages

- [`@mu/cli`](packages/cli/README.md): Node CLI for `.inshallah/` issue DAG + forum.
- [`@mu/core`](packages/core/README.md): core types/utilities, JSONL storage, and Node/browser adapters.
- [`@mu/forum`](packages/forum/README.md): forum/message store on top of a JSONL store.
- [`@mu/issue`](packages/issue/README.md): issue store + DAG helpers (ready leaves, validate, deps).
- [`@mu/orchestrator`](packages/orchestrator/README.md): Node DAG runner (defaults to `pi` backend).
- [`@mu/web`](packages/web/README.md): browser demo app (Vite + IndexedDB/localStorage).
- [`@mu/slack-bot`](packages/slack-bot/README.md): Slack slash-command + events handler.

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

## Pack/Install Smoke Test

```bash
bun run pack:smoke
```

This builds `dist/`, `npm pack`s `@mu/{core,forum,issue,orchestrator,cli}`, installs them into a temp project, verifies
imports run under Node, and verifies the `mu` CLI runs (`--help`).

## CLI

The `mu` CLI is shipped by `@mu/cli` and runs on Node (ESM).

```bash
# global install (after publishing)
npm install -g @mu/cli
# or: bun add -g @mu/cli

mu --help
```

## Formatting

```bash
bun run fmt
bun run lint
bun run check
```

## Slack Bot

See `packages/slack-bot/README.md`.

## Browser

Minimal browser demo (no backend) lives at `packages/web/`.

```bash
# dev server
bun run web:dev

# build static assets
bun run web:build

# run headless e2e test (Playwright) against the built app
bun run web:test
```

Data lives in your browser:

- Preferred: IndexedDB database `mu-demo` with object stores `issues`, `forum`, `events`
- Fallback: localStorage keys `mu-demo:issues`, `mu-demo:forum`, `mu-demo:events`

Limitations:

- No schema migrations yet (wipe storage if shapes change).
- localStorage fallback is for tiny demos only (small quota).
