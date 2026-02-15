# @femtomc/mu-web

Minimal browser demo (no backend) for `@femtomc/mu-{core,issue,forum}` using IndexedDB (preferred) or localStorage (fallback).

## Install

From this repo:

```bash
cd mu
bun install
```

## Usage

```ts
import { EventLog, JsonlEventSink } from "@femtomc/mu-core";
import { IndexedDbJsonlStore } from "@femtomc/mu-core/browser";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";

const issuesJsonl = new IndexedDbJsonlStore({ dbName: "mu-demo", storeName: "issues" });
const forumJsonl = new IndexedDbJsonlStore({ dbName: "mu-demo", storeName: "forum" });
const eventsJsonl = new IndexedDbJsonlStore({ dbName: "mu-demo", storeName: "events" });

const events = new EventLog(new JsonlEventSink(eventsJsonl));
const issues = new IssueStore(issuesJsonl, { events });
const forum = new ForumStore(forumJsonl, { events });
```

## Run / Test / Typecheck

From the `mu/` repo root:

```bash
bun run web:dev
bun run web:build
bun run web:test

bun run typecheck
```

## Runtime

- **Browser app** (Vite). Data persists in your browser storage across reload.
- E2E uses **Playwright** and serves `dist/` via `Bun.serve` (so `web:test` requires Bun, not Node).
