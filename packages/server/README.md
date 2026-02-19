# @femtomc/mu-server

HTTP API server for mu. Powers `mu serve`, the web UI, and programmatic status/control endpoints.

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

### Issues

- `GET /api/issues` - List issues
  - Query params: `?status=open&tag=bug&contains=crash&limit=50`
  - `limit` defaults to `200` and is clamped to `<= 200`.
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
  - Query params: `?root=issue-id&contains=worker&limit=20`
  - `limit` defaults to `200` and is clamped to `<= 200`.

### Forum

- `GET /api/forum/topics` - List forum topics
  - Query params: `?prefix=issue:&limit=20`
  - `limit` defaults to `100` and is clamped to `<= 200`.
- `GET /api/forum/read` - Read messages from topic
  - Query params: `?topic=issue:123&limit=50`
  - `limit` defaults to `50` and is clamped to `<= 200`.
- `POST /api/forum/post` - Post message to topic
  ```json
  {
    "topic": "issue:123",
    "body": "Message content",
    "author": "username"
  }
  ```

### Context Retrieval (Cross-store historical memory)

- `GET /api/context/search` - Search across `.mu` history stores
  - Query params: `query`/`q`, `limit`, `source`/`sources`, `issue_id`, `run_id`, `session_id`,
    `conversation_key`, `channel`, `channel_tenant_id`, `channel_conversation_id`, `actor_binding_id`,
    `topic`, `author`, `role`, `since`, `until`.
- `GET /api/context/timeline` - Ordered timeline view anchored to a scope
  - Requires at least one anchor filter: `conversation_key`, `issue_id`, `run_id`, `session_id`, `topic`, or `channel`.
  - Supports `order=asc|desc` and same filters as search.
- `GET /api/context/stats` - Source-level cardinality/text-size stats for indexed context items.

Context source kinds:

- `issues`, `forum`, `events`
- `cp_commands`, `cp_outbox`, `cp_adapter_audit`, `cp_operator_turns`, `cp_telegram_ingress`, `session_flash`
- `operator_sessions`, `cp_operator_sessions`

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