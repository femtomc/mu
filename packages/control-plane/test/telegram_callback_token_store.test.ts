import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { TelegramCallbackTokenStore } from "@femtomc/mu-control-plane";

describe("TelegramCallbackTokenStore", () => {
	test("issues bounded callback_data and consumes exactly once", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-telegram-callback-store-"));
		const store = new TelegramCallbackTokenStore(join(root, "telegram_callback_tokens.jsonl"));

		const record = await store.issue({
			action: { kind: "command", command_text: "/mu status" },
			ttlMs: 30_000,
			nowMs: 1_000,
		});
		expect(record.callback_data.length).toBeLessThanOrEqual(64);
		expect(record.callback_data.startsWith("mu-ui:")).toBe(true);

		const first = await store.decodeAndConsume({ callbackData: record.callback_data, nowMs: 2_000 });
		expect(first.kind).toBe("ok");
		if (first.kind !== "ok") {
			throw new Error(`expected ok, got ${first.kind}`);
		}
		expect(first.record.action.command_text).toBe("/mu status");

		const second = await store.decodeAndConsume({ callbackData: record.callback_data, nowMs: 3_000 });
		expect(second.kind).toBe("consumed");
	});

	test("invalid and expired callbacks are rejected", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-telegram-callback-store-invalid-"));
		const store = new TelegramCallbackTokenStore(join(root, "telegram_callback_tokens.jsonl"));

		const invalid = await store.decodeAndConsume({ callbackData: "garbage", nowMs: 10 });
		expect(invalid.kind).toBe("invalid");

		const record = await store.issue({
			action: { kind: "command", command_text: "/mu help" },
			ttlMs: 100,
			nowMs: 100,
		});
		const expired = await store.decodeAndConsume({ callbackData: record.callback_data, nowMs: 250 });
		expect(expired.kind).toBe("expired");
	});
});
