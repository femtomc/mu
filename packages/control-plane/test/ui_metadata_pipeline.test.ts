import { UI_CONTRACT_VERSION, stableSerializeJson, type UiDoc } from "@femtomc/mu-core";
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

function mkUiDoc(overrides: Partial<UiDoc> = {}): UiDoc {
	return {
		v: UI_CONTRACT_VERSION,
		ui_id: "ui:panel",
		title: "Panel",
		components: [
			{
				kind: "text",
				id: "panel-text",
				text: "Panel text",
				metadata: {},
			},
		],
		actions: [],
		revision: { id: "rev:1", version: 1 },
		updated_at_ms: 100,
		metadata: {},
		...overrides,
	};
}

describe("ui docs propagation through pipeline and outbox metadata", () => {
	test("stores bounded deterministic ui metadata on operator outbox records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-ui-outbox-"));
		const outbox = new ControlPlaneOutbox(join(dir, "outbox.jsonl"));
		const inbound = mkInbound("req-ui");
		const uiDocs = [
			mkUiDoc({ ui_id: "ui-09", revision: { id: "rev-9", version: 9 }, updated_at_ms: 9 }),
			mkUiDoc({ ui_id: "ui-01", revision: { id: "rev-1", version: 1 }, updated_at_ms: 1 }),
			mkUiDoc({ ui_id: "ui-05", revision: { id: "rev-5", version: 5 }, title: "old-5", updated_at_ms: 5 }),
			mkUiDoc({ ui_id: "ui-05", revision: { id: "rev-50", version: 50 }, title: "new-5", updated_at_ms: 50 }),
			...Array.from({ length: 20 }, (_, idx) =>
				mkUiDoc({
					ui_id: `ui-${String(idx + 10).padStart(2, "0")}`,
					revision: { id: `rev-${idx + 10}`, version: idx + 10 },
					updated_at_ms: idx + 10,
					title: `ui-${String(idx + 10).padStart(2, "0")}`,
				}),
			),
		];

		try {
			const result = await runPipelineForInbound({
				pipeline: {
					handleAdapterIngress: async () => ({
						kind: "operator_response",
						message: "ok",
						ui_docs: uiDocs,
					}),
				} as any,
				outbox,
				inbound,
				nowMs: 99,
			});

			expect(result.outboxRecord).not.toBeNull();
			const metadata = result.outboxRecord?.envelope.metadata ?? {};
			const uiDocsNormalized = Array.isArray(metadata.ui_docs) ? (metadata.ui_docs as UiDoc[]) : [];
			expect(metadata.ui_contract_version).toBe(UI_CONTRACT_VERSION);
			expect(metadata.ui_docs_count).toBe(16);
			expect(uiDocsNormalized).toHaveLength(16);
			expect(uiDocsNormalized.map((doc) => doc.ui_id)).toEqual([
				"ui-01",
				"ui-05",
				"ui-09",
				"ui-10",
				"ui-11",
				"ui-12",
				"ui-13",
				"ui-14",
				"ui-15",
				"ui-16",
				"ui-17",
				"ui-18",
				"ui-19",
				"ui-20",
				"ui-21",
				"ui-22",
			]);
			expect(uiDocsNormalized.find((doc) => doc.ui_id === "ui-05")?.title).toBe("new-5");
			expect(metadata.ui_docs_json).toBe(stableSerializeJson(uiDocsNormalized));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("ui metadata does not change outbox dedupe semantics", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-ui-dedupe-"));
		const outbox = new ControlPlaneOutbox(join(dir, "outbox.jsonl"));
		const inbound = mkInbound("req-same");

		try {
			const first = await runPipelineForInbound({
				pipeline: {
					handleAdapterIngress: async () => ({
						kind: "operator_response",
						message: "ok",
						ui_docs: [
							mkUiDoc({
								ui_id: "ui:planning",
								revision: { id: "rev:planning", version: 1 },
								updated_at_ms: 1,
							}),
						],
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
						ui_docs: [
							mkUiDoc({
								ui_id: "ui:subagents",
								revision: { id: "rev:subagents", version: 2 },
								updated_at_ms: 2,
							}),
						],
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
