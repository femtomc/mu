import { expect, test } from "bun:test";
import { ForumMessageSchema, IssueSchema, readJsonl, writeJsonl } from "@mu/core";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

test("can read python-compatible issues.jsonl and forum.jsonl without schema errors", async () => {
	const dir = await mkTempDir();
	const storeDir = join(dir, ".inshallah");
	await mkdir(storeDir, { recursive: true });

	const issuesPath = join(storeDir, "issues.jsonl");
	const forumPath = join(storeDir, "forum.jsonl");

	await writeJsonl(issuesPath, [
		{
			id: "inshallah-abc123",
			title: "root",
			body: "",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root"],
			deps: [],
			execution_spec: null,
			priority: 3,
			created_at: 123,
			updated_at: 123,
		},
		{
			id: "inshallah-def456",
			title: "child",
			body: "do thing",
			status: "open",
			outcome: null,
			tags: ["node:agent"],
			deps: [
				{ type: "parent", target: "inshallah-abc123" },
				{ type: "relates", target: "workshop-some-other" },
			],
			execution_spec: { role: "worker" },
			priority: 2,
			created_at: 124,
			updated_at: 124,
			extra_field_ok: true,
		},
	]);

	await writeJsonl(forumPath, [
		{ topic: "issue:inshallah-def456", body: "hello", author: "worker", created_at: 200, extra: "ok" },
	]);

	for (const row of await readJsonl(issuesPath)) {
		expect(() => IssueSchema.parse(row)).not.toThrow();
	}
	for (const row of await readJsonl(forumPath)) {
		expect(() => ForumMessageSchema.parse(row)).not.toThrow();
	}
});
