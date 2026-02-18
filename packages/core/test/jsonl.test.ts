import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendJsonl,
	JsonlParseError,
	JsonlQueryValidationError,
	readJsonl,
	streamJsonl,
	writeJsonl,
} from "@femtomc/mu-core/node";

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

test("readJsonl reports file + line context for invalid JSON rows", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "broken.jsonl");
	await writeFile(path, `{"a":1}\n{broken}\n`, "utf8");

	try {
		await readJsonl(path);
		expect.unreachable("expected JsonlParseError");
	} catch (error) {
		expect(error).toBeInstanceOf(JsonlParseError);
		const parseError = error as JsonlParseError;
		expect(parseError.filePath).toBe(path);
		expect(parseError.lineNumber).toBe(2);
		expect(parseError.message).toContain(`${path}:2`);
	}
});

test("writeJsonl writes and readJsonl reads back", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "rows.jsonl");

	await writeJsonl(path, [{ x: 1 }, { y: 2 }]);
	expect(await readJsonl(path)).toEqual([{ x: 1 }, { y: 2 }]);
});

test("readJsonl supports bounded tail reads", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "rows.jsonl");

	await writeJsonl(path, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
	expect(await readJsonl(path, { limit: 2 })).toEqual([{ n: 3 }, { n: 4 }]);
	expect(await readJsonl(path, { limit: 10 })).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
});

test("readJsonl rejects invalid limits", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "rows.jsonl");
	await writeJsonl(path, [{ n: 1 }]);

	await expect(readJsonl(path, { limit: 0 })).rejects.toBeInstanceOf(JsonlQueryValidationError);
	await expect(readJsonl(path, { limit: Number.NaN })).rejects.toBeInstanceOf(JsonlQueryValidationError);
	await expect(readJsonl(path, { limit: 1.5 })).rejects.toBeInstanceOf(JsonlQueryValidationError);
});

test("appendJsonl appends", async () => {
	const dir = await mkTempDir();
	const path = join(dir, "rows.jsonl");

	await appendJsonl(path, { x: 1 });
	await appendJsonl(path, { y: 2 });
	expect(await readJsonl(path)).toEqual([{ x: 1 }, { y: 2 }]);
});
