#!/usr/bin/env bun

// Suppress pi-coding-agent's update banner — mu handles its own versioning.
process.env.PI_SKIP_VERSION_CHECK = "1";

import { run } from "./index.js";

const result = await run(process.argv.slice(2), { io: { stdout: process.stdout, stderr: process.stderr } });

if (result.stdout.length > 0) {
	process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
	process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
