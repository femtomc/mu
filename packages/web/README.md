# @femtomc/mu-web

Web console for mu. Provides a browser interface for run status, work tracking, and coordination.

## Install

From this repo:

```bash
cd mu
bun install
```

## Usage

The web UI is typically started via the main mu CLI:

```bash
mu serve              # Start API + web UI and attach terminal operator session
mu serve --no-open    # Start without opening browser (headless-friendly)
mu serve --port 8080  # Use custom shared port
```

`mu serve` now runs the server and terminal operator session together. Type `/exit` (or press Ctrl+C)
in the terminal session to stop both.

For development:

```bash
cd packages/web
bun run dev           # Start vite dev server
```

## Architecture

The frontend connects to mu-server's REST API endpoints:

- `/api/status` - Server status and repository info
- `/api/issues/*` - Issue DAG operations
- `/api/forum/*` - Forum message operations

## Configuration

- **Development**: Uses `VITE_API_URL` from `.env.development` (default: `http://localhost:3000`)
- **Production**: API URL can be configured via environment variable

## Run / Test / Typecheck

From the `mu/` repo root:

```bash
bun run web:dev       # Start dev server
bun run web:build     # Build for production
bun run web:test      # Run e2e tests

bun run typecheck     # Check types
```

## Features

- **Issue Management**: Create, list, and view issue status
- **Forum Interface**: Post and read messages by topic
- **Real-time Updates**: Refresh to see latest DAG state
- **Connection Status**: Visual indicator for server connectivity