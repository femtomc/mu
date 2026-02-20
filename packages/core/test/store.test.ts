import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findRepoRoot, getMuHomeDir, getStorePaths, workspaceIdForRepoRoot } from "@femtomc/mu-core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

test("findRepoRoot finds nearest ancestor with .git", async () => {
	const repoRoot = await mkTempDir();
	await mkdir(join(repoRoot, ".git"), { recursive: true });

	const nested = join(repoRoot, "a", "b", "c");
	await mkdir(nested, { recursive: true });

	expect(findRepoRoot(nested)).toBe(repoRoot);
});

test("findRepoRoot falls back to start dir if no repository root exists", async () => {
	const dir = await mkTempDir();
	expect(findRepoRoot(dir)).toBe(dir);
});

test("getStorePaths points at workspace-scoped global store files", async () => {
	const repoRoot = await mkTempDir();
	const p = getStorePaths(repoRoot);
	const resolvedRoot = resolve(repoRoot);
	expect(p.repoRoot).toBe(resolvedRoot);
	expect(p.muHomeDir).toBe(getMuHomeDir());
	expect(p.workspaceId).toBe(workspaceIdForRepoRoot(repoRoot));
	expect(p.storeDir).toBe(join(getMuHomeDir(), "workspaces", workspaceIdForRepoRoot(repoRoot)));
	expect(p.issuesPath.endsWith("issues.jsonl")).toBe(true);
	expect(p.forumPath.endsWith("forum.jsonl")).toBe(true);
});

test("getStorePaths honors MU_HOME override", async () => {
	const repoRoot = await mkTempDir();
	const previous = process.env.MU_HOME;
	process.env.MU_HOME = join(repoRoot, ".custom-mu");
	try {
		const paths = getStorePaths(repoRoot);
		expect(paths.muHomeDir).toBe(resolve(join(repoRoot, ".custom-mu")));
		expect(paths.storeDir.startsWith(resolve(join(repoRoot, ".custom-mu")))).toBe(true);
	} finally {
		if (previous == null) {
			delete process.env.MU_HOME;
		} else {
			process.env.MU_HOME = previous;
		}
	}
});
