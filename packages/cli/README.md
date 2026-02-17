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
mu serve                   # Start server + operator chat + web UI (auto-inits .mu)
mu status                  # Show repository status
mu issues list             # List all issues
mu issues create "title"   # Create new issue
mu issues ready            # Show ready leaf issues
mu forum post topic -m "message"  # Post to forum
mu run "goal..."           # Run orchestration loop (auto-inits .mu)
mu resume <root-id>        # Resume interrupted run
mu chat                    # Interactive operator chat
mu chat --message "..."    # One-shot chat turn
```

### Programmatic API

```ts
import { run } from "@femtomc/mu";

const r = await run(["status", "--json"]);
if (r.exitCode !== 0) throw new Error(r.stdout);
console.log(r.stdout);
```

### Web UI

The `mu serve` command starts the server with the bundled web UI and immediately
attaches an interactive terminal operator session in the same shell:

```bash
mu serve              # Default port: 3000 (chat + web UI)
mu serve --no-open    # Don't open browser
mu serve --port 8080  # Custom port
```

Type `/exit` in the chat prompt (or press Ctrl+C) to stop both chat and server.

In headless environments, it provides SSH port forwarding instructions.

### Operator chat defaults

`mu chat` is enabled by default and uses the same extension stack as `mu serve`.

- Set defaults in `.mu/config.json` (`control_plane.operator.*`)

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
