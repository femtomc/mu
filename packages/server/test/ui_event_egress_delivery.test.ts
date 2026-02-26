import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiDoc } from "@femtomc/mu-core";
import { readJsonl } from "@femtomc/mu-core/node";
import {
	OutboxRecordSchema,
	UiCallbackTokenJournalEntrySchema,
	UiCallbackTokenStore,
} from "@femtomc/mu-control-plane";
import { deliverSlackOutboxRecord, deliverTelegramOutboxRecord } from "../src/control_plane.js";

function makeUiDoc(): UiDoc {
	return {
		v: 1,
		ui_id: "ui:answer",
		title: "Answer",
		components: [
			{
				kind: "text",
				id: "intro",
				text: "Answer this prompt?",
				metadata: {},
			},
		],
		actions: [
			{
				id: "answer_yes",
				label: "Answer yes",
				payload: { decision: "yes" },
				metadata: {
					command_text: "/answer yes",
					command_callback: "/unsafe answer yes",
				},
			},
		],
		revision: { id: "rev-1", version: 1 },
		updated_at_ms: 1,
		metadata: {},
	};
}

function makeStatusProfileUiDoc(): UiDoc {
	return {
		v: 1,
		ui_id: "ui:subagents",
		title: "Subagents",
		summary: "Queue healthy.",
		components: [
			{
				kind: "key_value",
				id: "queue",
				title: "Queue",
				rows: [
					{ key: "Ready", value: "2" },
					{ key: "Blocked", value: "0" },
				],
				metadata: {},
			},
		],
		actions: [
			{
				id: "refresh",
				label: "Refresh",
				payload: {},
				metadata: { command_text: "/mu status" },
			},
		],
		revision: { id: "rev-status-1", version: 7 },
		updated_at_ms: 1,
		metadata: {
			profile: {
				id: "subagents",
				variant: "status",
				snapshot: {
					compact: "ready=2 blocked=0",
					multiline: "Ready: 2\nBlocked: 0",
				},
			},
		},
	};
}

