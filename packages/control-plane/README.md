# @femtomc/mu-control-plane

Operator-first conversational ingress runtime for messaging adapters,
idempotent turn handling, and outbox delivery.
The messaging operator runtime lives in `@femtomc/mu-agent`.

> Runtime model: command/mutation governance (command parser, policy,
> confirmation workflow, mutation execution) is handled outside this package.
> Ingress routes conversationally through the operator runtime.

## First-party messaging adapters

- Slack
- Discord
- Telegram
- Neovim

All adapters normalize inbound turns into the same operator ingress pipeline
and preserve correlation across idempotency/outbox delivery.

## Setup workflows (skills-first)

For adapter onboarding, prefer bundled setup skills (`setup-slack`, `setup-discord`,
`setup-telegram`, `setup-neovim`). These workflows are agent-first: the agent patches
config, reloads control-plane, verifies routes/capabilities, and asks users only for
required external-console steps and secret handoff.

Baseline control-plane checks:

```bash
mu control status --pretty
mu store paths --pretty
mu control reload
mu control identities --all --pretty
```

Adapter config keys (`<store>/config.json`):

- Slack: `control_plane.adapters.slack.signing_secret`, `bot_token`
- Discord: `control_plane.adapters.discord.signing_secret`
- Telegram: `control_plane.adapters.telegram.webhook_secret`, `bot_token`
- Neovim: `control_plane.adapters.neovim.shared_secret`

Identity linking:

```bash
mu control link --channel slack --actor-id U123 --tenant-id T123
mu control link --channel discord --actor-id <user-id> --tenant-id <guild-id>
mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot
```

`mu control link` currently covers Slack/Discord/Telegram.
For Neovim, use `:Mu link` from `mu.nvim`.

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

Interactive confirmation payloads (`confirm:<id>` / `cancel:<id>`) are unsupported (except Slack's built-in in-thread `Cancel turn` button action).

Slack behavior details:

- Conversational retries (`event_id`) are deduplicated for a short TTL.
- Context is thread-scoped via `slack_thread_ts`.
- With bot token configured, long turns use one in-thread progress anchor and in-place updates (`chat.update`).
- Progress updates now include request summary + coarse phase (`analyzing`, `reasoning`, `executing`, `delayed`) instead of elapsed-seconds-only heartbeats.
- Delayed runs include deterministic operator guidance (for example, run `/mu status` in parallel when a turn is taking unusually long).
- Progress anchors include an interactive `Cancel turn` button (Slack block action `mu_cancel_turn`) that routes through the same cancel path as text directives.
- Explicit cancel directives (`cancel`, `/mu cancel`, `/mu abort`) abort the active in-thread operator turn when one is running.
- When a turn is explicitly cancelled, the cancelled turn's terminal fallback message is suppressed to avoid duplicate "cancelled" chatter in the thread.

Telegram behavior details:

- Unsupported callback payloads return deterministic unsupported-action ACKs.
- Outbound text remains deterministically chunked.
- Reply anchoring (`telegram_reply_to_message_id`) is preserved when parseable.

### Text-only fallback invariants

- Text-only envelopes (no `attachments`) use channel text endpoints (`chat.postMessage` for Slack, `sendMessage` for Telegram).
- Optional `attachments` are schema-compatible; text-only payloads continue to work.

### UiDoc action support matrix

`operator_response.ui_docs` actions are supported with channel-specific rendering and deterministic
degradation.

Interactive transport requires explicit `action.metadata.command_text`; actions missing command text are
rendered as non-interactive fallback text and are not tokenized.

| Channel | Component rendering | Action transport | Degrade behavior |
| --- | --- | --- | --- |
| Slack | Rich blocks (`text`, `list`, `key_value`, `divider`) | Slack block buttons carrying tokenized `UiEvent` payloads | Falls back to deterministic action text lines when token payloads cannot be rendered |
| Discord | Text projection of `UiDoc` components | Discord component buttons with compact tokenized `custom_id` | Falls back to deterministic `Actions:` text lines when token issuance/size limits fail |
| Telegram | Text projection in `sendMessage` body | Inline keyboard callbacks encoded via callback-token store (`mu-ui:*`) | Falls back to deterministic `Actions:` command text lines when callback encoding is unavailable/oversized |
| Neovim | Frontend receives canonical `ui_docs` payload | Action `callback_token` returned to frontend, then posted back as `ui_event` | Missing/invalid/expired/consumed tokens return deterministic rejection payloads |
| Terminal (`channel=terminal`) | Text-only | Not supported (`ui_actions_not_implemented`) | Interactive actions must use Slack/Discord/Telegram/Neovim |

Live channel capability flags (including `ui.components` and `ui.actions`) are exposed via:

```bash
curl -s http://localhost:3000/api/control-plane/channels | jq '.channels[] | {channel, ui}'
```

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
- filename sanitization (including `../../etc/passwd`-style traversal stripping) before persisted metadata
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

Adapter UI affordances derive from canonical `ui_docs` (`UiDoc`) metadata propagated through the
pipeline. New renderer behavior should use the shared UI contract instead of introducing bespoke
adapter-specific payload formats.

`UiDocsStateStore` now journals latest UI-doc snapshots to
`<workspace>/control-plane/ui_docs_state.jsonl` using scope+revision semantics (`session` or
`conversation`). This enables durable resume and async multi-actor coordination without requiring
live in-memory extension state.

## Messaging operator runtime

`MessagingOperatorRuntime` (from `@femtomc/mu-agent`) is the user-facing runtime for conversational ingress.

The control-plane pipeline now focuses on:

- identity-link authorization,
- idempotent dedupe/conflict handling,
- operator turn execution,
- deterministic outbox delivery.

Command parsing/confirmation/mutation execution is handled outside the active control-plane runtime.

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
