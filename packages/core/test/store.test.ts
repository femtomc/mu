import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, getStorePaths } from "@mu/core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

test("findRepoRoot finds nearest ancestor with .inshallah/", async () => {
	const repoRoot = await mkTempDir();
	await mkdir(join(repoRoot, ".inshallah"), { recursive: true });

	const nested = join(repoRoot, "a", "b", "c");
	await mkdir(nested, { recursive: true });

	expect(findRepoRoot(nested)).toBe(repoRoot);
});

test("findRepoRoot falls back to start dir if no store exists", async () => {
	const dir = await mkTempDir();
	expect(findRepoRoot(dir)).toBe(dir);
});

test("getStorePaths points at standard files", async () => {
	const repoRoot = await mkTempDir();
	const p = getStorePaths(repoRoot);
	expect(p.repoRoot).toBe(repoRoot);
	expect(p.storeDir).toBe(join(repoRoot, ".inshallah"));
	expect(p.issuesPath.endsWith("issues.jsonl")).toBe(true);
	expect(p.forumPath.endsWith("forum.jsonl")).toBe(true);
});