describe("server outbound ui_event egress wiring", () => {
	test("deliverSlackOutboxRecord issues UiCallbackTokenStore tokens for rendered ui_docs actions", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-server-ui-egress-"));
		const tokenPath = join(root, "ui_callback_tokens.jsonl");
		const store = new UiCallbackTokenStore(tokenPath, {
			tokenIdGenerator: () => "tokslack0001",
		});
		const record = OutboxRecordSchema.parse({
			outbox_id: "out-ui-1",
			dedupe_key: "slack:ui:1",
			state: "pending",
			envelope: {
				v: 1,
				ts_ms: 1,
				channel: "slack",
				channel_tenant_id: "team-1",
				channel_conversation_id: "chan-1",
				request_id: "req-ui-1",
				response_id: "resp-ui-1",
				kind: "result",
				body: "Choose an action",
				correlation: {
					command_id: "cmd-ui-1",
					idempotency_key: "idem-ui-1",
					request_id: "req-ui-1",
					channel: "slack",
					channel_tenant_id: "team-1",
					channel_conversation_id: "chan-1",
					actor_id: "actor-1",
					actor_binding_id: "binding-1",
					assurance_tier: "tier_a",
					repo_root: "/repo",
					scope_required: "cp.read",
					scope_effective: "cp.read",
					target_type: "status",
					target_id: "chan-1",
					attempt: 1,
					state: "completed",
					error_code: null,
					operator_session_id: null,
					operator_turn_id: null,
					cli_invocation_id: null,
					cli_command_kind: null,
				},
				metadata: {
					ui_docs: [makeUiDoc()],
				},
			},
			created_at_ms: 1,
			updated_at_ms: 1,
			next_attempt_at_ms: 1,
			attempt_count: 0,
			max_attempts: 3,
			last_error: null,
			dead_letter_reason: null,
			replay_of_outbox_id: null,
			replay_requested_by_command_id: null,
		});

		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
			calls.push({ url, body });
			return new Response(JSON.stringify({ ok: true, ts: "111.222" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const result = await deliverSlackOutboxRecord({
				botToken: "xoxb-test-token",
				record,
				uiCallbackTokenStore: store,
				nowMs: () => 5_000,
			});
			expect(result.kind).toBe("delivered");
			expect(calls.some((entry) => entry.url.endsWith("/chat.postMessage"))).toBe(true);

			const rows = await readJsonl(tokenPath);
			const entries = rows.map((row) => UiCallbackTokenJournalEntrySchema.parse(row));
			const issues = entries.filter((entry) => entry.kind === "issue");
			expect(issues).toHaveLength(1);
			if (issues.length !== 1) {
				throw new Error(`expected exactly one issue row, got ${issues.length}`);
			}
			const issue = issues[0];
			expect(issue.scope).toEqual({
				channel: "slack",
				channelTenantId: "team-1",
				channelConversationId: "chan-1",
				actorBindingId: "binding-1",
				uiId: "ui:answer",
				revision: 1,
				actionId: "answer_yes",
			});
			expect(issue.record.callback_data).toBe("mu-ui:tokslack0001");
			expect(issue.record.ui_event.metadata.command_text).toBe("/answer yes");
			expect((issue.record.ui_event.metadata as Record<string, unknown>).command_callback).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("deliverTelegramOutboxRecord degrades /answer ui_docs actions to deterministic text without callback encoder", async () => {
		const record = OutboxRecordSchema.parse({
			outbox_id: "out-ui-telegram-1",
			dedupe_key: "telegram:ui:1",
			state: "pending",
			envelope: {
				v: 1,
				ts_ms: 1,
				channel: "telegram",
				channel_tenant_id: "telegram-bot",
				channel_conversation_id: "chat-1",
				request_id: "req-ui-telegram-1",
				response_id: "resp-ui-telegram-1",
				kind: "result",
				body: "Choose an answer",
				correlation: {
					command_id: "cmd-ui-telegram-1",
					idempotency_key: "idem-ui-telegram-1",
					request_id: "req-ui-telegram-1",
					channel: "telegram",
					channel_tenant_id: "telegram-bot",
					channel_conversation_id: "chat-1",
					actor_id: "actor-1",
					actor_binding_id: "binding-1",
					assurance_tier: "tier_a",
					repo_root: "/repo",
					scope_required: "cp.read",
					scope_effective: "cp.read",
					target_type: "status",
					target_id: "chat-1",
					attempt: 1,
					state: "completed",
					error_code: null,
					operator_session_id: null,
					operator_turn_id: null,
					cli_invocation_id: null,
					cli_command_kind: null,
				},
				metadata: {
					ui_docs: [makeUiDoc()],
				},
			},
			created_at_ms: 1,
			updated_at_ms: 1,
			next_attempt_at_ms: 1,
			attempt_count: 0,
			max_attempts: 3,
			last_error: null,
			dead_letter_reason: null,
			replay_of_outbox_id: null,
			replay_requested_by_command_id: null,
		});

		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
			calls.push({ url, body });
			return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const result = await deliverTelegramOutboxRecord({
				botToken: "telegram-token",
				record,
			});
			expect(result.kind).toBe("delivered");
			expect(calls.some((entry) => entry.url.includes("/sendMessage"))).toBe(true);
			const firstSendMessage = calls.find((entry) => entry.url.includes("/sendMessage"));
			expect(firstSendMessage).toBeDefined();
			const payload = firstSendMessage?.body ?? {};
			expect(payload.reply_markup).toBeUndefined();
			const text = String(payload.text ?? "");
			expect(text).toContain("UI · Answer");
			expect(text).toContain("Actions:");
			expect(text).toContain("/answer yes");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("deliverTelegramOutboxRecord degrades status-profile ui_docs actions to deterministic text even when callback encoder is available", async () => {
		const record = OutboxRecordSchema.parse({
			outbox_id: "out-ui-telegram-status-1",
			dedupe_key: "telegram:ui:status:1",
			state: "pending",
			envelope: {
				v: 1,
				ts_ms: 1,
				channel: "telegram",
				channel_tenant_id: "telegram-bot",
				channel_conversation_id: "chat-1",
				request_id: "req-ui-telegram-status-1",
				response_id: "resp-ui-telegram-status-1",
				kind: "result",
				body: "Status snapshot",
				correlation: {
					command_id: "cmd-ui-telegram-status-1",
					idempotency_key: "idem-ui-telegram-status-1",
					request_id: "req-ui-telegram-status-1",
					channel: "telegram",
					channel_tenant_id: "telegram-bot",
					channel_conversation_id: "chat-1",
					actor_id: "actor-1",
					actor_binding_id: "binding-1",
					assurance_tier: "tier_a",
					repo_root: "/repo",
					scope_required: "cp.read",
					scope_effective: "cp.read",
					target_type: "status",
					target_id: "chat-1",
					attempt: 1,
					state: "completed",
					error_code: null,
					operator_session_id: null,
					operator_turn_id: null,
					cli_invocation_id: null,
					cli_command_kind: null,
				},
				metadata: {
					ui_docs: [makeStatusProfileUiDoc()],
				},
			},
			created_at_ms: 1,
			updated_at_ms: 1,
			next_attempt_at_ms: 1,
			attempt_count: 0,
			max_attempts: 3,
			last_error: null,
			dead_letter_reason: null,
			replay_of_outbox_id: null,
			replay_requested_by_command_id: null,
		});

		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
			calls.push({ url, body });
			return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		let encodeCalls = 0;
		try {
			const result = await deliverTelegramOutboxRecord({
				botToken: "telegram-token",
				record,
				encodeCallbackData: async () => {
					encodeCalls += 1;
					return "mu-ui:telegram:refresh";
				},
			});
			expect(result.kind).toBe("delivered");
			expect(encodeCalls).toBe(0);
			expect(calls.some((entry) => entry.url.includes("/sendMessage"))).toBe(true);
			const firstSendMessage = calls.find((entry) => entry.url.includes("/sendMessage"));
			expect(firstSendMessage).toBeDefined();
			const payload = firstSendMessage?.body ?? {};
			expect(payload.reply_markup).toBeUndefined();
			const text = String(payload.text ?? "");
			expect(text).toContain("UI · Subagents");
			expect(text).toContain("Actions:");
			expect(text).toContain("• Refresh: /mu status");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

});
