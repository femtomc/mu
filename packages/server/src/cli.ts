#!/usr/bin/env bun

import { findRepoRoot } from "@femtomc/mu-core/node";
import { createServerAsync } from "./server.js";

const port = parseInt(Bun.env.PORT || "3000", 10);

let repoRoot: string;
try {
	repoRoot = findRepoRoot();
} catch {
	console.error("Error: Could not find .mu directory. Run 'mu serve' or 'mu run' once to initialize it.");
	process.exit(1);
}

console.log(`Starting mu-server on port ${port}...`);
console.log(`Repository root: ${repoRoot}`);

const { serverConfig, controlPlane } = await createServerAsync({ repoRoot, port });

let server: ReturnType<typeof Bun.serve>;
try {
	server = Bun.serve(serverConfig);
} catch (err) {
	try {
		await controlPlane?.stop();
	} catch {
		// Best effort cleanup. Preserve the startup error.
	}
	throw err;
}

console.log(`Server running at http://localhost:${port}`);

if (controlPlane && controlPlane.activeAdapters.length > 0) {
	console.log("Control plane: active");
	for (const a of controlPlane.activeAdapters) {
		console.log(`  ${a.name.padEnd(12)} ${a.route}`);
	}
} else {
	console.log(`Health check: http://localhost:${port}/healthz`);
	console.log(`API Status: http://localhost:${port}/api/status`);
}

const cleanup = async () => {
	await controlPlane?.stop();
	server.stop();
	process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log("Press Ctrl+C to stop");
