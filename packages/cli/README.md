# @femtomc/mu

Node CLI (and programmatic wrapper) for the mu `.mu/` issue DAG + forum store. Includes integrated web UI server.

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
mu init                    # Initialize .mu store
mu serve                   # Start server and open web UI
mu status                  # Show repository status
mu issues list             # List all issues
mu issues create "title"   # Create new issue
mu issues ready            # Show ready leaf issues
mu forum post topic -m "message"  # Post to forum
mu run "goal..."           # Run orchestration loop
mu resume <root-id>        # Resume interrupted run
```

### Programmatic API

```ts
import { run } from "@femtomc/mu";

const r = await run(["status", "--json"]);
if (r.exitCode !== 0) throw new Error(r.stdout);
console.log(r.stdout);
```

### Web UI

The `mu serve` command starts both the API server and web UI:

```bash
mu serve              # Default ports: API=3000, UI=5173
mu serve --no-open    # Don't open browser
mu serve --port 8080 --api-port 3001  # Custom ports
```

In headless environments, it provides SSH port forwarding instructions.

## Tests / Typecheck

From the `mu/` repo root:

```bash
bun test packages/cli
bun run typecheck
```

## Runtime

- **Node-only** (ESM).
- Reads/writes a `.mu/` store at the git repo root (use `mu init` to create it).
