import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdempotencyLedger } from "@femtomc/mu-control-plane";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-idem-"));
}

describe("IdempotencyLedger", () => {
	test("duplicate key + same fingerprint returns existing command", async () => {
		const dir = await mkTempDir();
		const path = join(dir, ".mu", "control-plane", "idempotency.jsonl");
		const ledger = new IdempotencyLedger(path);
		await ledger.load();

		const created = await ledger.claim({
			key: "idem-key-1",
			fingerprint: "fp-a",
			commandId: "cmd-1",
			ttlMs: 1_000,
			nowMs: 10,
		});
		expect(created.kind).toBe("created");

		const duplicate = await ledger.claim({
			key: "idem-key-1",
			fingerprint: "fp-a",
			commandId: "cmd-2",
			ttlMs: 1_000,
			nowMs: 11,
		});
		expect(duplicate.kind).toBe("duplicate");
		if (duplicate.kind === "duplicate") {
			expect(duplicate.record.command_id).toBe("cmd-1");
			expect(duplicate.record.last_seen_ms).toBe(11);
		}

		const restarted = new IdempotencyLedger(path);
		await restarted.load();
		const afterRestart = await restarted.lookup("idem-key-1", { nowMs: 12 });
		expect(afterRestart?.command_id).toBe("cmd-1");
		expect(afterRestart?.last_seen_ms).toBe(11);
	});

	test("duplicate key + different fingerprint returns conflict", async () => {
		const dir = await mkTempDir();
		const path = join(dir, ".mu", "control-plane", "idempotency.jsonl");
		const ledger = new IdempotencyLedger(path);
		await ledger.load();

		await ledger.claim({
			key: "idem-key-2",
			fingerprint: "fp-a",
			commandId: "cmd-1",
			ttlMs: 1_000,
			nowMs: 10,
		});

		const conflict = await ledger.claim({
			key: "idem-key-2",
			fingerprint: "fp-b",
			commandId: "cmd-2",
			ttlMs: 1_000,
			nowMs: 20,
		});
		expect(conflict.kind).toBe("conflict");
		if (conflict.kind === "conflict") {
			expect(conflict.record.command_id).toBe("cmd-1");
			expect(conflict.incomingFingerprint).toBe("fp-b");
		}
	});

	test("ttl expiry allows re-claiming same key", async () => {
		const dir = await mkTempDir();
		const path = join(dir, ".mu", "control-plane", "idempotency.jsonl");
		const ledger = new IdempotencyLedger(path);
		await ledger.load();

		await ledger.claim({
			key: "idem-key-3",
			fingerprint: "fp-a",
			commandId: "cmd-1",
			ttlMs: 10,
			nowMs: 100,
		});

		const beforeExpiry = await ledger.lookup("idem-key-3", { nowMs: 109 });
		expect(beforeExpiry?.command_id).toBe("cmd-1");

		const afterExpiry = await ledger.lookup("idem-key-3", { nowMs: 110 });
		expect(afterExpiry).toBeNull();

		const reclaimed = await ledger.claim({
			key: "idem-key-3",
			fingerprint: "fp-b",
			commandId: "cmd-2",
			ttlMs: 10,
			nowMs: 111,
		});
		expect(reclaimed.kind).toBe("created");
		if (reclaimed.kind === "created") {
			expect(reclaimed.record.command_id).toBe("cmd-2");
			expect(reclaimed.record.fingerprint).toBe("fp-b");
		}
	});
});
