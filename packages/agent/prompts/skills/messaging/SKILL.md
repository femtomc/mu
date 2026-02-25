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

## Common patterns

- **Agent-First Bootstrap**: Rather than asking the user for all details upfront, start the correct `setup-*` skill to investigate the current `mu` config, generate generic adapter secrets locally (if possible), and only ask the user for web-portal-specific secrets (e.g. Discord bot tokens or Slack bot tokens).
- **Verification Loop**: After rewriting the channel configuration dict, use the `setup-*` pattern to reload the mu controller (`mu cron ...`) and explicitly check the latest service logs or remote test (`/mu health`) to ensure connectivity works before ending the run.
- **Identity Context Tying**: During adapter onboarding, link the local OS user identity with their remote Slack/Discord/Telegram IDs so that subsequent `mu exec` jobs running offline can accurately ping the user back.
