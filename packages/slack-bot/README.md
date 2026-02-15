# @femtomc/mu-slack-bot

Minimal Slack slash-command + events handler for mu.

## Run

From the `mu/` repo root:

```bash
export SLACK_SIGNING_SECRET=...
export PORT=3000            # optional (default 3000)
export MU_REPO_ROOT=/path/to/repo  # optional

bun run packages/slack-bot/src/server.ts
```

## Environment

- `SLACK_SIGNING_SECRET` (required): Slack app signing secret.
- `PORT` (optional, default `3000`): HTTP listen port.
- `MU_REPO_ROOT` (optional): Path to the repo root containing `.mu/`. Defaults via
  `findRepoRoot(process.cwd())`.

## Endpoints

- `GET /healthz` (also `GET /health`)
- `POST /slack/commands` (Slack slash command receiver)
- `POST /slack/events` (Slack event subscriptions + URL verification)

## Slash Command

Configure a Slack slash command `/mu` pointing at `POST /slack/commands`.

- `/mu status`
- `/mu ready [rootId] [--limit N]`
- `/mu create <title> [| body]`

