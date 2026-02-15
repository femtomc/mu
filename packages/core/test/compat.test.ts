import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForumMessageSchema, IssueSchema } from "@femtomc/mu-core";
import { readJsonl, writeJsonl } from "@femtomc/mu-core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

test("can read python-compatible issues.jsonl and forum.jsonl without schema errors", async () => {
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
		},
		{
			id: "mu-def456",
			title: "child",
			body: "do thing",
			status: "open",
			outcome: null,
			tags: ["node:agent", "role:worker"],
			deps: [
				{ type: "parent", target: "mu-abc123" },
				{ type: "relates", target: "workshop-some-other" },
			],
			priority: 2,
			created_at: 124,
			updated_at: 124,
			extra_field_ok: true,
		},
	]);

	await writeJsonl(forumPath, [
		{ topic: "issue:mu-def456", body: "hello", author: "worker", created_at: 200, extra: "ok" },
	]);

	for (const row of await readJsonl(issuesPath)) {
		expect(() => IssueSchema.parse(row)).not.toThrow();
	}
	for (const row of await readJsonl(forumPath)) {
		expect(() => ForumMessageSchema.parse(row)).not.toThrow();
	}
});
