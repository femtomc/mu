---
name: setup-neovim
description: "Sets up the mu.nvim messaging channel with agent-first config, reload, verification, and identity linking steps. Use when onboarding or repairing Neovim channel integration."
---

# setup-neovim

Use this skill when the user asks to set up the Neovim messaging channel (`mu.nvim`).

Goal: get `:Mu ...` working against `mu` control-plane with minimal user-side editor actions.

## Contents

- [Required user-provided inputs](#required-user-provided-inputs)
- [Agent-first workflow](#agent-first-workflow)
- [Evaluation scenarios](#evaluation-scenarios)
- [Safety and UX requirements](#safety-and-ux-requirements)

## Required user-provided inputs

- Confirmation that `mu.nvim` is installed (or permission for the agent to provide install snippet)
- Neovim-side place to set shared secret (`shared_secret` option or `MU_NEOVIM_SHARED_SECRET` env)

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

If no running server exists for reload/capability checks, ask user to run `mu serve` in another terminal.

### 2) Generate and set a shared secret (agent)

Generate a strong shared secret, then patch config with this canonical snippet
(preserves unrelated keys):

```bash
export MU_NEOVIM_SHARED_SECRET='<NEOVIM_SHARED_SECRET>'
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
neovim = adapters.setdefault("neovim", {})
neovim["shared_secret"] = os.environ["MU_NEOVIM_SHARED_SECRET"]

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n")
PY
```

Replace `<NEOVIM_SHARED_SECRET>` with the generated secret, then `unset MU_NEOVIM_SHARED_SECRET`.

### 3) Reload and verify channel capability

```bash
mu control reload
mu control status --json --pretty
curl -sS http://localhost:3000/api/control-plane/channels | jq '.channels[] | select(.channel=="neovim")'
```

Verify:
- `configured: true`
- `active: true` (when server is running)
- route `/webhooks/neovim`

### 4) Provide minimal user editor steps

Ask user to do only these actions in Neovim:

1. Set the same shared secret in `mu.nvim` config (or env var `MU_NEOVIM_SHARED_SECRET`).
2. Ensure plugin points at the running server (default server discovery is fine if available).
3. Run:
   - `:Mu channels`
   - `:Mu link`
   - `:Mu status`

` :Mu link` is the preferred identity binding path for Neovim.

### 5) Optional agent-side identity link fallback

If `:Mu link` is unavailable, derive actor/tenant from adapter audit after one Neovim request,
then link via control-plane API:

```bash
mu store tail cp_adapter_audit --limit 50 --json \
  | jq -r '[.[] | select(.channel=="neovim")] | last | "actor=\(.actor_id) tenant=\(.channel_tenant_id)"'

curl -sS -X POST http://localhost:3000/api/control-plane/identities/link \
  -H 'content-type: application/json' \
  -d '{"channel":"neovim","actor_id":"<actor-id>","tenant_id":"<tenant-id>","role":"operator"}'
```

### 6) Smoke and forensics

```bash
mu control status --pretty
mu control identities --all --pretty
mu store tail cp_adapter_audit --limit 20 --pretty
```

Confirm `:Mu status` returns a valid response in-editor.

## Evaluation scenarios

1. **Happy path with `:Mu link`**
   - Inputs: matching shared secret in server + plugin, running `mu serve`.
   - Expected: `:Mu channels` lists neovim as active; `:Mu link` succeeds; `:Mu status` returns valid response.

2. **Shared-secret mismatch**
   - Inputs: plugin secret differs from `control_plane.adapters.neovim.shared_secret`.
   - Expected: neovim requests are rejected with deterministic auth reason; skill rotates/re-syncs secret and revalidates.

3. **Manual identity-link fallback**
   - Inputs: `:Mu link` unavailable in plugin version.
   - Expected: skill extracts actor/tenant from adapter audit and links via control-plane API; identity appears in `mu control identities --all --pretty`.

## Safety and UX requirements

- Do not expose full shared secret in final user-facing summaries.
- Keep user asks limited to in-editor actions only.
- If failures occur, cite exact reason codes and next smallest recovery step.
