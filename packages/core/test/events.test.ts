import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsEventLog, newRunId, readJsonl, runContext } from "@mu/core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

describe("EventLog", () => {
	test("emit appends a versioned envelope to events.jsonl", async () => {
		const dir = await mkTempDir();
		const path = join(dir, ".inshallah", "events.jsonl");
		const log = fsEventLog(path);

		await log.emit("unit.test", { source: "test", payload: { a: 1 } });
		await log.emit("unit.test2", { source: "test", payload: { b: 2 } });

		const rows = await readJsonl(path);
		expect(rows).toHaveLength(2);

		const e1 = rows[0] as any;
		expect(e1).toMatchObject({ v: 1, type: "unit.test", source: "test", payload: { a: 1 } });
		expect(typeof e1.ts_ms).toBe("number");
		expect("run_id" in e1).toBe(false);
		expect("issue_id" in e1).toBe(false);
	});

	test("emit respects runContext and explicit runId/issueId fields", async () => {
		const dir = await mkTempDir();
		const path = join(dir, ".inshallah", "events.jsonl");
		const log = fsEventLog(path);

		const runId = newRunId();
		await runContext({ runId }, async () => {
			await log.emit("ctx.event", { source: "test", payload: { ok: true } });
			await log.emit("explicit.event", {
				source: "test",
				runId: "explicit",
				issueId: "inshallah-abc123",
				payload: {},
			});
		});

		const rows = (await readJsonl(path)) as any[];
		expect(rows).toHaveLength(2);

		expect(rows[0]).toMatchObject({
			type: "ctx.event",
			run_id: runId,
		});
		expect(rows[1]).toMatchObject({
			type: "explicit.event",
			run_id: "explicit",
			issue_id: "inshallah-abc123",
		});
	});

	test("emit rejects non-object payloads", async () => {
		const dir = await mkTempDir();
		const path = join(dir, ".inshallah", "events.jsonl");
		const log = fsEventLog(path);

		await expect(log.emit("bad.payload", { source: "test", payload: [] as any })).rejects.toThrow(
			"payload must be an object",
		);
	});
});
