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
mu serve                   # Start server + terminal operator session + web UI (auto-inits .mu)
mu status                  # Show repository status
mu issues list             # List all issues
mu issues create "title"   # Create new issue
mu issues ready            # Show ready leaf issues
mu forum post topic -m "message"  # Post to forum
mu run "goal..."           # Run orchestration loop (auto-inits .mu)
mu resume <root-id>        # Resume interrupted run
mu chat                    # Interactive operator session
mu chat --message "..."    # One-shot operator turn
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
mu serve              # Default port: 3000 (operator session + web UI)
mu serve --no-open    # Don't open browser
mu serve --port 8080  # Custom port
```

Type `/exit` in the operator prompt (or press Ctrl+C) to stop both operator session and server.

In headless environments, it provides SSH port forwarding instructions.

### Operator session defaults

`mu serve`'s attached terminal operator session uses the same extension stack as `mu chat` and
inherits `.mu/config.json` defaults from `control_plane.operator.provider/model`
when present.

Standalone `mu chat` can still be overridden explicitly via flags:

```bash
mu chat --provider openai-codex --model gpt-5.3-codex
```

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
