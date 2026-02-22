# @femtomc/mu-control-plane

Operator-first conversational ingress runtime for messaging adapters, idempotent turn handling, and outbox delivery. The messaging operator runtime lives in `@femtomc/mu-agent`.

> Breaking model change: command/mutation governance (command parser, policy, confirmation workflow, mutation execution) has been removed from the active control-plane runtime. Ingress now routes conversationally through the operator runtime only.

## First-party messaging adapters

- Slack
- Discord
- Telegram
- Neovim

All adapters normalize inbound turns into the same operator ingress pipeline and preserve correlation across idempotency/outbox delivery.


## Runtime setup checklist

Use `mu store paths --pretty` to resolve `<store>`, then configure `<store>/config.json`:

- `control_plane.adapters.slack.signing_secret`
- `control_plane.adapters.slack.bot_token`
- `control_plane.adapters.discord.signing_secret`
- `control_plane.adapters.telegram.webhook_secret`
- `control_plane.adapters.telegram.bot_token`
- `control_plane.adapters.telegram.bot_username`
- `control_plane.adapters.neovim.shared_secret`

After config changes, run `mu control reload` (or `POST /api/control-plane/reload`).

Identity binding examples:

```bash
mu control link --channel slack --actor-id U123 --tenant-id T123
mu control link --channel discord --actor-id <user-id> --tenant-id <guild-id>
mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot
```

`mu control link` is currently for Slack/Discord/Telegram. For Neovim, use `:Mu link` from `mu.nvim`.

## Slack bot setup + onboarding runbook

This runbook is for first-time Slack setup where you want `/mu status` working end-to-end from Slack.

### 1) Start `mu` server and confirm route mount

```bash
mu serve
# in another shell
mu control status --pretty
curl -s http://localhost:3000/api/control-plane/channels | jq '.channels[] | select(.channel=="slack")'
```

Expected route from channel capabilities: `POST /webhooks/slack`.

### 2) Create Slack app

In Slack API UI:

1. Create app (from scratch) for your workspace.
2. Open **Basic Information** and copy:
   - **Signing Secret** (for inbound verification)
3. Open **OAuth & Permissions** and install app to workspace.
4. Copy **Bot User OAuth Token** (`xoxb-...`) for outbound Slack delivery.
   - Without `bot_token`, inbound slash/events can still ACK, but deferred outbound replies/media cannot be delivered.

### 3) Configure scopes and features in Slack app

Minimum practical setup for command flow:

- **Slash Commands**
  - Command: `/mu`
  - Request URL: `https://<your-host>/webhooks/slack`
- **Event Subscriptions**
  - Enable events
  - Request URL: `https://<your-host>/webhooks/slack`
  - Subscribe to bot event: `app_mention`
- **Interactivity & Shortcuts**
  - Enable interactivity
  - Request URL: `https://<your-host>/webhooks/slack`

Recommended bot token scopes:

- `app_mentions:read` (inbound `app_mention` events)
- `chat:write` (outbound text replies)
- `files:read` (inbound Slack file download from events)
- `files:write` (outbound Slack media delivery)

### 4) Wire `mu` config keys

Resolve `<store>` first:

```bash
mu store paths --pretty
```

Edit `<store>/config.json`:

```json
{
  "version": 1,
  "control_plane": {
    "adapters": {
      "slack": {
        "signing_secret": "<SLACK_SIGNING_SECRET>",
        "bot_token": "<SLACK_BOT_TOKEN_OR_NULL>"
      }
    }
  }
}
```

Apply config:

```bash
mu control reload
mu control status --pretty
```

Notes:

- `mu control status` marks Slack as configured when `signing_secret` is present.
- Deferred outbound delivery (including normal text replies and media) requires `bot_token`.

### 5) Link Slack identity to mu operator authorization

Use Slack actor/workspace IDs:

- `actor-id`: Slack user id (for example `U123...`)
- `tenant-id`: Slack workspace/team id (for example `T123...`)

```bash
mu control link --channel slack --actor-id U123 --tenant-id T123 --role operator
mu control identities --pretty
```

### Secure collaboration channel pattern (single driver, shared observers)

For a shared Slack channel, keep exactly one linked actor as the active bot driver. Everyone else can read bot output and participate in discussion, but only the linked actor should be authorized to drive command/conversational ingress.

Practical rotation flow (handoff from `U_OLD` to `U_NEW` in workspace `T123`):

```bash
# Inspect current bindings first and identify old binding_id
mu control identities --pretty

# Remove previous driver binding (admin revoke)
mu control unlink <old-binding-id> --revoke --reason "driver handoff"

# Link the new driver
mu control link --channel slack --actor-id U_NEW --tenant-id T123 --role operator

# Re-check effective state
mu control identities --pretty
```

Operational guidance:

- Keep one active linked actor per collaboration surface/thread when you want strict control ownership.
- If multiple actors are linked, each linked actor is authorized; this weakens single-driver control.
- Use unlink during handoffs/on-call rotation so authorization intent stays explicit and auditable.

Thread behavior in this pattern:

