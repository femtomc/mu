---
name: setup-telegram
description: "Sets up the Telegram messaging adapter with agent-first webhook, config, reload, verification, and identity linking steps. Use when onboarding or repairing Telegram channel integration."
---

# setup-telegram

Use this skill when the user asks to set up Telegram messaging for `mu`.

Goal: get Telegram bot ingress and reply delivery working with minimal user-side actions.

## Contents

- [Required user-provided inputs](#required-user-provided-inputs)
- [Agent-first workflow](#agent-first-workflow)
- [Evaluation scenarios](#evaluation-scenarios)
- [Safety requirements](#safety-requirements)

## Required user-provided inputs

- Public webhook base URL reachable by Telegram (for example `https://mu.example.com`)
- Telegram bot token (from BotFather)


## Agent-first workflow

### 0) Verify local prerequisites (agent)

```bash
command -v mu >/dev/null && echo "mu: ok"
command -v python3 >/dev/null && echo "python3: ok (required for config patching)"
command -v curl >/dev/null && echo "curl: ok (required for Telegram API + channel checks)"
command -v jq >/dev/null && echo "jq: ok (required for filtered JSON checks)"
```

If any required command is missing, stop and ask the user to install it before proceeding.

### 1) Preflight local state

```bash
mu control status --pretty
mu store paths --pretty
mu control identities --all --pretty
```

If no running server is available, ask user to start `mu serve` in another terminal before reload/route checks.

### 2) Generate webhook secret

Generate a strong webhook secret (do not expose it in final summaries).

### 3) Configure Telegram webhook (agent does this when possible)

Set webhook to `https://<public-base>/webhooks/telegram` with secret token:

```bash
curl -sS "https://api.telegram.org/bot<bot-token>/setWebhook" \
  --data-urlencode "url=https://<public-base>/webhooks/telegram" \
  --data-urlencode "secret_token=<webhook-secret>"
```

If the agent cannot reach Telegram APIs from its environment, give user this exact command and continue once they confirm success.

### 4) Patch mu config

Use this canonical patch snippet (preserves unrelated keys):

```bash
export MU_TELEGRAM_WEBHOOK_SECRET='<TELEGRAM_WEBHOOK_SECRET>'
export MU_TELEGRAM_BOT_TOKEN='<TELEGRAM_BOT_TOKEN>'
config_path="$(mu control status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["config_path"])')"

python3 - "$config_path" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
if path.exists():
    data = json.loads(path.read_text())
else:
    data = {"version": 1, "control_plane": {}}

cp = data.setdefault("control_plane", {})
adapters = cp.setdefault("adapters", {})
telegram = adapters.setdefault("telegram", {})
telegram["webhook_secret"] = os.environ["MU_TELEGRAM_WEBHOOK_SECRET"]
telegram["bot_token"] = os.environ["MU_TELEGRAM_BOT_TOKEN"]

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n")
PY
```

Replace placeholder values with secrets from the user.
Then `unset MU_TELEGRAM_WEBHOOK_SECRET MU_TELEGRAM_BOT_TOKEN` after patching.

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

## Evaluation scenarios

1. **Happy path with API reachability**
   - Inputs: valid bot token, reachable public webhook base URL, working `setWebhook` call.
   - Expected: Telegram channel reports `configured=true` + `active=true`; inbound message gets reply.

2. **Network-restricted agent environment**
   - Inputs: agent cannot reach `api.telegram.org`.
   - Expected: skill hands user exact `setWebhook` command, resumes after confirmation, and still completes local config/reload verification.

3. **Token+secret only configuration**
   - Inputs: valid bot token + webhook secret, no username discovery step.
   - Expected: adapter activates and identity link can proceed from audit chat id.

## Safety requirements

- Treat bot token and webhook secret as sensitive; do not echo full values in summaries.
- Keep user prompts focused on the few actions the agent cannot do (BotFather + optional network-restricted webhook call).
- Report concrete reason codes when attachment/media delivery fails.
