---
name: setup-discord
description: "Sets up the Discord messaging adapter with agent-first config, reload, verification, and identity linking steps. Use when onboarding or repairing Discord channel integration."
---

# setup-discord

Use this skill when the user asks to set up Discord messaging for `mu`.

Goal: get Discord `/mu` ingress working with minimal user effort outside the terminal.

## Required user-provided inputs

- Public webhook base URL reachable by Discord (for example `https://mu.example.com`)
- Discord app **Signing Secret**

## Agent-first workflow

### 0) Verify local prerequisites (agent)

```bash
command -v mu >/dev/null && echo "mu: ok"
command -v python3 >/dev/null && echo "python3: ok (required for config patching)"
command -v curl >/dev/null && echo "curl: ok (required for API checks)"
command -v jq >/dev/null && echo "jq: ok (required for filtered JSON checks)"
```

If any required command is missing, stop and ask the user to install it before proceeding.

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

Use this canonical patch snippet (preserves unrelated keys):

```bash
export MU_DISCORD_SIGNING_SECRET='<DISCORD_SIGNING_SECRET>'
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
discord = adapters.setdefault("discord", {})
discord["signing_secret"] = os.environ["MU_DISCORD_SIGNING_SECRET"]

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n")
PY
```

Replace placeholder values with secrets from the user, then `unset MU_DISCORD_SIGNING_SECRET` after patching.

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

## Evaluation scenarios

1. **Happy path onboarding**
   - Inputs: valid public base URL, `signing_secret`, running `mu serve`.
   - Expected: Discord channel reports `configured=true` and `active=true`; `/mu status` gets an ACK/response flow.

2. **Invalid signing secret**
   - Inputs: Discord app configured with one secret, `mu` config has another.
   - Expected: inbound interactions are denied with deterministic audit reason; skill routes user to correct secret + reload + smoke.

3. **Audit-assisted link fallback**
   - Inputs: command ingress works but no identity linked yet.
   - Expected: skill derives `actor_id`/`channel_tenant_id` from audit, links operator identity, verifies with `mu control identities --pretty`.

## Notes and caveats

- Discord setup requires only `signing_secret` in current config contract.
- Keep troubleshooting reason-code oriented (signature/timestamp/payload errors from adapter audit).
- Keep user asks minimal: dashboard actions + one test command.
