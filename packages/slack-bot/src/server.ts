#!/usr/bin/env bun

import { createSlackBotFromEnv } from "./index";

const bot = createSlackBotFromEnv(process.env);

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isFinite(port) || port <= 0) {
	throw new Error(`invalid PORT: ${JSON.stringify(process.env.PORT ?? "")}`);
}

Bun.serve({
	port,
	fetch: bot.fetch,
});

// eslint-disable-next-line no-console
console.log(`mu slack-bot listening on :${port}`);