- Replies are anchored to the originating Slack thread (`event.thread_ts` when present; otherwise message timestamp fallback).
- Linked-driver conversational turns in that thread can route through operator handling.
- Linked actor conversational turns in-thread route through operator handling and can propose command execution when needed.
- Unlinked observers are denied with `identity_not_linked` for both conversational and explicit command ingress.

### 6) Smoke tests

1. In Slack, run `/mu status`.
2. Expect immediate ephemeral ACK and a deferred result message.
3. Validate runtime/audit:

```bash
mu control status --pretty
mu store tail cp_outbox --limit 20 --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
```

4. Optional event path check (message events): send `/mu status` and a conversational mention in an event-enabled surface; both should be accepted when actor linkage is valid.

### 7) Troubleshooting (reason-code oriented)

- `missing_slack_signature` / `invalid_slack_signature`
  - Slack signing secret mismatch or wrong endpoint.
- `invalid_slack_timestamp` / `stale_slack_timestamp`
  - malformed or stale signed request timestamp.
- `unsupported_slack_action_payload`
  - interactive button payloads are no longer accepted on Slack ingress.
- `slack_bot_token_required`
  - Slack file download attempted without `control_plane.adapters.slack.bot_token`.

Operational checks:

```bash
mu control status --pretty
curl -s http://localhost:3000/api/control-plane/channels | jq '.channels[] | select(.channel=="slack")'
mu store tail cp_adapter_audit --limit 50 --pretty
mu store tail cp_outbox --limit 50 --pretty
```

## Media support runbook (Slack + Telegram)

Use this runbook when enabling attachment ingress/egress and debugging media regressions.

### Supported media types + limits

Inbound attachment download policy currently allows:

- `application/pdf`
- `image/svg+xml`
- `image/png`
- `image/jpeg`
- `image/webp`
- `text/plain`
- `text/markdown`
- `text/x-markdown`

Constraints:

- Max size: `10 MiB` per attachment
- Default ingress enablement: Slack + Telegram enabled; other channels disabled
- Retention: `24h` default TTL (`inboundAttachmentExpiryMs`)
- Deterministic policy denies include explicit reason codes (for example `inbound_attachment_unsupported_mime`, `inbound_attachment_oversize`)

### Required config for media delivery

Both inbound download and outbound media delivery require channel bot credentials in `<store>/config.json`.

Slack:

- `control_plane.adapters.slack.signing_secret`
- `control_plane.adapters.slack.bot_token`

Telegram:

- `control_plane.adapters.telegram.webhook_secret`
- `control_plane.adapters.telegram.bot_token`
- `control_plane.adapters.telegram.bot_username` (recommended for command normalization)

Apply config updates with:

```bash
mu control reload
```

Then verify capability flags:

```bash
mu control status --pretty
curl -s http://localhost:3000/api/control-plane/channels | jq '.channels[] | {channel, media}'
```

### Outbound media routing behavior (Telegram-specific)

Telegram delivery chooses API method by attachment type/mime:

- PNG/JPEG/WEBP image attachments route to `sendPhoto`
- SVG (`image/svg+xml` or `.svg`) routes to `sendDocument` (not `sendPhoto`)
- PDF routes to `sendDocument`

If Telegram media upload rejects an attachment, delivery falls back to text-only `sendMessage` so the operator reply is still visible.

### Slack + Telegram UX contract (conversational ingress only)

Both Slack and Telegram ingress are conversational-first:

- Linked actors route inbound turns through the operator runtime.
- Unlinked actors are denied with `identity_not_linked`.
- Slack supports slash payloads and `app_mention` event callbacks.
- Telegram supports private/group/supergroup message text/caption ingress.

Interactive confirmation payloads (`confirm:<id>` / `cancel:<id>`) are no longer part of the active runtime contract. Adapters treat those payloads as unsupported.

Slack behavior details:

- Conversational retries (`event_id`) are deduplicated for a short TTL.
- Context is thread-scoped via `slack_thread_ts`.
- With bot token configured, long turns use one in-thread progress anchor and in-place updates (`chat.update`).

Telegram behavior details:

- Callback payloads that previously represented confirm/cancel now return deterministic unsupported-action ACKs.
- Outbound text remains deterministically chunked.
- Reply anchoring (`telegram_reply_to_message_id`) is preserved when parseable.

### Text-only fallback invariants

- Existing text-only envelopes (no `attachments`) continue to use channel text endpoints (`chat.postMessage` for Slack, `sendMessage` for Telegram).
- Optional `attachments` remain schema-compatible; text-only payloads continue to work without changes.

## Adapter contract

Adapter integration points are now explicitly specified in code (`adapter_contract.ts`):

- `ControlPlaneAdapter` interface (`spec` + `ingest(req)`)
- `ControlPlaneAdapterSpecSchema` (channel, route, payload format, verification model, ACK format)
- `AdapterIngressResult` shape (acceptance, normalized inbound envelope, pipeline result, outbox record)

Built-in specs are exported for each first-platform adapter:

