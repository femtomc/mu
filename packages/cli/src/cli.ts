#!/usr/bin/env bun

import { run } from "./index";

const out = run(process.argv.slice(2));
if (out.length > 0) {
	console.log(out);
}
