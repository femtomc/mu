import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForumMessageSchema, IssueSchema } from "@femtomc/mu-core";
import { readJsonl, writeJsonl } from "@femtomc/mu-core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

test("issue/forum schemas reject unknown fields", async () => {
	const dir = await mkTempDir();
	const storeDir = join(dir, ".mu");
	await mkdir(storeDir, { recursive: true });

	const issuesPath = join(storeDir, "issues.jsonl");
	const forumPath = join(storeDir, "forum.jsonl");

	await writeJsonl(issuesPath, [
		{
			id: "mu-abc123",
			title: "root",
			body: "",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root"],
			deps: [],
			priority: 3,
			created_at: 123,
			updated_at: 123,
			extra_field_ok: true,
		},
	]);

	await writeJsonl(forumPath, [
		{ topic: "issue:mu-abc123", body: "hello", author: "worker", created_at: 200, extra: "nope" },
	]);

	for (const row of await readJsonl(issuesPath)) {
		expect(() => IssueSchema.parse(row)).toThrow();
	}
	for (const row of await readJsonl(forumPath)) {
		expect(() => ForumMessageSchema.parse(row)).toThrow();
	}
});
