# mu.nvim (first-party Neovim frontend channel)

`mu.nvim` is a first-party Neovim frontend for `mu` control-plane.

It talks to the same control-plane channel pipeline as Slack/Discord/Telegram via
`/webhooks/neovim`, including identity/policy/audit semantics.

## Features

- Server discovery from `<store>/control-plane/server.json`
- Capability discovery from `GET /api/control-plane/channels`
- Identity bootstrap via `POST /api/control-plane/identities/link`
- Command ingress via `POST /webhooks/neovim`
- Shared-secret auth (`x-mu-neovim-secret`)
- Structured editor context handoff (`client_context`)
- Visual-selection context send via `:'<,'>Mu ...`
- Persistent panel UI (`ui.mode = "panel"`) with `:Mu panel ...`
- Async timeline polling (`:Mu tail on|off|once|status`)
- Session turn injection (`:Mu turn <session_id> <message>`) for real in-session turns (reply + context cursor)
- Legacy flash alias (`:Mu flash <session_id> <message>` -> `POST /api/control-plane/turn`)
- `:Mu` command + optional lowercase `:mu` alias

## Install (local monorepo)

With `lazy.nvim` in this monorepo checkout:

```lua
{
  dir = "/home/femtomc/Dev/workshop/mu/packages/neovim",
  name = "mu.nvim",
  config = function()
    require("mu").setup({
      -- required unless exported in env
      shared_secret = vim.env.MU_NEOVIM_SHARED_SECRET,

      -- optional overrides
      server_url = nil, -- defaults to <store>/control-plane/server.json
      enable_mu_alias = true, -- lets `:mu` expand to `:Mu`
      auto_link_identity = true,

      ui = {
        mode = "panel", -- panel | float | notify
        panel_height = 14,
      },

      poll = {
        enabled = false, -- start on :Mu tail on (or auto_start after first send)
        auto_start = true,
        interval_ms = 4000,
      },

      flash_session_kind = "cp_operator", -- default target kind for :Mu turn/:Mu flash
    })
  end,
}
```

## Server setup

Set a Neovim shared secret in `<store>/config.json` (resolve `<store>` with `mu store paths`):

```json
{
  "version": 1,
  "control_plane": {
    "adapters": {
      "neovim": {
        "shared_secret": "replace-me"
      }
    }
  }
}
```

Then reload control-plane:

```bash
mu control reload
# or POST /api/control-plane/reload
```

## Commands

- `:Mu <text>` — send command text to mu pipeline
- `:'<,'>Mu <text>` — same, with current visual/range selection included in `client_context.selection`
- `:Mu channels` — inspect channel capability payload
- `:Mu link` — link Neovim actor identity
- `:Mu panel [show|hide|clear]` — manage persistent panel window
- `:Mu tail [on|off|once|status]` — background poll control
- `:Mu turn <session_id> <message>` — run a real turn in target session (`POST /api/control-plane/turn`)
- `:Mu flash <session_id> <message>` — legacy alias of `:Mu turn`
- `:Mu help` — help text

Neovim requires user commands to start uppercase, so `:Mu` is canonical.
If `enable_mu_alias=true`, typing `:mu` auto-expands to `:Mu`.

## Default identity/context behavior

If not configured explicitly:

- `actor_id`: `nvim:<user>@<hostname>`
- `tenant_id`: `workspace:<repo_basename>`
- `conversation_id`: `nvim:<tenant_id>:tab:<tab_number>`

Requests include editor context (`client_context`) with cwd, repo root, current
buffer path/filetype, cursor location, and mode.

Session turn targeting expects a `session_id` (for example from `mu session list --pretty` or operator-provided IDs).

## Notes

- Requires Neovim with `vim.system` support (Neovim 0.10+).
- Background updates currently use channel-scoped timeline polling (`channel=neovim`, `channel_tenant_id`, `channel_conversation_id`).
- A dedicated frontend inbox/SSE transport can still be added later for lower-latency delivery.
