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
Operator proposals can bridge readonly status/info queries (`status`, `ready`, `issue list`, `issue get`, `forum read`) plus mutating run lifecycle actions (`run start`, `run resume`), with run triggers still requiring confirmation and correlated end-to-end via:

- `operator_session_id`
- `operator_turn_id`
- `cli_invocation_id`
- `cli_command_kind`
- `run_root_id`

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
