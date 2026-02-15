#!/usr/bin/env node

import { createServer } from "./server.js";
import { findRepoRoot } from "@femtomc/mu-core/node";

const port = parseInt(process.env.PORT || "3000", 10);

let repoRoot: string;
try {
	repoRoot = findRepoRoot();
} catch {
	console.error("Error: Could not find .mu directory. Run 'mu init' first.");
	process.exit(1);
}

console.log(`Starting mu-server on port ${port}...`);
console.log(`Repository root: ${repoRoot}`);

const server = createServer({ repoRoot, port });

Bun.serve(server);

console.log(`Server running at http://localhost:${port}`);
console.log(`Health check: http://localhost:${port}/healthz`);
console.log(`API Status: http://localhost:${port}/api/status`);