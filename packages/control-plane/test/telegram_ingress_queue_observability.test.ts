import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEnvelope } from "@femtomc/mu-control-plane";
import { TelegramIngressQueue } from "../src/telegram_ingress_queue.js";

function mkInbound(nowMs: number): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: nowMs,
		request_id: "telegram-request-1",
		delivery_id: "telegram-delivery-1",
		channel: "telegram",
		channel_tenant_id: "telegram-bot",
		channel_conversation_id: "chat-1",
		actor_id: "actor-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: "/repo",
		command_text: "/mu status",
		scope_required: "cp.read",
		scope_effective: "cp.read",
		target_type: "status",
		target_id: "chat-1",
		idempotency_key: "telegram-idem-1",
		fingerprint: "telegram-fp-1",
		metadata: {},
	};
}

describe("TelegramIngressQueue observability signals", () => {
	test("emits duplicate + dead-letter drop signals while preserving queue semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-telegram-ingress-observability-"));
		let nowMs = 40_000;
		const duplicateSignals: Array<Record<string, unknown>> = [];
		const dropSignals: Array<Record<string, unknown>> = [];

		const queue = new TelegramIngressQueue(join(root, "telegram_ingress.jsonl"), {
			nowMs: () => nowMs,
			signalObserver: {
				onDuplicateSignal: (signal) => {
					duplicateSignals.push(signal as Record<string, unknown>);
				},
				onDropSignal: (signal) => {
					dropSignals.push(signal as Record<string, unknown>);
				},
			},
		});

		const first = await queue.enqueue({
			dedupeKey: "telegram:ingress:dedupe:key",
			inbound: mkInbound(nowMs),
			nowMs,
			maxAttempts: 1,
		});
		expect(first.kind).toBe("enqueued");

		nowMs += 1;
		const duplicate = await queue.enqueue({
			dedupeKey: "telegram:ingress:dedupe:key",
			inbound: mkInbound(nowMs),
			nowMs,
			maxAttempts: 1,
		});
		expect(duplicate.kind).toBe("duplicate");
		expect(duplicate.record.ingress_id).toBe(first.record.ingress_id);
		expect(duplicateSignals).toHaveLength(1);
		expect(duplicateSignals[0]?.source).toBe("telegram_ingress");
		expect(duplicateSignals[0]?.signal).toBe("dedupe_hit");

		nowMs += 1;
		const failed = await queue.markFailure(first.record.ingress_id, {
			error: "ingress_failed",
			nowMs,
		});
		expect(failed?.state).toBe("dead_letter");
		expect(dropSignals).toHaveLength(1);
		expect(dropSignals[0]?.source).toBe("telegram_ingress");
		expect(dropSignals[0]?.signal).toBe("dead_letter");
		expect(dropSignals[0]?.record_id).toBe(first.record.ingress_id);
	});
});
