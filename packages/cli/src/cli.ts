#!/usr/bin/env node

import { run } from "./index.js";

const result = await run(process.argv.slice(2), { io: { stdout: process.stdout, stderr: process.stderr } });

if (result.stdout.length > 0) {
	process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
	process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
