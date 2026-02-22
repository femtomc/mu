---
name: setup-slack
description: Agent-first Slack adapter setup runbook (config, reload, verification, and identity linking with minimal user-side UI steps).
---

# setup-slack

Use this skill when the user asks to set up Slack messaging for `mu`.

Goal: get `/mu ...` working end-to-end in Slack, with the agent doing all local setup and asking the user only for Slack-console actions/secrets the agent cannot perform.

## Required user-provided inputs

- Public webhook base URL reachable by Slack (for example `https://mu.example.com`)
- Slack app **Signing Secret**
- Slack app **Bot User OAuth Token** (`xoxb-...`) for outbound replies/media

## Agent-first workflow

### 1) Preflight local state

```bash
mu control status --pretty
mu store paths --pretty
mu control identities --all --pretty
```

If no running server is available when reload/route checks are attempted, ask the user to run `mu serve` in another terminal, then continue.

### 2) Drive user through Slack console steps (minimal ask)

Ask the user to do only these actions in Slack API UI:

1. Create/install a Slack app in target workspace.
2. Configure request URL for all inbound surfaces to:
   - `https://<public-base>/webhooks/slack`
3. Enable at least:
   - Slash command `/mu`
   - Event Subscriptions (`app_mention`)
   - Interactivity
4. Ensure bot scopes include:
   - `app_mentions:read`
   - `chat:write`
   - `files:read`
   - `files:write`
5. Return `signing_secret` and `bot_token` to the agent.

### 3) Agent patches mu config (do not ask user to edit JSON)

Resolve `<store>/config.json` via `mu store paths --pretty`, then set:

- `control_plane.adapters.slack.signing_secret`
- `control_plane.adapters.slack.bot_token`

Preserve unrelated keys.

### 4) Reload and verify adapter status

```bash
mu control reload
mu control status --json --pretty
curl -sS http://localhost:3000/api/control-plane/channels | jq '.channels[] | select(.channel=="slack")'
```

Verify:
- `configured: true`
- `active: true` (when server is running)
- route `/webhooks/slack`

### 5) Identity link with least user effort

Preferred flow:
1. Ask user to send one Slack turn (for example `/mu status`).
2. Extract actor + tenant IDs from audit.
3. Link identity as operator.

```bash
mu store tail cp_adapter_audit --limit 50 --json \
  | jq -r '[.[] | select(.channel=="slack")] | last | "actor=\(.actor_id) tenant=\(.channel_tenant_id)"'

mu control link --channel slack --actor-id <actor-id> --tenant-id <tenant-id> --role operator
mu control identities --pretty
```

If audit rows are unavailable, ask user for Slack IDs (`U...` user id, `T...` workspace id).

### 6) Smoke test + forensic confirmation

```bash
mu control status --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
mu store tail cp_outbox --limit 20 --pretty
```

Ask user to run `/mu status` again and confirm response delivery.

## Safety and UX requirements

- Never expose secrets in chat logs unnecessarily; redact in summaries.
- Do not overwrite unrelated `config.json` fields.
- Keep the user ask short and sequential (one external-console step at a time).
- If setup fails, report concrete reason codes from audit/outbox and propose the next smallest recovery step.
