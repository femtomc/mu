---
name: setup-discord
description: "Use this when setting up the Discord messaging adapter with an agent-first onboarding flow and minimal user dashboard steps."
---

# setup-discord

Use this skill when the user asks to set up Discord messaging for `mu`.

Goal: get Discord `/mu` ingress working with minimal user effort outside the terminal.

## Required user-provided inputs

- Public webhook base URL reachable by Discord (for example `https://mu.example.com`)
- Discord app **Signing Secret**

## Agent-first workflow

### 1) Preflight local state

```bash
mu control status --pretty
mu store paths --pretty
mu control identities --all --pretty
```

If server reload/route checks fail because no server is running, ask the user to start `mu serve` in another terminal, then continue.

### 2) Minimal user actions in Discord Developer Portal

Ask the user to do only these actions:

1. Create/select a Discord application.
2. Set Interactions endpoint URL to:
   - `https://<public-base>/webhooks/discord`
3. Create an application command named `mu` in the target guild/server.
4. Ensure the app is installed in the target guild.
5. Provide the app `signing_secret`.

### 3) Agent patches mu config

Set in `<store>/config.json`:

- `control_plane.adapters.discord.signing_secret`

Preserve all unrelated keys.

### 4) Reload and verify channel capability

```bash
mu control reload
mu control status --json --pretty
curl -sS http://localhost:3000/api/control-plane/channels | jq '.channels[] | select(.channel=="discord")'
```

Verify:
- `configured: true`
- `active: true` (when server is running)
- route `/webhooks/discord`

### 5) Identity linking with audit-assisted ID discovery

Preferred flow:
1. Ask user to run one Discord `/mu` command.
2. Extract `actor_id` + `channel_tenant_id` from adapter audit.
3. Link as operator.

```bash
mu store tail cp_adapter_audit --limit 50 --json \
  | jq -r '[.[] | select(.channel=="discord")] | last | "actor=\(.actor_id) tenant=\(.channel_tenant_id)"'

mu control link --channel discord --actor-id <actor-id> --tenant-id <tenant-id> --role operator
mu control identities --pretty
```

If audit data is missing, ask user for Discord user id + guild id directly.

### 6) Smoke checks

```bash
mu control status --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
mu store tail cp_outbox --limit 20 --pretty
```

Ask user to run `/mu status` and confirm ingress ACK behavior.

## Notes and caveats

- Discord setup requires only `signing_secret` in current config contract.
- Keep troubleshooting reason-code oriented (signature/timestamp/payload errors from adapter audit).
- Keep user asks minimal: dashboard actions + one test command.
