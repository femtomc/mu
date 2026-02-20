# @femtomc/mu-server

HTTP API server for mu control-plane infrastructure. Powers `mu serve`, messaging frontend transport routes, and control-plane/session coordination endpoints.

> Scope note: server-routed business query/mutation gateway endpoints have been removed. Business reads/writes are CLI-first, while long-lived runtime coordination (runs/activities/heartbeats/cron) stays server-owned.

## Installation

```bash
bun add @femtomc/mu-server
```

## Usage

```typescript
import { composeServerRuntime, createServerFromRuntime } from "@femtomc/mu-server";

const runtime = await composeServerRuntime({
  repoRoot: "/path/to/repo"
});

// Optional: inspect startup capabilities
console.log(runtime.capabilities);

const server = createServerFromRuntime(runtime, {
  port: 8080
});

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
- `GET /api/control-plane/channels` - Capability/discovery snapshot for mounted adapter channels (route, verification contract, configured/active/frontend flags)

### Session Flash Inbox (cross-session context handoff)

- `POST /api/session-flash` - Create a session-targeted flash message
  ```json
  {
    "session_id": "operator-abc123",
    "session_kind": "cp_operator",
    "body": "Use context id ctx-123 for this question",
    "context_ids": ["ctx-123"],
    "source": "neovim"
  }
  ```
- `GET /api/session-flash` - List flash messages
  - Query params: `session_id`, `session_kind`, `status=pending|delivered|all`, `contains`, `limit`
- `GET /api/session-flash/:flash_id` - Get one flash message by id
- `POST /api/session-flash/ack` - Mark a flash message delivered/acknowledged

### Session Turn Injection (canonical transcript turn)

- `POST /api/session-turn` - Run a real turn in an existing target session and return reply + new context cursor
  ```json
  {
    "session_id": "operator-abc123",
    "session_kind": "cp_operator",
    "body": "Summarize the last plan and propose next steps.",
    "source": "neovim"
  }
  ```
  - Optional overrides: `session_file`, `session_dir`, `provider`, `model`, `thinking`, `extension_profile`
  - Response includes: `turn.reply`, `turn.context_entry_id`, `turn.session_file`

### Control-plane Coordination Endpoints

- Runs:
  - `GET /api/runs`
  - `POST /api/runs/start`
  - `POST /api/runs/resume`
  - `POST /api/runs/interrupt`
  - `GET /api/runs/:id`
  - `GET /api/runs/:id/trace`
- Scheduling + orchestration:
  - `GET|POST|PATCH|DELETE /api/heartbeats...`
  - `GET|POST|PATCH|DELETE /api/cron...`
  - `GET|POST /api/activities...`
  - Heartbeat/cron ticks dispatch operator wake turns and broadcast the resulting operator reply.
- Identity bindings:
  - `GET /api/identities`
  - `POST /api/identities/link`
  - `POST /api/identities/unlink`
- Observability:
  - `GET /api/events`
  - `GET /api/events/tail`

## Running the Server

### With terminal operator session (recommended)

The easiest way to run the server with the default terminal operator session:

```bash
# From any mu repository
mu serve              # API + terminal operator session
mu serve --port 8080  # Custom API/operator port
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
- Filesystem-backed JSONL event storage (FsJsonlStore)
- Bun's built-in HTTP server
- Control-plane adapter/webhook transport + session coordination routes
- Generation-supervised control-plane hot reload lifecycle (see `docs/adr-0001-control-plane-hot-reload.md`)

Control-plane/coordination data is persisted to `.mu/` (for example `.mu/events.jsonl` and `.mu/control-plane/*`).
