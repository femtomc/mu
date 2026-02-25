import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { UiCallbackTokenStore } from "@femtomc/mu-control-plane";

describe("UiCallbackTokenStore telegram-context decode", () => {
	test("issues bounded callback_data and consumes exactly once via context decode", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-telegram-callback-token-store-"));
		const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
		const scope = {
			channel: "telegram",
			channelTenantId: "telegram-bot",
			channelConversationId: "chat-1",
			actorBindingId: "binding-42",
			uiId: "doc-ui",
			revision: 1,
			actionId: "confirm",
		} as const;

		const record = await store.issue({
			scope,
			uiEvent: {
				ui_id: scope.uiId,
				action_id: scope.actionId,
				revision: { id: "rev-1", version: scope.revision },
				created_at_ms: 1_000,
				payload: {},
				metadata: { command_text: "/mu status" },
			},
			ttlMs: 30_000,
			nowMs: 1_000,
		});

		expect(record.callback_data.startsWith("mu-ui:")).toBe(true);

		const first = await store.decodeAndConsumeForContext({
			callbackData: record.callback_data,
			context: {
				channel: scope.channel,
				channelTenantId: scope.channelTenantId,
				channelConversationId: scope.channelConversationId,
				actorBindingId: scope.actorBindingId,
			},
			nowMs: 2_000,
		});
		expect(first.kind).toBe("ok");
		if (first.kind !== "ok") {
			throw new Error(`expected ok, got ${first.kind}`);
		}

		const second = await store.decodeAndConsumeForContext({
			callbackData: record.callback_data,
			context: {
				channel: scope.channel,
				channelTenantId: scope.channelTenantId,
				channelConversationId: scope.channelConversationId,
				actorBindingId: scope.actorBindingId,
			},
			nowMs: 3_000,
		});
		expect(second.kind).toBe("consumed");
	});

	test("invalid and expired callbacks are rejected via context decode", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-telegram-callback-token-store-invalid-"));
		const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));

		const invalid = await store.decodeAndConsumeForContext({
			callbackData: "garbage",
			context: {
				channel: "telegram",
				channelTenantId: "telegram-bot",
				channelConversationId: "chat-1",
				actorBindingId: "binding-42",
			},
			nowMs: 10,
		});
		expect(invalid.kind).toBe("invalid");

		const scope = {
			channel: "telegram",
			channelTenantId: "telegram-bot",
			channelConversationId: "chat-1",
			actorBindingId: "binding-42",
			uiId: "doc-expired",
			revision: 2,
			actionId: "retry",
		} as const;
		const record = await store.issue({
			scope,
			uiEvent: {
				ui_id: scope.uiId,
				action_id: scope.actionId,
				revision: { id: "rev-expired", version: scope.revision },
				created_at_ms: 100,
				payload: {},
				metadata: { command_text: "/mu status" },
			},
			ttlMs: 100,
			nowMs: 100,
		});

		const expired = await store.decodeAndConsumeForContext({
			callbackData: record.callback_data,
			context: {
				channel: scope.channel,
				channelTenantId: scope.channelTenantId,
				channelConversationId: scope.channelConversationId,
				actorBindingId: scope.actorBindingId,
			},
			nowMs: 250,
		});
		expect(expired.kind).toBe("expired");
	});
});
