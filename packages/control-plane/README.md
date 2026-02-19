# @femtomc/mu-control-plane

Control-plane command pipeline for messaging ingress, policy/confirmation safety, idempotency, and outbox delivery. The messaging operator runtime lives in `@femtomc/mu-agent`.

## First-platform messaging adapters (v1)

- Slack
- Discord
- Telegram
- Neovim
- VSCode

All adapters normalize inbound commands into the same control-plane pipeline and preserve correlation across command journal and outbox delivery.

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
- `VscodeControlPlaneAdapterSpec`

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

- server discovery (`.mu/control-plane/server.json`)
- channel capability fetch (`/api/control-plane/channels`)
- identity link bootstrap (`/api/identities/link`)
- frontend ingress submission (`/webhooks/neovim`, `/webhooks/vscode`)
- session flash inbox writes (`/api/session-flash`)
- session turn injection (`/api/session-turn`) for real in-session turns with reply + context cursor

These helpers are intended to keep Neovim/VSCode integration clients aligned with control-plane channel contracts.

## iMessage status

iMessage is not supported by the v1 runtime. Identity rows must use first-platform channels (`slack`, `discord`, `telegram`, `neovim`, `vscode`). Unsupported channels are rejected during replay.
