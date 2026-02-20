# @femtomc/mu

`mu` is a personal agent for technical work.

This package provides the Bun CLI and programmatic API.

## Install

After publishing:

```bash
npm install -g @femtomc/mu
# or: bun add -g @femtomc/mu
```

From this repo:

```bash
cd mu
bun install
bun run build
packages/cli/dist/cli.js --help
```

## Usage

### CLI Commands

```bash
mu serve                   # Start server + terminal operator session (auto-inits .mu)
mu session                 # Reconnect to latest persisted operator session
mu session list            # List persisted operator sessions for this repo
mu status                  # Show repository status
mu issues list             # List all issues
mu issues create "title"   # Create new issue
mu issues ready            # Show ready leaf issues
mu forum post topic -m "message"  # Post to forum
mu run "goal..."           # Run orchestration loop (auto-inits .mu)
mu resume <root-id>        # Resume interrupted run
```

Most issue/forum/event/control-plane read surfaces now default to compact output.
Use `--json` (optionally with `--pretty`) when you need full machine records.

Context retrieval supports a local memory index:

```bash
mu context index status
mu context index rebuild
mu context search --query "reload" --limit 20
```

When the index exists, `mu context search|timeline|stats` run index-first with automatic fallback to direct JSONL scans.

### Programmatic API

```ts
import { run } from "@femtomc/mu";

const r = await run(["status", "--json"]);
if (r.exitCode !== 0) throw new Error(r.stdout);
console.log(r.stdout);
```

### Serve + terminal operator

The `mu serve` command starts the server and immediately
attaches an interactive terminal operator session in the same shell:

```bash
mu serve              # Default port: 3000 (operator session)
mu serve --port 8080  # Custom port
```

Type `/exit` in the operator prompt (or press Ctrl+C) to stop both operator session and server.

In headless environments, use SSH port forwarding as needed.

### Operator session defaults

`mu serve`'s attached terminal operator session inherits `.mu/config.json` defaults
from `control_plane.operator.provider/model` when present. The session uses generic
tools and invokes `mu` CLI commands directly for reads and mutations.

By default, operator sessions are persisted under `.mu/operator/sessions`, and
`mu session` reconnects to the latest persisted session.

Use `mu control status` to inspect current config-driven control-plane/operator state.

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/cli
bun run typecheck
```

## Runtime

- **Bun runtime** (ESM).
- Reads/writes a `.mu/` store at the git repo root.
