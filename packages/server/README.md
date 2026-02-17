# @femtomc/mu-server

HTTP API server for mu. Powers `mu serve`, the web UI, and programmatic status/control endpoints.

## Installation

```bash
bun add @femtomc/mu-server
```

## Usage

```typescript
import { createServer } from "@femtomc/mu-server";

// Create server with default options (uses current directory as repo root)
const server = createServer();

// Or specify custom repo root and port
const server = createServer({
  repoRoot: "/path/to/repo",
  port: 8080
});

// Start the server
Bun.serve(server);
```

## API Endpoints

### Health Check

- `GET /healthz` or `GET /health` - Returns 200 OK

### Status

- `GET /api/status` - Returns repository + control-plane runtime status
  ```json
  {
    "repo_root": "/path/to/repo",
    "open_count": 10,
    "ready_count": 3,
    "control_plane": {
      "active": true,
      "adapters": ["slack"],
      "routes": [{ "name": "slack", "route": "/webhooks/slack" }],
      "generation": {
        "supervisor_id": "control-plane",
        "active_generation": { "generation_id": "control-plane-gen-3", "generation_seq": 3 },
        "pending_reload": null,
        "last_reload": {
          "attempt_id": "control-plane-reload-4",
          "reason": "mu_setup_apply_slack",
          "state": "completed",
          "requested_at_ms": 0,
          "swapped_at_ms": 0,
          "finished_at_ms": 0,
          "from_generation": { "generation_id": "control-plane-gen-2", "generation_seq": 2 },
          "to_generation": { "generation_id": "control-plane-gen-3", "generation_seq": 3 }
        }
      },
      "observability": {
        "counters": {
          "reload_success_total": 4,
          "reload_failure_total": 0,
          "reload_drain_duration_ms_total": 73,
          "reload_drain_duration_samples_total": 4,
          "duplicate_signal_total": 0,
          "drop_signal_total": 0
        }
      }
    }
  }
  ```

### Config + Control Plane Admin

- `GET /api/config` - Read redacted `.mu/config.json` plus presence booleans
- `POST /api/config` - Apply a partial patch to `.mu/config.json`
  - Body:
  ```json
  {
    "patch": {
      "control_plane": {
        "adapters": {
          "slack": { "signing_secret": "..." }
        }
      }
    }
  }
  ```
- `POST /api/control-plane/reload` - Trigger generation-scoped control-plane hot reload
  - Re-reads current config from `.mu/config.json` and executes warmup/cutover/drain/rollback flow
  - Coalesces concurrent requests onto a single in-flight attempt
  - Body (optional):
  ```json
  { "reason": "mu_setup_apply" }
  ```
  - Response includes generation metadata and, when telegram generation handling runs, `telegram_generation` lifecycle detail.
- `POST /api/control-plane/rollback` - Explicit rollback trigger (same pipeline, reason=`rollback`)

### Issues

- `GET /api/issues` - List issues
  - Query params: `?status=open&tag=bug`
- `GET /api/issues/:id` - Get issue by ID
- `POST /api/issues` - Create new issue
  ```json
  {
    "title": "Issue title",
    "body": "Issue description",
    "tags": ["bug", "priority", "role:worker"],
    "priority": 2
  }
  ```
- `PATCH /api/issues/:id` - Update issue
- `POST /api/issues/:id/close` - Close issue
  ```json
  {
    "outcome": "success"
  }
  ```
- `POST /api/issues/:id/claim` - Claim issue (changes status to in_progress)
- `GET /api/issues/ready` - Get ready issues
  - Query param: `?root=issue-id`

### Forum

- `GET /api/forum/topics` - List forum topics
  - Query param: `?prefix=issue:`
- `GET /api/forum/read` - Read messages from topic
  - Query params: `?topic=issue:123&limit=50`
- `POST /api/forum/post` - Post message to topic
  ```json
  {
    "topic": "issue:123",
    "body": "Message content",
    "author": "username"
  }
  ```

## Running the Server

### With Web UI (Recommended)

The easiest way to run the server with the bundled web interface (and default terminal operator session):

```bash
# From any mu repository
mu serve              # API + web UI + terminal operator session
mu serve --no-open    # Skip browser auto-open (headless/SSH)
mu serve --port 8080  # Custom shared API/web UI port
```

Type `/exit` (or press Ctrl+C) to stop both the operator session and server.

### Standalone Server

```bash
# Install globally
bun install -g @femtomc/mu-server

# Run server (looks for .mu/ in current directory or ancestors)
mu-server

# Or set custom port
PORT=8080 mu-server
```

### Programmatic

```bash
# Run the example
bun run example.js
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build
bun run build

# Start server (after building)
bun run start
```

## Architecture

The server uses:
- Filesystem-backed JSONL stores (FsJsonlStore)
- IssueStore and ForumStore from mu packages
- Bun's built-in HTTP server
- Simple REST-style JSON API
- Generation-supervised control-plane hot reload lifecycle (see `docs/adr-0001-control-plane-hot-reload.md`)

All data is persisted to `.mu/` directory:
- `.mu/issues.jsonl` - Issue data
- `.mu/forum.jsonl` - Forum messages
- `.mu/events.jsonl` - Event log