# mu

Bun + TypeScript monorepo.

## Development

```bash
bun install
bun test
bun run typecheck
```

## Formatting

```bash
bun run fmt
bun run lint
bun run check
```

## Slack Bot

See `packages/slack-bot/README.md`.

## Browser

Minimal browser demo (no backend) lives at `packages/web/`.

```bash
# dev server
bun run web:dev

# build static assets
bun run web:build

# run headless e2e test (Playwright) against the built app
bun run web:test
```

Data lives in your browser:

- Preferred: IndexedDB database `mu-demo` with object stores `issues`, `forum`, `events`
- Fallback: localStorage keys `mu-demo:issues`, `mu-demo:forum`, `mu-demo:events`

Limitations:

- No schema migrations yet (wipe storage if shapes change).
- localStorage fallback is for tiny demos only (small quota).
