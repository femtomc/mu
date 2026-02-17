import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function pathFromHere(rel: string): string {
	return fileURLToPath(new URL(rel, import.meta.url));
}

test("browser bundle smoke check (node-free entrypoints)", async () => {
	const outdir = await mkdtemp(join(tmpdir(), "mu-browser-bundle-"));
	try {
		const result = await Bun.build({
			entrypoints: [
				pathFromHere("../src/index.ts"),
				pathFromHere("../src/browser/index.ts"),
				pathFromHere("../../issue/src/index.ts"),
				pathFromHere("../../forum/src/index.ts"),
			],
			outdir,
			target: "browser",
			minify: false,
			splitting: false,
			sourcemap: "none",
		});
		expect(result.success).toBe(true);
	} finally {
		await rm(outdir, { recursive: true, force: true });
	}
});
