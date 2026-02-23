---
name: setup-neovim
description: "Sets up the mu.nvim messaging channel with agent-first config, reload, verification, and identity linking steps. Use when onboarding or repairing Neovim channel integration."
---

# setup-neovim

Use this skill when the user asks to set up the Neovim messaging channel (`mu.nvim`).

Goal: get `:Mu ...` working against `mu` control-plane with minimal user-side editor actions.

## Required user-provided inputs

- Confirmation that `mu.nvim` is installed (or permission for the agent to provide install snippet)
- Neovim-side place to set shared secret (`shared_secret` option or `MU_NEOVIM_SHARED_SECRET` env)

## Agent-first workflow

### 1) Preflight local state

```bash
mu control status --pretty
mu store paths --pretty
mu control identities --all --pretty
```

If no running server exists for reload/capability checks, ask user to run `mu serve` in another terminal.

### 2) Generate and set a shared secret (agent)

Generate a strong secret and write it to `<store>/config.json`:

- `control_plane.adapters.neovim.shared_secret`

Preserve unrelated config keys.

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

## Safety and UX requirements

- Do not expose full shared secret in final user-facing summaries.
- Keep user asks limited to in-editor actions only.
- If failures occur, cite exact reason codes and next smallest recovery step.
