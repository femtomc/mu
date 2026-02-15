import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJsonlStore, fsEventLog, readJsonl, writeJsonl } from "@mu/core/node";
import { ForumStore } from "@mu/forum";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-forum-"));
}

describe("ForumStore", () => {
	test("post persists python-compatible row and emits forum.post", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");

		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });
		const msg = await store.post("issue:mu-abc123", "hello", "worker");

		expect(msg).toMatchObject({
			topic: "issue:mu-abc123",
			body: "hello",
			author: "worker",
		});
		expect(Number.isInteger(msg.created_at)).toBe(true);
		// Seconds since Unix epoch (not ms).
		expect(msg.created_at).toBeLessThan(10_000_000_000);

		const rows = (await readJsonl(forumPath)) as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			topic: "issue:mu-abc123",
			body: "hello",
			author: "worker",
			created_at: msg.created_at,
		});

		const events = (await readJsonl(join(dir, ".mu", "events.jsonl"))) as any[];
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			v: 1,
			type: "forum.post",
			source: "forum_store",
			issue_id: "mu-abc123",
			payload: { message: { topic: "issue:mu-abc123", body: "hello" } },
		});
	});

	test("read returns the last N messages for a topic in chronological order", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });

		await store.post("t1", "a1");
		await store.post("t1", "a2");
		await store.post("t2", "b1");
		await store.post("t1", "a3");

		const msgs = await store.read("t1", 2);
		expect(msgs.map((m) => m.body)).toEqual(["a2", "a3"]);
	});

	test("topics summarizes and sorts by most-recent activity and supports prefix filtering", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });

		await writeJsonl(forumPath, [
			{ topic: "alpha", body: "a1", author: "system", created_at: 1 },
			{ topic: "alpha", body: "a2", author: "system", created_at: 2 },
			{ topic: "beta", body: "b1", author: "system", created_at: 3 },
			{ topic: "issue:mu-xyz999", body: "i1", author: "worker", created_at: 4 },
		]);

		const all = await store.topics();
		expect(all.map((t) => t.topic)).toEqual(["issue:mu-xyz999", "beta", "alpha"]);
		expect(all.find((t) => t.topic === "alpha")).toMatchObject({ messages: 2, last_at: 2 });

		const issues = await store.topics("issue:");
		expect(issues.map((t) => t.topic)).toEqual(["issue:mu-xyz999"]);
		expect(issues[0]).toMatchObject({ messages: 1, last_at: 4 });
	});

	test("schema compatibility: preserves extra keys from legacy rows when posting", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });

		await writeJsonl(forumPath, [
			{
				topic: "issue:mu-keep",
				body: "hello",
				author: "system",
				created_at: 1,
				id: "01KG2V0EG706SB2B86GXEXQ7M1",
				source: "synth-forum",
				created_at_ms: 1000,
				git: { oid: "deadbeef", dirty: true },
			},
		]);

		await store.post("issue:mu-keep", "next", "worker");

		const rows = (await readJsonl(forumPath)) as any[];
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			topic: "issue:mu-keep",
			id: "01KG2V0EG706SB2B86GXEXQ7M1",
			source: "synth-forum",
			created_at_ms: 1000,
			git: { oid: "deadbeef", dirty: true },
		});
	});
});
