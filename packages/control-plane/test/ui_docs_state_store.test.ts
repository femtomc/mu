import { UI_CONTRACT_VERSION, type UiDoc } from "@femtomc/mu-core";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEnvelope } from "../src/models.js";
import {
	UiDocsStateStore,
	uiDocsStateScopeForInbound,
	uiDocsStateWriterForInbound,
} from "../src/ui_docs_state_store.js";

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

function mkInbound(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 1,
		request_id: "req-1",
		delivery_id: "delivery-1",
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
		idempotency_key: "idem-1",
		fingerprint: "fp-1",
		metadata: {},
		...overrides,
	};
}

describe("UiDocsStateStore", () => {
	test("upsert increments revision only when docs change", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-ui-docs-state-"));
		const path = join(dir, "ui_docs_state.jsonl");
		const store = new UiDocsStateStore(path);

		try {
			const scope = { kind: "session", id: "heartbeat-program:hb-1" } as const;
			const writer = {
				source: "autonomous_ingress",
				session_id: "heartbeat-program:hb-1",
				request_id: "req-1",
			};
			const first = await store.upsert({
				scope,
				docs: [mkUiDoc({ ui_id: "ui:planning" })],
				writer,
				nowMs: 10,
			});
			expect(first.kind).toBe("updated");
			expect(first.record.rev).toBe(1);

			const unchanged = await store.upsert({
				scope,
				docs: [mkUiDoc({ ui_id: "ui:planning" })],
				writer: { ...writer, request_id: "req-2" },
				nowMs: 11,
			});
			expect(unchanged.kind).toBe("unchanged");
			expect(unchanged.record.rev).toBe(1);

			const updated = await store.upsert({
				scope,
				docs: [mkUiDoc({ ui_id: "ui:planning", revision: { id: "rev:2", version: 2 }, updated_at_ms: 200 })],
				writer,
				nowMs: 12,
			});
			expect(updated.kind).toBe("updated");
			expect(updated.record.rev).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("load reconstructs latest per-scope state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mu-ui-docs-state-"));
		const path = join(dir, "ui_docs_state.jsonl");
		const store = new UiDocsStateStore(path);

		try {
			await store.upsert({
				scope: { kind: "session", id: "session-a" },
				docs: [mkUiDoc({ ui_id: "ui:a", revision: { id: "rev:a1", version: 1 } })],
				writer: { source: "autonomous_ingress", session_id: "session-a" },
				nowMs: 10,
			});
			await store.upsert({
				scope: { kind: "session", id: "session-a" },
				docs: [mkUiDoc({ ui_id: "ui:a", revision: { id: "rev:a2", version: 2 } })],
				writer: { source: "autonomous_ingress", session_id: "session-a" },
				nowMs: 20,
			});
			await store.upsert({
				scope: { kind: "conversation", id: "slack:team:chan:binding" },
				docs: [mkUiDoc({ ui_id: "ui:b", revision: { id: "rev:b1", version: 1 } })],
				writer: { source: "adapter_ingress", channel: "slack", actor_binding_id: "binding" },
				nowMs: 30,
			});

			const reloaded = new UiDocsStateStore(path);
			await reloaded.load();
			const snapshot = reloaded.snapshot({ limit: 10 });
			expect(snapshot).toHaveLength(2);
			expect(reloaded.get({ kind: "session", id: "session-a" })?.rev).toBe(2);
			expect(reloaded.get({ kind: "conversation", id: "slack:team:chan:binding" })?.docs[0]?.ui_id).toBe("ui:b");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("scope and writer helpers prefer autonomous session scope when present", () => {
		const autonomousInbound = mkInbound({
			channel: "terminal",
			channel_tenant_id: "local",
			channel_conversation_id: "local",
			actor_binding_id: "terminal-local-binding",
			metadata: {
				source: "autonomous_ingress",
				operator_session_id: "heartbeat-program:hb-123",
				wake_id: "wake-1",
				program_id: "hb-123",
			},
		});
		const scope = uiDocsStateScopeForInbound(autonomousInbound);
		expect(scope).toEqual({ kind: "session", id: "heartbeat-program:hb-123" });
		const writer = uiDocsStateWriterForInbound(autonomousInbound);
		expect(writer.source).toBe("autonomous_ingress");
		expect(writer.session_id).toBe("heartbeat-program:hb-123");
		expect(writer.wake_id).toBe("wake-1");
		expect(writer.program_id).toBe("hb-123");

		const conversationalInbound = mkInbound();
		const conversationalScope = uiDocsStateScopeForInbound(conversationalInbound);
		expect(conversationalScope.kind).toBe("conversation");
		expect(conversationalScope.id).toBe("slack:team-1:chan-1:binding-1");
		const conversationalWriter = uiDocsStateWriterForInbound(conversationalInbound);
		expect(conversationalWriter.source).toBe("adapter_ingress");
	});
});
