# @femtomc/mu-control-plane

Control-plane command pipeline for messaging ingress, policy/confirmation safety, idempotency, and outbox delivery. The messaging operator runtime lives in `@femtomc/mu-agent`.

## First-party messaging adapters

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
  - Subscribe to bot event: `message`
- **Interactivity & Shortcuts**
  - Enable interactivity
  - Request URL: `https://<your-host>/webhooks/slack`

Recommended bot token scopes:

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

### 6) Smoke tests

1. In Slack, run `/mu status`.
2. Expect immediate ephemeral ACK and a deferred result message.
3. Validate runtime/audit:

```bash
mu control status --pretty
mu store tail cp_commands --limit 20 --pretty
mu store tail cp_outbox --limit 20 --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
```

4. Optional event path check (message events): send `/mu status` as text in an event-enabled surface and verify acceptance. Non-command text should no-op by policy.

### 7) Troubleshooting (reason-code oriented)

- `missing_slack_signature` / `invalid_slack_signature`
  - Slack signing secret mismatch or wrong endpoint.
- `invalid_slack_timestamp` / `stale_slack_timestamp`
  - malformed or stale signed request timestamp.
- `slack_command_required`
  - slash payload not using `/mu` command.
- `channel_requires_explicit_command`
  - event message was freeform text; Slack ingress is explicit-command only.
- `unsupported_slack_action_payload`
  - interactive payload did not match `confirm:<id>` or `cancel:<id>`.
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

### Slack UX contract: explicit commands + confirmation actions

Slack ingress currently supports two accepted payload families on `/webhooks/slack`:

- Slash commands (`application/x-www-form-urlencoded`), where `command` must be `/mu`
- Events API callbacks (`application/json`) where `type=event_callback` and `event.type=message`

For both DMs and channels, command execution is explicit-command only:

- Accepted command text must normalize to `/mu ...`
- Non-command freeform turns are deterministic no-op with reason `channel_requires_explicit_command`
- Slack slash payloads with `command != /mu` are deterministic no-op with reason `slack_command_required`

#### Confirmation action payload contract (for Slack interactive surfaces)

To preserve parity with typed command semantics, interactive confirmation payloads must normalize to the same command pair:

- `confirm:<command_id>` → `/mu confirm <command_id>`
- `cancel:<command_id>` → `/mu cancel <command_id>`

`<command_id>` constraints:

- non-empty
- no whitespace
- no additional `:` separators

Unsupported/invalid action payloads (including malformed IDs or unknown action verbs) must be treated as deterministic no-op, with explicit audit reason `unsupported_slack_action_payload`, and must not mutate command lifecycle state.

#### Slack ACK/error/guidance copy style

Slack responses should stay concise and deterministic:

- ACK path (slash command immediate response): one-line status + short guidance, ephemeral
- Non-command guidance: "Slack ingress is command-only on this route. Use `/mu <command>` for actionable requests."
- Error surface: include canonical reason code in contract metadata and concise user text in rendered body

Behavioral invariant: interactive confirm/cancel buttons are convenience UI only; `/mu confirm <id>` and `/mu cancel <id>` remain the source-of-truth fallback paths.

### Telegram callback/gating/chunking contract

Callback payload schema for inline confirmation buttons is intentionally narrow and deterministic:

- Supported callback payloads:
  - `confirm:<command_id>`
  - `cancel:<command_id>`
- `<command_id>` must not include whitespace or additional `:` separators.
- Any other callback payload is rejected with `unsupported_telegram_callback` and an explicit callback ACK.

Behavioral invariants:

- Inline `Confirm`/`Cancel` buttons are convenience UI over the same command contract; `/mu confirm <id>` and `/mu cancel <id>` remain valid fallback parity paths.
- Private chats may use conversational freeform turns via the operator runtime.
- Group/supergroup chats require explicit `/mu ...` commands; freeform text is deterministic no-op with guidance.
- Outbound text keeps deterministic order when chunked; chunks are emitted in-order and preserve full body reconstruction.
- Reply anchoring uses `telegram_reply_to_message_id` when parseable; invalid anchor metadata gracefully falls back to non-anchored sends.
- Attachment-ingest failures preserve deterministic audit metadata while user-visible guidance is mapped to concise recovery copy.

### Text-only fallback invariants

- Existing text-only envelopes (no `attachments`) continue to use channel text endpoints (`chat.postMessage` for Slack, `sendMessage` for Telegram).
- Optional `attachments` remain schema-compatible; text-only payloads continue to work without changes.
- Telegram callback + group-gating behavior keeps the same command flow semantics because `/mu confirm|cancel <id>` and explicit `/mu ...` command ingress semantics are unchanged.

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

`MessagingOperatorRuntime` (from `@femtomc/mu-agent`) is the user-facing operator runtime that sits outside execution dispatch. It translates conversational channel input into approved command proposals and routes them through the same policy/idempotency/confirmation pipeline.

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

iMessage is not supported by this runtime. Identity rows use first-party channels (`slack`, `discord`, `telegram`, `neovim`). Unsupported channels are rejected during replay.
