---
name: setup-telegram
description: "Use this when setting up the Telegram messaging adapter with agent-led webhook, config, verification, and identity linking steps."
---

# setup-telegram

Use this skill when the user asks to set up Telegram messaging for `mu`.

Goal: get Telegram bot ingress and reply delivery working with minimal user-side actions.

## Required user-provided inputs

- Public webhook base URL reachable by Telegram (for example `https://mu.example.com`)
- Telegram bot token (from BotFather)

Optional (agent can usually discover):
- Bot username

## Agent-first workflow

### 1) Preflight local state

```bash
mu control status --pretty
mu store paths --pretty
mu control identities --all --pretty
```

If no running server is available, ask user to start `mu serve` in another terminal before reload/route checks.

### 2) Generate webhook secret and discover bot username

Generate a strong webhook secret (do not expose it in final summaries).

If outbound network is available, discover bot username:

```bash
curl -sS "https://api.telegram.org/bot<bot-token>/getMe"
```

Extract `result.username` when present.

### 3) Configure Telegram webhook (agent does this when possible)

Set webhook to `https://<public-base>/webhooks/telegram` with secret token:

```bash
curl -sS "https://api.telegram.org/bot<bot-token>/setWebhook" \
  --data-urlencode "url=https://<public-base>/webhooks/telegram" \
  --data-urlencode "secret_token=<webhook-secret>"
```

If the agent cannot reach Telegram APIs from its environment, give user this exact command and continue once they confirm success.

### 4) Patch mu config

Set in `<store>/config.json`:

- `control_plane.adapters.telegram.webhook_secret`
- `control_plane.adapters.telegram.bot_token`
- `control_plane.adapters.telegram.bot_username` (if known; otherwise null/omitted)

Preserve unrelated keys.

### 5) Reload and verify

```bash
mu control reload
mu control status --json --pretty
curl -sS http://localhost:3000/api/control-plane/channels | jq '.channels[] | select(.channel=="telegram")'
```

Verify:
- `configured: true`
- `active: true` (with running server)
- route `/webhooks/telegram`

### 6) Identity link using audit-derived chat id

Preferred flow:
1. Ask user to send one message to the bot.
2. Extract latest Telegram audit row.
3. Link actor chat id to tenant `telegram-bot`.

```bash
mu store tail cp_adapter_audit --limit 50 --json \
  | jq -r '[.[] | select(.channel=="telegram")] | last | "actor=\(.actor_id)"'

mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot --role operator
mu control identities --pretty
```

If audit is unavailable, ask user for the chat id explicitly.

### 7) Smoke + delivery checks

```bash
mu control status --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
mu store tail cp_outbox --limit 20 --pretty
```

Ask user to send `/mu status` (or plain status text) and verify response delivery.

## Safety requirements

- Treat bot token and webhook secret as sensitive; do not echo full values in summaries.
- Keep user prompts focused on the few actions the agent cannot do (BotFather + optional network-restricted webhook call).
- Report concrete reason codes when attachment/media delivery fails.
