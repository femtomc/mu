import { HUD_CONTRACT_VERSION, stableSerializeJson, type HudDoc } from "@femtomc/mu-core";
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

function mkHudDoc(id: string, updatedAt: number, title = id): HudDoc {
	return {
		v: HUD_CONTRACT_VERSION,
		hud_id: id,
		title,
		scope: null,
		chips: [],
		sections: [],
		actions: [],
		snapshot_compact: `${title} compact`,
		updated_at_ms: updatedAt,
		metadata: {},
	};
}

describe("hud docs propagation through pipeline and outbox metadata", () => {
	test("stores bounded deterministic hud metadata on operator outbox records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-hud-outbox-"));
		const outbox = new ControlPlaneOutbox(join(dir, "outbox.jsonl"));
		const inbound = mkInbound("req-hud");
		const docs = [
			mkHudDoc("hud-09", 9),
			mkHudDoc("hud-01", 1),
			mkHudDoc("hud-05", 5, "old-5"),
			mkHudDoc("hud-05", 50, "new-5"),
			...Array.from({ length: 20 }, (_, idx) => mkHudDoc(`hud-${String(idx + 10).padStart(2, "0")}`, idx + 10)),
		];

		try {
			const result = await runPipelineForInbound({
				pipeline: {
					handleAdapterIngress: async () => ({
						kind: "operator_response",
						message: "ok",
						hud_docs: docs,
					}),
				} as any,
				outbox,
				inbound,
				nowMs: 99,
			});

			expect(result.outboxRecord).not.toBeNull();
			const metadata = result.outboxRecord?.envelope.metadata ?? {};
			expect(metadata.hud_contract_version).toBe(HUD_CONTRACT_VERSION);
			expect(metadata.hud_docs_count).toBe(16);
			const hudDocs = Array.isArray(metadata.hud_docs) ? (metadata.hud_docs as HudDoc[]) : [];
			expect(hudDocs).toHaveLength(16);
			expect(hudDocs.map((doc) => doc.hud_id)).toEqual([
				"hud-01",
				"hud-05",
				"hud-09",
				"hud-10",
				"hud-11",
				"hud-12",
				"hud-13",
				"hud-14",
				"hud-15",
				"hud-16",
				"hud-17",
				"hud-18",
				"hud-19",
				"hud-20",
				"hud-21",
				"hud-22",
			]);
			expect(hudDocs.find((doc) => doc.hud_id === "hud-05")?.title).toBe("new-5");
			expect(metadata.hud_docs_json).toBe(stableSerializeJson(hudDocs));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("hud metadata does not change outbox dedupe semantics", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-hud-dedupe-"));
		const outbox = new ControlPlaneOutbox(join(dir, "outbox.jsonl"));
		const inbound = mkInbound("req-same");

		try {
			const first = await runPipelineForInbound({
				pipeline: {
					handleAdapterIngress: async () => ({
						kind: "operator_response",
						message: "ok",
						hud_docs: [mkHudDoc("planning", 1)],
					}),
				} as any,
				outbox,
				inbound,
				nowMs: 1,
			});
			const second = await runPipelineForInbound({
				pipeline: {
					handleAdapterIngress: async () => ({
						kind: "operator_response",
						message: "ok 2",
						hud_docs: [mkHudDoc("subagents", 2)],
					}),
				} as any,
				outbox,
				inbound,
				nowMs: 2,
			});

			expect(first.outboxRecord?.outbox_id).toBeTruthy();
			expect(second.outboxRecord?.outbox_id).toBe(first.outboxRecord?.outbox_id);
			expect(outbox.records()).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