- `SlackControlPlaneAdapterSpec`
- `DiscordControlPlaneAdapterSpec`
- `TelegramControlPlaneAdapterSpec`
- `NeovimControlPlaneAdapterSpec`

Default routes + verification contracts:

- Slack: `POST /webhooks/slack` with `x-slack-signature` + `x-slack-request-timestamp`
- Discord: `POST /webhooks/discord` with `x-discord-signature` + `x-discord-request-timestamp`
- Telegram: `POST /webhooks/telegram` with `x-telegram-bot-api-secret-token`
- Neovim: `POST /webhooks/neovim` with `x-mu-neovim-secret`

This keeps adapter behavior consistent and makes it easier to add new surfaces without changing core pipeline semantics.

## Inbound attachment retrieval policy (Option B baseline)

`inbound_attachment_policy.ts` codifies deterministic security controls for downloaded inbound files:

- Allowlist MIME types: `application/pdf`, `image/svg+xml`, `image/png`, `image/jpeg`, `image/webp`, `text/plain`, `text/markdown`, `text/x-markdown`
- Max size: `10 MiB` per attachment
- Channel download mode defaults: Slack + Telegram enabled, others disabled
- Malware hook policy: quarantine-on-suspect behavior with deterministic deny reason codes
- Dedupe requirements: channel file id and post-download content hash checks
- Retention defaults: `24h` TTL for blobs + metadata (`inboundAttachmentExpiryMs`)
- Redacted audit metadata shape for adapter audit rows (`reason_code`, stage, policy marker)

Policy evaluators:

- `evaluateInboundAttachmentPreDownload(...)`
- `evaluateInboundAttachmentPostDownload(...)`
- `summarizeInboundAttachmentPolicy(...)`

Both evaluators return deterministic allow/deny decisions and reason codes suitable for adapter audit/event logging.

For Telegram inbound media, attachment retrieval/policy failures are also converted into concise conversational guidance (while preserving raw deterministic audit reason codes in metadata) so users can recover by retrying with supported files or plain text.

## Inbound attachment store + retention lifecycle

`inbound_attachment_store.ts` provides shared storage primitives for downloaded inbound files:

- deterministic blob layout under `control-plane/attachments/blobs/sha256/<aa>/<bb>/<hash>.<ext>`
- JSONL metadata index at `control-plane/attachments/index.jsonl` with append-only upsert/expire events
- filename sanitization (`../../etc/passwd`-style traversal removed) before persisted metadata
- dedupe by `channel+source+source_file_id` first, then content hash fallback
- TTL cleanup (`cleanupExpired`) that expires metadata and garbage-collects unreferenced blobs

Helpers:

- `buildInboundAttachmentStorePaths(controlPlaneDir)`
- `toInboundAttachmentReference(record)` for adapter metadata references (`source=mu-attachment:<channel>`, `file_id=<attachment_id>`)

## Interaction contract + visual presentation

Control-plane responses now use a deterministic interaction contract (`interaction_contract.ts`) and a shared presenter.

### Contract fields

- `speaker`: `user | operator | mu_system | mu_tool` (`operator` is presented as Operator)
- `intent`: `chat | ack | lifecycle | result | error`
- `status`: `info | success | warning | error`
- `state`: normalized interaction state (`responded`, `ignored`, `denied`, etc.)
- `summary`: concise one-line summary
- `details`: deterministic key/value details with `primary` vs `secondary` importance
- `actions`: optional suggested follow-ups (typically empty in current runtime)
- `transition`: optional `from -> to` state transition
- `payload`: structured JSON for expandable detail in rich clients

### Rendering modes

- **Compact**: webhook ACK path (summary-first + key details)
- **Detailed**: deferred outbox delivery (summary + hierarchy + structured payload block)

Outbox metadata stores the structured contract alongside rendered text (`interaction_message`,
`interaction_contract_version`, `interaction_render_mode`) so follow-on channel renderers can build richer,
collapsible UI while preserving deterministic serialization.

## Messaging operator runtime

`MessagingOperatorRuntime` (from `@femtomc/mu-agent`) is the user-facing runtime for conversational ingress.

The control-plane pipeline now focuses on:

- identity-link authorization,
- idempotent dedupe/conflict handling,
- operator turn execution,
- deterministic outbox delivery.

Legacy command parsing/confirmation/mutation execution is no longer part of the active control-plane runtime.

## Frontend client helpers

`frontend_client_contract.ts` + `frontend_client.ts` expose typed helpers for first-party editor clients:

- server discovery (`<store>/control-plane/server.json`)
- channel capability fetch (`/api/control-plane/channels`)
- identity link bootstrap (`/api/control-plane/identities/link`)
- frontend ingress submission (`/webhooks/neovim`)
- session turn injection (`/api/control-plane/turn`) for real in-session turns with reply + context cursor

These helpers are intended to keep Neovim integration clients aligned with control-plane channel contracts.

## iMessage status

iMessage is not supported by this runtime. Identity rows use first-party channels (`slack`, `discord`, `telegram`, `neovim`). Unsupported channels are rejected during replay.
