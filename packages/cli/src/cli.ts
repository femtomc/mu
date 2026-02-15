#!/usr/bin/env bun

import { run } from "./index";

const result = await run(process.argv.slice(2));

if (result.stdout.length > 0) {
	process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
	process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
