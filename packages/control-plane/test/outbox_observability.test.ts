import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneOutbox, type OutboundEnvelope } from "@femtomc/mu-control-plane";

function mkEnvelope(nowMs: number): OutboundEnvelope {
	return {
		v: 1,
		ts_ms: nowMs,
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_conversation_id: "conversation-1",
		request_id: "request-1",
		response_id: `response-${nowMs}`,
		kind: "lifecycle",
		body: "hello",
		correlation: {
			command_id: "cmd-1",
			idempotency_key: "idem-1",
			request_id: "request-1",
			channel: "slack",
			channel_tenant_id: "tenant-1",
			channel_conversation_id: "conversation-1",
			actor_id: "actor-1",
			actor_binding_id: "binding-1",
			assurance_tier: "tier_a",
			repo_root: "/repo",
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: "conversation-1",
			attempt: 1,
			state: "queued",
			error_code: null,
			operator_session_id: null,
			operator_turn_id: null,
			cli_invocation_id: null,
			cli_command_kind: null,
		},
		metadata: {},
	};
}

describe("ControlPlaneOutbox observability signals", () => {
	test("emits duplicate + dead-letter drop signals without changing enqueue semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-outbox-observability-"));
		let nowMs = 20_000;
		const duplicateSignals: Array<Record<string, unknown>> = [];
		const dropSignals: Array<Record<string, unknown>> = [];
		const outbox = new ControlPlaneOutbox(join(root, "outbox.jsonl"), {
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

		const first = await outbox.enqueue({
			dedupeKey: "outbox:dedupe:key",
			envelope: mkEnvelope(nowMs),
			nowMs,
			maxAttempts: 1,
		});
		expect(first.kind).toBe("enqueued");

		nowMs += 1;
		const duplicate = await outbox.enqueue({
			dedupeKey: "outbox:dedupe:key",
			envelope: mkEnvelope(nowMs),
			nowMs,
			maxAttempts: 1,
		});
		expect(duplicate.kind).toBe("duplicate");
		expect(duplicate.record.outbox_id).toBe(first.record.outbox_id);
		expect(duplicateSignals).toHaveLength(1);
		expect(duplicateSignals[0]?.source).toBe("outbox");
		expect(duplicateSignals[0]?.signal).toBe("dedupe_hit");

		nowMs += 1;
		const failed = await outbox.markFailure(first.record.outbox_id, {
			error: "delivery_failed",
			nowMs,
		});
		expect(failed?.state).toBe("dead_letter");
		expect(dropSignals).toHaveLength(1);
		expect(dropSignals[0]?.source).toBe("outbox");
		expect(dropSignals[0]?.signal).toBe("dead_letter");
		expect(dropSignals[0]?.record_id).toBe(first.record.outbox_id);
	});
});
