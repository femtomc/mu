import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonlStore } from "@femtomc/mu-core";
import { FsJsonlStore, fsEventLog, readJsonl, writeJsonl } from "@femtomc/mu-core/node";
import { ForumStore, ForumStoreValidationError } from "@femtomc/mu-forum";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-forum-"));
}

describe("ForumStore", () => {
	test("post persists canonical row and emits forum.post", async () => {
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

	test("read rejects non-positive/invalid limits", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });
		await store.post("t1", "a1");

		await expect(store.read("t1", 0)).rejects.toBeInstanceOf(ForumStoreValidationError);
		await expect(store.read("t1", Number.NaN)).rejects.toBeInstanceOf(ForumStoreValidationError);
	});

	test("read uses streaming path for bounded topic queries when store supports stream()", async () => {
		const rows: unknown[] = [];
		const backing: JsonlStore<unknown> = {
			read: async () => {
				throw new Error("read() should not be used for bounded streaming query");
			},
			write: async (next) => {
				rows.length = 0;
				rows.push(...next);
			},
			append: async (row) => {
				rows.push(row);
			},
			async *stream() {
				for (const row of rows) {
					yield row;
				}
			},
		};
		const store = new ForumStore(backing);

		await store.post("t1", "a1");
		await store.post("t2", "b1");
		await store.post("t1", "a2");
		await store.post("t1", "a3");

		const msgs = await store.read("t1", 2);
		expect(msgs.map((message) => message.body)).toEqual(["a2", "a3"]);
	});

	test("post/read normalize topic boundaries and clamp high limits", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });

		for (let i = 0; i < 210; i++) {
			await store.post("  t-normalized  ", `m${i}`);
		}

		const msgs = await store.read("t-normalized", 9999);
		expect(msgs).toHaveLength(200);
		expect(msgs[0]?.body).toBe("m10");
		expect(msgs[msgs.length - 1]?.body).toBe("m209");
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

	test("topics supports limit clamping", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });

		for (let i = 0; i < 210; i += 1) {
			await store.post(`topic:${i}`, `m${i}`);
		}

		const top = await store.topics(null, { limit: 5 });
		expect(top).toHaveLength(5);

		// limit is clamped to MAX_FORUM_TOPICS_LIMIT (200)
		const clamped = await store.topics(null, { limit: 9999 });
		expect(clamped).toHaveLength(200);
	});

	test("topics rejects invalid limits", async () => {
		const dir = await mkTempDir();
		const forumPath = join(dir, ".mu", "forum.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new ForumStore(new FsJsonlStore(forumPath), { events: eventLog });

		await expect(store.topics(null, { limit: 0 })).rejects.toBeInstanceOf(ForumStoreValidationError);
	});
});
