import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { UiEvent } from "@femtomc/mu-core";
import { TelegramControlPlaneAdapter } from "@femtomc/mu-control-plane";
import type { InboundEnvelope } from "../src/models.js";

function createUiEvent(): UiEvent {
	return {
		ui_id: "doc-ui",
		action_id: "confirm",
		revision: { id: "rev-1", version: 1 },
		created_at_ms: 1,
		payload: {},
		metadata: { command_text: "/mu status" },
	};
}

function telegramCallbackRequest(opts: {
	callbackData: string;
	actorId?: string;
	chatId?: string;
	callbackId?: string;
	updateId?: number;
}): Request {
	return new Request("http://localhost/webhooks/telegram", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": "secret",
		},
		body: JSON.stringify({
			update_id: opts.updateId ?? 11,
			callback_query: {
				id: opts.callbackId ?? "cb-1",
				data: opts.callbackData,
				from: { id: opts.actorId ?? "42" },
				message: { message_id: 7, chat: { id: opts.chatId ?? "chat-1" } },
			},
		}),
	});
}

async function setupTelegramAdapter(bindingId = "binding-42", initialNowMs = 1_000) {
	const root = await mkdtemp(join(tmpdir(), "mu-telegram-callback-routing-"));
	const nowClock = { value: initialNowMs };
	const seenInbounds: InboundEnvelope[] = [];
	const adapter = new TelegramControlPlaneAdapter({
		pipeline: {
			runtime: {
				paths: {
					repoRoot: root,
					controlPlaneDir: root,
					attachmentIndexPath: join(root, "attachments/index.jsonl"),
					attachmentBlobRootDir: join(root, "attachments/blobs"),
					adapterAuditPath: join(root, "adapter_audit.jsonl"),
				},
			},
			identities: { resolveActive: () => ({ binding_id: bindingId, assurance_tier: "tier_b" }) },
			handleAdapterIngress: async (inbound: InboundEnvelope) => {
				seenInbounds.push(inbound);
				return { kind: "operator_response", message: "ack" };
			},
		} as any,
		outbox: {
			enqueue: async () => ({ record: null }),
		} as any,
		webhookSecret: "secret",
		nowMs: () => nowClock.value,
	});
	await adapter.warmup();
	return { adapter, nowClock, seenInbounds };
}

describe("Telegram callback decode routing", () => {
	test("decoded callback token maps to safe command routing and preserves ui_event metadata", async () => {
		const env = await setupTelegramAdapter("binding-42", 1_000);
		const uiEvent = createUiEvent();

		const callbackData = await env.adapter.issueCallbackToken({
			commandText: "/mu status",
			ttlMs: 10_000,
			nowMs: env.nowClock.value,
			actorId: "42",
			actorBindingId: "binding-42",
			conversationId: "chat-1",
			uiEvent,
		});

		const result = await env.adapter.ingest(
			telegramCallbackRequest({
				callbackData,
				actorId: "42",
				chatId: "chat-1",
				callbackId: "cb-1",
				updateId: 11,
			}),
		);
		expect(result.accepted).toBe(true);
		expect(env.seenInbounds).toHaveLength(1);
		expect(env.seenInbounds[0]?.command_text).toBe("/mu status");
		expect(env.seenInbounds[0]?.metadata?.ui_event).toEqual(uiEvent);
		expect(env.seenInbounds[0]?.metadata?.ui_event_token_id).toBeDefined();
	});

	test("invalid callback token is rejected with callback ack", async () => {
		const env = await setupTelegramAdapter();

		const result = await env.adapter.ingest(
			telegramCallbackRequest({
				callbackData: "invalid",
				callbackId: "cb-2",
				updateId: 12,
			}),
		);

		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("ui_callback_invalid_callback_data");
		const body = (await result.response.json()) as { method?: string };
		expect(body.method).toBe("answerCallbackQuery");
	});

	test("expired callback token is rejected", async () => {
		const env = await setupTelegramAdapter("binding-42", 100);
		const callbackData = await env.adapter.issueCallbackToken({
			commandText: "/mu status",
			ttlMs: 100,
			nowMs: env.nowClock.value,
			actorId: "42",
			actorBindingId: "binding-42",
			conversationId: "chat-1",
		});
		env.nowClock.value = 1_250;

		const result = await env.adapter.ingest(
			telegramCallbackRequest({
				callbackData,
				actorId: "42",
				chatId: "chat-1",
				callbackId: "cb-expired",
				updateId: 13,
			}),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("expired_ui_callback_token");
	});

	test("consumed callback token is rejected on second use", async () => {
		const env = await setupTelegramAdapter("binding-42", 1_000);
		const callbackData = await env.adapter.issueCallbackToken({
			commandText: "/mu status",
			ttlMs: 10_000,
			nowMs: env.nowClock.value,
			actorId: "42",
			actorBindingId: "binding-42",
			conversationId: "chat-1",
		});

		const first = await env.adapter.ingest(
			telegramCallbackRequest({
				callbackData,
				callbackId: "cb-consumed",
				updateId: 14,
			}),
		);
		expect(first.accepted).toBe(true);

		const second = await env.adapter.ingest(
			telegramCallbackRequest({
				callbackData,
				callbackId: "cb-consumed",
				updateId: 15,
			}),
		);
		expect(second.accepted).toBe(false);
		expect(second.reason).toBe("consumed_ui_callback_token");
	});

	test("scope mismatch callback token is rejected", async () => {
		const env = await setupTelegramAdapter("binding-42", 1_000);
		const callbackData = await env.adapter.issueCallbackToken({
			commandText: "/mu status",
			ttlMs: 10_000,
			nowMs: env.nowClock.value,
			actorId: "42",
			actorBindingId: "binding-42",
			conversationId: "chat-1",
		});

		const result = await env.adapter.ingest(
			telegramCallbackRequest({
				callbackData,
				actorId: "99",
				chatId: "chat-2",
				callbackId: "cb-scope",
				updateId: 16,
			}),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("ui_callback_scope_mismatch");
	});
});
