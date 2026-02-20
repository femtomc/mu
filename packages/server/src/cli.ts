#!/usr/bin/env bun

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, getStorePaths } from "@femtomc/mu-core/node";
import { composeServerRuntime, createServerFromRuntime } from "./server.js";

// Parse CLI flags: --port N, --repo-root PATH
function parseArgs(argv: string[]): { port: number; repoRoot: string | null } {
	let port = parseInt(Bun.env.PORT || "3000", 10);
	let repoRoot: string | null = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port" && i + 1 < argv.length) {
			port = parseInt(argv[++i]!, 10);
		} else if (arg.startsWith("--port=")) {
			port = parseInt(arg.slice("--port=".length), 10);
		} else if (arg === "--repo-root" && i + 1 < argv.length) {
			repoRoot = argv[++i]!;
		} else if (arg.startsWith("--repo-root=")) {
			repoRoot = arg.slice("--repo-root=".length);
		}
	}

	return { port, repoRoot };
}

const args = parseArgs(process.argv.slice(2));

let repoRoot: string;
try {
	repoRoot = args.repoRoot ?? findRepoRoot();
} catch {
	console.error("Error: Could not resolve a repository root for mu server startup.");
	process.exit(1);
}

const port = args.port;
const discoveryPath = join(getStorePaths(repoRoot).storeDir, "control-plane", "server.json");

console.log(`Starting mu-server on port ${port}...`);
console.log(`Repository root: ${repoRoot}`);

const runtime = await composeServerRuntime({ repoRoot });

const initiateShutdown = async () => {
	console.log("Shutdown initiated via API");
	try {
		rmSync(discoveryPath, { force: true });
	} catch {
		// best-effort
	}
	await runtime.controlPlane?.stop();
	server.stop();
	process.exit(0);
};

const serverConfig = createServerFromRuntime(runtime, { port, initiateShutdown });

let server: ReturnType<typeof Bun.serve>;
try {
	server = Bun.serve(serverConfig);
} catch (err) {
	try {
		await runtime.controlPlane?.stop();
	} catch {
		// Best effort cleanup. Preserve the startup error.
	}
	throw err;
}

// Write discovery file so clients can find this server
try {
	writeFileSync(
		discoveryPath,
		JSON.stringify({
			pid: process.pid,
			port,
			url: `http://localhost:${port}`,
			started_at_ms: Date.now(),
		}) + "\n",
	);
} catch (err) {
	console.error(`Warning: could not write ${discoveryPath}: ${err}`);
}

console.log(`Server running at http://localhost:${port}`);
console.log(`Capabilities: lifecycle=[${runtime.capabilities.session_lifecycle_actions.join(",")}]`);

if (runtime.controlPlane && runtime.controlPlane.activeAdapters.length > 0) {
	console.log("Control plane: active");
	for (const a of runtime.controlPlane.activeAdapters) {
		console.log(`  ${a.name.padEnd(12)} ${a.route}`);
	}
} else {
	console.log(`Health check: http://localhost:${port}/healthz`);
	console.log(`API Status: http://localhost:${port}/api/control-plane/status`);
}

const cleanup = async () => {
	try {
		rmSync(discoveryPath, { force: true });
	} catch {
		// best-effort
	}
	await runtime.controlPlane?.stop();
	server.stop();
	process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log("Press Ctrl+C to stop");
