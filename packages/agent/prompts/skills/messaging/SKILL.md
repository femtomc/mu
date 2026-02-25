---
name: messaging
description: "Meta-skill for messaging/channel onboarding. Routes to setup-slack, setup-discord, setup-telegram, and setup-neovim."
---

# messaging

Use this meta-skill when the user asks to onboard, repair, or verify channel messaging integration.

## Subskills

- `setup-slack` — Slack adapter setup, verification, and identity linking.
- `setup-discord` — Discord adapter setup, verification, and identity linking.
- `setup-telegram` — Telegram adapter setup, webhook flow, and identity linking.
- `setup-neovim` — Neovim (`mu.nvim`) channel setup and identity linking.

## Selection guide

1. Pick the channel-specific setup skill that matches the target adapter.
2. Run setup in an inspect -> patch config -> reload -> verify loop.
3. Confirm identities and delivery behavior before declaring completion.
