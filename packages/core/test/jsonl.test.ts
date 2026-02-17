import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readJsonl, streamJsonl, writeJsonl } from "@femtomc/mu-core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

test("readJsonl on missing file returns []", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "missing.jsonl");
	expect(await readJsonl(path)).toEqual([]);
});

test("streamJsonl tolerates blank lines and trailing newlines", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "a.jsonl");

	await writeFile(path, `{"a":1}\n\n{"b":2}\n\n`, "utf8");

	const rows: unknown[] = [];
	for await (const row of streamJsonl(path)) {
		rows.push(row);
	}
	expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
});

test("writeJsonl writes and readJsonl reads back", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "rows.jsonl");

	await writeJsonl(path, [{ x: 1 }, { y: 2 }]);
	expect(await readJsonl(path)).toEqual([{ x: 1 }, { y: 2 }]);
});

test("appendJsonl appends", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "rows.jsonl");

	await appendJsonl(path, { x: 1 });
	await appendJsonl(path, { y: 2 });
	expect(await readJsonl(path)).toEqual([{ x: 1 }, { y: 2 }]);
});
