# @femtomc/mu-server

HTTP API server for mu control-plane infrastructure. Powers `mu serve`, messaging frontend transport routes, and control-plane/session coordination endpoints.

> Scope note: server-routed business query/mutation gateway endpoints have been removed. Business reads/writes are CLI-first, while long-lived runtime coordination (runs/heartbeats/cron) stays server-owned.

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

Use `mu store paths --pretty` to resolve `<store>` for the active repo/workspace.

## API Endpoints

### Health Check

- `GET /healthz` or `GET /health` - Returns 200 OK

### Status

- `GET /api/control-plane/status` - Returns repository + control-plane runtime status
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

- `GET /api/control-plane/config` - Read redacted `<store>/config.json` plus presence booleans
- `POST /api/control-plane/config` - Apply a partial patch to `<store>/config.json`
  - Body:
  ```json
  {
    "patch": {
      "control_plane": {
        "adapters": {
          "slack": { "signing_secret": "...", "bot_token": "xoxb-..." }
        },
        "memory_index": {
          "enabled": true,
          "every_ms": 300000
        },
        "operator": {
          "timeout_ms": 600000
        }
      }
    }
  }
  ```
- `POST /api/control-plane/reload` - Trigger generation-scoped control-plane hot reload
  - Re-reads current config from `<store>/config.json` and executes warmup/cutover/drain/rollback flow
  - Coalesces concurrent requests onto a single in-flight attempt
  - Body (optional):
  ```json
  { "reason": "mu_setup_apply" }
  ```
  - Response includes generation metadata and, when telegram generation handling runs, `telegram_generation` lifecycle detail.
- `POST /api/control-plane/rollback` - Explicit rollback trigger (same pipeline, reason=`rollback`)
- `GET /api/control-plane/channels` - Capability/discovery snapshot for mounted adapter channels (route, verification contract, configured/active/frontend flags)

### Session Turn Injection (control-plane)

- `POST /api/control-plane/turn` - Run a real turn in an existing target session and return reply + new context cursor
  - Requires Neovim frontend shared-secret header (`x-mu-neovim-secret`)
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

- Scheduling + coordination:
  - `GET|POST|PATCH|DELETE /api/heartbeats...`
  - `GET|POST|PATCH|DELETE /api/cron...`
  - Heartbeat programs support an optional free-form `prompt` field; when present it becomes the primary wake instruction sent to the operator turn path.
  - Heartbeat/cron ticks dispatch operator wake turns and broadcast the resulting operator reply.
  - Built-in memory-index maintenance runs on the server heartbeat scheduler (config: `control_plane.memory_index`).
- Identity bindings:
  - `GET /api/control-plane/identities`
  - `POST /api/control-plane/identities/link`
  - `POST /api/control-plane/identities/unlink`
- Observability:
  - `GET /api/control-plane/events`
  - `GET /api/control-plane/events/tail`

## Messaging adapter setup (workspace config)

1) Resolve workspace paths and inspect current readiness:

```bash
mu store paths --pretty
mu control status --pretty
```

2) Edit `<store>/config.json` and set adapter secrets:

- Slack: `control_plane.adapters.slack.signing_secret`, `bot_token`
- Discord: `control_plane.adapters.discord.signing_secret`
- Telegram: `control_plane.adapters.telegram.webhook_secret`, `bot_token`, `bot_username`
- Neovim: `control_plane.adapters.neovim.shared_secret`
- Optional operator tuning: `control_plane.operator.timeout_ms` (max wall-time per messaging turn, default `600000`).

3) Reload live control-plane runtime:

```bash
mu control reload
# or POST /api/control-plane/reload
```

4) Link identities for channel actors (examples):

```bash
mu control link --channel slack --actor-id U123 --tenant-id T123
mu control link --channel discord --actor-id <user-id> --tenant-id <guild-id>
mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot
```

For Neovim, use `:Mu link` in `mu.nvim` after configuring `shared_secret`.

## Media support operations checklist

When validating attachment support end-to-end, use this sequence:

1. Configure adapter secrets/tokens in `<store>/config.json` (Slack/Telegram need bot tokens for media egress).
2. Reload control-plane (`mu control reload`).
3. Verify `/api/control-plane/channels` media capability flags:
   - `media.outbound_delivery`
   - `media.inbound_attachment_download`
4. Send a text-only control-plane turn and verify normal delivery semantics still hold.
5. Send attachment-bearing ingress/outbox payloads and verify channel-specific routing:
   - Slack media upload through `files.upload`
   - Telegram PNG/JPEG/WEBP images through `sendPhoto`
   - Telegram SVG/PDF through `sendDocument`

Operational fallback expectations:

- If media upload fails, Telegram delivery falls back to text `sendMessage`.
- Telegram text delivery chunks long messages into deterministic in-order `sendMessage` calls to stay below API size limits.
- When outbound metadata includes `telegram_reply_to_message_id`, Telegram delivery anchors replies to the originating chat message.
- Invalid/non-integer `telegram_reply_to_message_id` metadata is ignored so delivery degrades gracefully to non-anchored sends.
- Telegram callback action payloads are explicitly unsupported in the conversational-only runtime and return deterministic unsupported-action ACKs.
- Group/supergroup Telegram freeform text routes conversationally through the operator runtime (subject to identity linking).
- If Slack/Telegram bot token is missing, channel capability reason codes should report `*_bot_token_missing` and outbound delivery retries rather than hard-crashing runtime.

## Running the Server

### With terminal operator session (recommended)

The easiest way to run the server with the default terminal operator session:

```bash
# From any mu repository
mu serve              # API + terminal operator session
mu serve --port 8080  # Custom API/operator port
```

Type `/exit`, Ctrl+D, or Ctrl+C to leave the operator session. The server keeps running; use `mu stop` when you want to shut it down.

### Standalone Server

```bash
# Install globally
bun install -g @femtomc/mu-server

# Run server (derives workspace store from current repo root)
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

Control-plane/coordination data is persisted under `<store>/` (for example `<store>/events.jsonl` and `<store>/control-plane/*`). Use `mu store paths` to resolve `<store>` for your repo.
