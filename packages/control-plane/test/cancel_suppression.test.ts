import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEnvelope } from "../src/models.js";
import { ControlPlaneOutbox } from "../src/outbox.js";
import { runPipelineForInbound } from "../src/adapters/shared.js";

function mkInbound(requestId: string): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 1,
		request_id: requestId,
		delivery_id: `delivery-${requestId}`,
		channel: "slack",
		channel_tenant_id: "team-1",
		channel_conversation_id: "chan-1",
		actor_id: "user-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: "/repo",
		command_text: "status",
		scope_required: "cp.read",
		scope_effective: "cp.read",
		target_type: "operator_chat",
		target_id: "chan-1",
		idempotency_key: `idem-${requestId}`,
		fingerprint: `fp-${requestId}`,
		metadata: {},
	};
}

describe("forced outbox fallback suppression for explicit operator cancellation", () => {
	test("runPipelineForInbound skips forced fallback for noop/operator_cancelled", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-cancel-suppress-"));
		const outboxPath = join(dir, "outbox.jsonl");
		const outbox = new ControlPlaneOutbox(outboxPath);

		try {
			const result = await runPipelineForInbound({
				pipeline: {
					handleAdapterIngress: async () => ({ kind: "noop", reason: "operator_cancelled" }),
				} as any,
				outbox,
				inbound: mkInbound("req-cancelled"),
				nowMs: 10,
				forceOutbox: true,
			});

			expect(result.pipelineResult).toEqual({ kind: "noop", reason: "operator_cancelled" });
			expect(result.outboxRecord).toBeNull();
			expect(outbox.records()).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("other noop reasons still produce forced fallback outbox records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-cancel-suppress-"));
		const outboxPath = join(dir, "outbox.jsonl");
		const outbox = new ControlPlaneOutbox(outboxPath);

		try {
			const result = await runPipelineForInbound({
				pipeline: {
					handleAdapterIngress: async () => ({ kind: "noop", reason: "duplicate_delivery" }),
				} as any,
				outbox,
				inbound: mkInbound("req-duplicate"),
				nowMs: 10,
				forceOutbox: true,
			});

			expect(result.pipelineResult).toEqual({ kind: "noop", reason: "duplicate_delivery" });
			expect(result.outboxRecord).not.toBeNull();
			expect(outbox.records()).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
