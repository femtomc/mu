# @femtomc/mu-control-plane

Control-plane command pipeline for messaging ingress, policy/confirmation safety, idempotency, and outbox delivery. The messaging operator runtime lives in `@femtomc/mu-agent`.

## First-platform messaging adapters (v1)

- Slack
- Discord
- Telegram
- Neovim

All adapters normalize inbound commands into the same control-plane pipeline and preserve correlation across command journal and outbox delivery.


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

If Telegram media upload rejects an attachment, delivery falls back to text-only `sendMessage` so the command result is still visible.

### Text-only fallback invariants

- Existing text-only envelopes (no `attachments`) continue to use channel text endpoints (`chat.postMessage` for Slack, `sendMessage` for Telegram).
- Optional `attachments` remain backward-compatible at schema level; text-only payloads do not require migration.

## Adapter contract (v1)

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

- Allowlist MIME types: `application/pdf`, `image/svg+xml`, `image/png`, `image/jpeg`, `image/webp`, `text/plain`
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

## Interaction contract + visual presentation (v1)

Control-plane responses now use a deterministic interaction contract (`interaction_contract.ts`) and a shared presenter.

### Contract fields

- `speaker`: `user | operator | mu_system | mu_tool` (`operator` is presented as Operator)
- `intent`: `chat | ack | lifecycle | result | error`
- `status`: `info | success | warning | error`
- `state`: normalized lifecycle state (`awaiting_confirmation`, `completed`, etc.)
- `summary`: concise one-line summary
- `details`: deterministic key/value details with `primary` vs `secondary` importance
- `actions`: suggested next commands (for example `/mu confirm <id>`)
- `transition`: optional `from -> to` state transition
- `payload`: structured JSON for expandable detail in rich clients

### Rendering modes

- **Compact**: webhook ACK path (summary-first + key details)
- **Detailed**: deferred outbox delivery (summary + hierarchy + structured payload block)

Outbox metadata stores the structured contract alongside rendered text (`interaction_message`,
`interaction_contract_version`, `interaction_render_mode`) so follow-on channel renderers can build richer,
collapsible UI while preserving deterministic serialization.

## Messaging operator + safe CLI triggers

`MessagingOperatorRuntime` (from `@femtomc/mu-agent`) is the user-facing operator runtime that sits outside orchestration execution dispatch. It translates conversational channel input into approved command proposals and routes them through the same policy/idempotency/confirmation pipeline.

CLI execution is constrained through an explicit allowlist (`MuCliCommandSurface`) and a non-shell runner (`MuCliRunner`).
Operator proposals can bridge readonly status/info queries (`status`, `ready`, `issue list`, `issue get`, `forum read`, `operator config get`, `operator model list`, `operator thinking list`) and mutating operator configuration actions (`operator model set`, `operator thinking set`). Mutations still require confirmation and are correlated end-to-end via:

- `operator_session_id`
- `operator_turn_id`
- `cli_invocation_id`
- `cli_command_kind`

Unsafe or ambiguous requests are rejected with explicit reasons (`context_missing`, `context_ambiguous`, `context_unauthorized`, `cli_validation_failed`, etc.).

## Frontend client helpers

`frontend_client_contract.ts` + `frontend_client.ts` expose typed helpers for first-party editor clients:

- server discovery (`<store>/control-plane/server.json`)
- channel capability fetch (`/api/control-plane/channels`)
- identity link bootstrap (`/api/control-plane/identities/link`)
- frontend ingress submission (`/webhooks/neovim`)
- session turn injection (`/api/control-plane/turn`) for real in-session turns with reply + context cursor

These helpers are intended to keep Neovim integration clients aligned with control-plane channel contracts.

## iMessage status

iMessage is not supported by the v1 runtime. Identity rows must use first-platform channels (`slack`, `discord`, `telegram`, `neovim`). Unsupported channels are rejected during replay.
