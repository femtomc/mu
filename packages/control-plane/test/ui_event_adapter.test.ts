import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	DiscordControlPlaneAdapter,
	NeovimControlPlaneAdapter,
	SlackControlPlaneAdapter,
	UiCallbackTokenStore,
} from "@femtomc/mu-control-plane";
import type { UiEvent } from "@femtomc/mu-core";
import { commandTextFromUiEvent } from "../src/ui_event_ingress.js";
import { InboundEnvelope } from "../src/models.js";

type SlackPayloadEvent = Record<string, unknown>;

function slackPayload(event: SlackPayloadEvent) {
	return {
		type: "block_actions",
		team: { id: "T1" },
		channel: { id: "C1" },
		user: { id: "U1", team_id: "T1" },
		trigger_id: "trigger-1",
		container: { message_ts: "1111.1111", channel_id: "C1" },
		message: { ts: "1111.1111" },
		actions: [
			{
				action_id: "mu_hud_action:ui_event",
				action_ts: "1111.1111",
				value: JSON.stringify(event),
			},
		],
	};
}

function slackRequest(signingSecret: string, payload: Record<string, unknown>, timestamp?: number): Request {
	const json = JSON.stringify(payload);
	const encoded = `payload=${encodeURIComponent(json)}`;
	const ts = timestamp ?? Math.floor(Date.now() / 1000);
	const base = `v0:${ts}:${encoded}`;
	const signature = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
	return new Request("https://example.com/webhooks/slack", {
		method: "POST",
		body: encoded,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-slack-signature": signature,
			"x-slack-request-timestamp": String(ts),
		},
	});
}

function discordRequest(signingSecret: string, payload: Record<string, unknown>, timestamp?: number): Request {
	const json = JSON.stringify(payload);
	const ts = timestamp ?? Math.floor(Date.now() / 1000);
	const base = `v1:${ts}:${json}`;
	const signature = `v1=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
	return new Request("https://example.com/webhooks/discord", {
		method: "POST",
		body: json,
		headers: {
			"content-type": "application/json",
			"x-discord-signature": signature,
			"x-discord-request-timestamp": String(ts),
		},
	});
}

function neovimRequest(sharedSecret: string, payload: Record<string, unknown>): Request {
	return new Request("https://example.com/webhooks/neovim", {
		method: "POST",
		body: JSON.stringify(payload),
		headers: {
			"content-type": "application/json",
			"x-mu-neovim-secret": sharedSecret,
		},
	});
}

type UiScope = {
	channel: string;
	channelTenantId: string;
	channelConversationId: string;
	actorBindingId: string;
	uiId: string;
	revision: number;
	actionId: string;
};

const BASE_SCOPE: UiScope = {
	channel: "slack",
	channelTenantId: "T1",
	channelConversationId: "C1",
	actorBindingId: "binding-1",
	uiId: "doc-ui",
	revision: 1,
	actionId: "confirm",
};

const BASE_DISCORD_SCOPE: UiScope = {
	channel: "discord",
	channelTenantId: "guild-1",
	channelConversationId: "channel-1",
	actorBindingId: "binding-1",
	uiId: "doc-ui",
	revision: 1,
	actionId: "confirm",
};

const BASE_NEOVIM_SCOPE: UiScope = {
	channel: "neovim",
	channelTenantId: "workspace-1",
	channelConversationId: "workspace:main",
	actorBindingId: "binding-1",
	uiId: "doc-ui",
	revision: 1,
	actionId: "confirm",
};

function createUiEvent(): UiEvent {
	return {
		ui_id: BASE_SCOPE.uiId,
		action_id: BASE_SCOPE.actionId,
		revision: { id: "rev-1", version: BASE_SCOPE.revision },
		created_at_ms: 1,
		payload: {},
		metadata: { command_text: "/mu confirm" },
	};
}

function encodeDiscordCustomId(event: UiEvent): string {
	return [
		"mu_evt",
		encodeURIComponent(event.ui_id),
		String(event.revision.version),
		encodeURIComponent(event.action_id),
		String(event.callback_token ?? ""),
	].join("|");
}

async function setupSlackAdapter(
	bindingId = "binding-1",
	initialNowMs = 1_000,
	captureInbound?: (inbound: InboundEnvelope) => void,
) {
	const root = await mkdtemp(join(tmpdir(), "mu-slack-ui-"));
	const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
	const pipeline = {
		runtime: { paths: { repoRoot: root } },
		identities: {
			resolveActive: () => ({ binding_id: bindingId, assurance_tier: "tier_b" }),
			refreshIfStale: async () => undefined,
		},
		handleAdapterIngress: async (inbound: InboundEnvelope) => {
			captureInbound?.(inbound);
			return { kind: "noop", reason: "test" };
		},
	} as any;
	const outbox = { enqueue: async () => ({ record: null }) } as any;
	const nowClock = { value: initialNowMs };
	const adapter = new SlackControlPlaneAdapter({
		pipeline,
		outbox,
		signingSecret: "sign",
		uiCallbackTokenStore: store,
		nowMs: () => nowClock.value,
	});
	return { adapter, store, nowClock };
}

async function setupDiscordAdapter(
	bindingId = "binding-1",
	initialNowMs = 1_000,
	captureInbound?: (inbound: InboundEnvelope) => void,
	resultForInbound: (inbound: InboundEnvelope) => unknown = () => ({ kind: "noop", reason: "test" }),
) {
	const root = await mkdtemp(join(tmpdir(), "mu-discord-ui-"));
	const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
	const pipeline = {
		runtime: { paths: { repoRoot: root } },
		identities: {
			resolveActive: () => ({ binding_id: bindingId, assurance_tier: "tier_b" }),
			refreshIfStale: async () => undefined,
		},
		handleAdapterIngress: async (inbound: InboundEnvelope) => {
			captureInbound?.(inbound);
			return resultForInbound(inbound);
		},
	} as any;
	const outbox = { enqueue: async () => ({ record: null }) } as any;
	const nowClock = { value: initialNowMs };
	const adapter = new DiscordControlPlaneAdapter({
		pipeline,
		outbox,
		signingSecret: "discord-sign",
		uiCallbackTokenStore: store,
		nowMs: () => nowClock.value,
	});
	return { adapter, store, nowClock };
}

async function setupNeovimAdapter(
	bindingId = "binding-1",
	initialNowMs = 1_000,
	captureInbound?: (inbound: InboundEnvelope) => void,
	resultForInbound: (inbound: InboundEnvelope) => unknown = () => ({ kind: "noop", reason: "test" }),
) {
	const root = await mkdtemp(join(tmpdir(), "mu-neovim-ui-"));
	const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
	const handleInbound = async (inbound: InboundEnvelope) => {
		captureInbound?.(inbound);
		return resultForInbound(inbound);
	};
	const pipeline = {
		runtime: { paths: { repoRoot: root } },
		identities: {
			resolveActive: () => ({ binding_id: bindingId, assurance_tier: "tier_b" }),
			refreshIfStale: async () => undefined,
		},
		handleAdapterIngress: handleInbound,
		handleInbound,
	} as any;
	const nowClock = { value: initialNowMs };
	const adapter = new NeovimControlPlaneAdapter({
		pipeline,
		sharedSecret: "nvim-sign",
		uiCallbackTokenStore: store,
		nowMs: () => nowClock.value,
	});
	return { adapter, store, nowClock };
}

async function prepareSignedUiEvent(store: UiCallbackTokenStore, scope: UiScope, nowMs: number, ttlMs = 30_000) {
	const event = createUiEvent();
	const record = await store.issue({
		scope,
		uiEvent: event,
		ttlMs,
		nowMs,
	});
	event.callback_token = record.callback_data;
	return event;
}

describe("Slack UI event ingress", () => {
	test("accepts valid callback tokens and forwards events", async () => {
		const env = await setupSlackAdapter();
		const event = await prepareSignedUiEvent(env.store, BASE_SCOPE, env.nowClock.value);
		const payload = slackPayload(event);
		const slackTimestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBeUndefined();
		expect(result.pipelineResult?.kind).toBe("noop");
	});

	test("rejects invalid callback tokens", async () => {
		const env = await setupSlackAdapter();
		const event = createUiEvent();
		event.callback_token = "mu-ui:invalid";
		const payload = slackPayload(event);
		const slackTimestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_invalid_callback_data");
		const body = (await result.response.json()) as { text: string };
		expect(body.text).toBe("This interaction was not recognized.");
	});

	test("rejects expired callback tokens", async () => {
		const env = await setupSlackAdapter();
		const ttlMs = 5_000;
		const event = await prepareSignedUiEvent(env.store, BASE_SCOPE, env.nowClock.value, ttlMs);
		const payload = slackPayload(event);
		env.nowClock.value += ttlMs + 1;
		const slackTimestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("expired_ui_callback_token");
		const body = (await result.response.json()) as { text: string };
		expect(body.text).toBe("This interaction expired. Please rerun the request.");
	});

	test("rejects consumed callback tokens", async () => {
		const env = await setupSlackAdapter();
		const event = await prepareSignedUiEvent(env.store, BASE_SCOPE, env.nowClock.value);
		const payload = slackPayload(event);
		const slackTimestamp = Math.floor(env.nowClock.value / 1000);
		await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		const result = await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("consumed_ui_callback_token");
		const body = (await result.response.json()) as { text: string };
		expect(body.text).toBe("This interaction was already used.");
	});

	test("enforces actor binding scope checks", async () => {
		const env = await setupSlackAdapter("binding-2");
		const scopeWithOriginalBinding: UiScope = { ...BASE_SCOPE, actorBindingId: "binding-1" };
		const event = await prepareSignedUiEvent(env.store, scopeWithOriginalBinding, env.nowClock.value);
		const payload = slackPayload(event);
		const slackTimestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_scope_mismatch");
		const body = (await result.response.json()) as { text: string };
		expect(body.text).toBe("This action is not valid in this context.");
	});

	test("ui event command_text metadata becomes pipeline command text", async () => {
		let capturedInbound: InboundEnvelope | null = null;
		const env = await setupSlackAdapter("binding-1", 1_000, (inbound) => {
			capturedInbound = inbound;
		});
		const event = await prepareSignedUiEvent(env.store, BASE_SCOPE, env.nowClock.value);
		const payload = slackPayload(event);
		const slackTimestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		expect(result.accepted).toBe(true);
		expect(capturedInbound).not.toBeNull();
		const inbound = capturedInbound as InboundEnvelope | null;
		expect(inbound?.command_text).toBe("/mu confirm");
	});

	test("missing command_text metadata returns deterministic no-op reason", async () => {
		const env = await setupSlackAdapter("binding-1", 1_000);
		const event = createUiEvent();
		event.metadata = {};
		const record = await env.store.issue({
			scope: BASE_SCOPE,
			uiEvent: event,
			ttlMs: 30_000,
			nowMs: env.nowClock.value,
		});
		event.callback_token = record.callback_data;
		const payload = slackPayload(event);
		const slackTimestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(slackRequest("sign", payload, slackTimestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_event_missing_command_text");
		const body = (await result.response.json()) as { text?: string };
		expect(body.text).toContain("missing command_text metadata");
	});

	test("commandTextFromUiEvent prefers metadata override", () => {
		const baseEvent = createUiEvent();
		const eventWithMetadata: UiEvent = {
			...baseEvent,
			metadata: { ...baseEvent.metadata, command_text: "/answer yes" },
		};
		expect(commandTextFromUiEvent(eventWithMetadata)).toBe("/answer yes");
		const fallback = commandTextFromUiEvent({
			...eventWithMetadata,
			metadata: { ...eventWithMetadata.metadata, command_text: "" },
		});
		expect(fallback).toBeNull();
	});
});

describe("Discord UI event ingress", () => {
	test("accepts valid callback tokens and emits ui_event metadata", async () => {
		const env = await setupDiscordAdapter("binding-1", 1_000);
		const event = await prepareSignedUiEvent(env.store, BASE_DISCORD_SCOPE, env.nowClock.value);
		const payload = {
			id: "interaction-1",
			type: 3,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				component_type: 2,
				custom_id: encodeDiscordCustomId(event),
			},
			message: {
				id: "message-1",
				channel_id: "channel-1",
			},
		};
		const timestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(discordRequest("discord-sign", payload, timestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBeUndefined();
		const inbound = result.inbound;
		expect(inbound).not.toBeNull();
		if (!inbound) {
			throw new Error("expected inbound envelope");
		}
		expect(inbound.command_text).toBe("/mu confirm");
		expect(inbound.metadata?.ui_event_token_id).toBeDefined();
		expect((inbound.metadata?.ui_event as Record<string, unknown> | undefined)?.callback_token).toBeUndefined();
		const body = (await result.response.json()) as { type: number; data?: { content?: string } };
		expect(body.type).toBe(4);
		expect(typeof body.data?.content).toBe("string");
	});

	test("renders tokenized ui_docs actions and accepts callback round-trip", async () => {
		const uiDoc = {
			v: 1,
			ui_id: "u",
			title: "Prompt",
			components: [{ kind: "text", id: "c", text: "Proceed?", metadata: {} }],
			actions: [{ id: "y", label: "Yes", payload: {}, metadata: { command_text: "/mu y" } }],
			revision: { id: "r", version: 1 },
			updated_at_ms: 1,
			metadata: {},
		} as const;
		const env = await setupDiscordAdapter(
			"binding-1",
			2_000,
			undefined,
			(inbound) => {
				if (inbound.command_text === "/mu show") {
					return { kind: "operator_response", message: "Select", ui_docs: [uiDoc] };
				}
				return { kind: "noop", reason: "test" };
			},
		);
		const slashPayload = {
			id: "interaction-slash-1",
			type: 2,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				name: "mu",
				text: "show",
			},
		};
		const timestamp = Math.floor(env.nowClock.value / 1000);
		const slashResult = await env.adapter.ingest(discordRequest("discord-sign", slashPayload, timestamp));
		expect(slashResult.accepted).toBe(true);
		const slashBody = (await slashResult.response.json()) as {
			type: number;
			data?: {
				content?: string;
				components?: Array<{ components?: Array<{ custom_id?: string }> }>;
			};
		};
		expect(slashBody.type).toBe(4);
		const customId = String(slashBody.data?.components?.[0]?.components?.[0]?.custom_id ?? "");
		expect(customId.length).toBeGreaterThan(0);
		expect(customId.startsWith("mu_evt|")).toBe(true);
		const customParts = customId.split("|");
		expect(customParts[4]?.startsWith("mu-ui:")).toBe(true);

		const callbackPayload = {
			id: "interaction-callback-1",
			type: 3,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				component_type: 2,
				custom_id: customId,
			},
			message: {
				id: "message-1",
				channel_id: "channel-1",
			},
		};
		const callbackResult = await env.adapter.ingest(discordRequest("discord-sign", callbackPayload, timestamp));
		expect(callbackResult.accepted).toBe(true);
		expect(callbackResult.inbound?.command_text).toBe("/mu y");
		expect(callbackResult.inbound?.metadata?.ui_event_token_id).toBeDefined();
	});

	test("rejects invalid callback tokens", async () => {
		const env = await setupDiscordAdapter();
		const event = createUiEvent();
		event.callback_token = "mu-ui:invalid";
		const payload = {
			id: "interaction-2",
			type: 3,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				component_type: 2,
				custom_id: encodeDiscordCustomId(event),
			},
		};
		const timestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(discordRequest("discord-sign", payload, timestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_invalid_callback_data");
		const body = (await result.response.json()) as { type: number; data?: { content?: string } };
		expect(body.type).toBe(4);
		expect(body.data?.content).toBe("This interaction was not recognized.");
	});

	test("rejects expired callback tokens", async () => {
		const env = await setupDiscordAdapter();
		const ttlMs = 5_000;
		const event = await prepareSignedUiEvent(env.store, BASE_DISCORD_SCOPE, env.nowClock.value, ttlMs);
		const payload = {
			id: "interaction-3",
			type: 3,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				component_type: 2,
				custom_id: encodeDiscordCustomId(event),
			},
		};
		env.nowClock.value += ttlMs + 1;
		const timestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(discordRequest("discord-sign", payload, timestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("expired_ui_callback_token");
	});

	test("rejects consumed callback tokens", async () => {
		const env = await setupDiscordAdapter();
		const event = await prepareSignedUiEvent(env.store, BASE_DISCORD_SCOPE, env.nowClock.value);
		const payload = {
			id: "interaction-4",
			type: 3,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				component_type: 2,
				custom_id: encodeDiscordCustomId(event),
			},
		};
		const timestamp = Math.floor(env.nowClock.value / 1000);
		await env.adapter.ingest(discordRequest("discord-sign", payload, timestamp));
		const result = await env.adapter.ingest(discordRequest("discord-sign", payload, timestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("consumed_ui_callback_token");
	});

	test("enforces actor binding scope checks", async () => {
		const env = await setupDiscordAdapter("binding-2");
		const scopeWithOriginalBinding: UiScope = { ...BASE_DISCORD_SCOPE, actorBindingId: "binding-1" };
		const event = await prepareSignedUiEvent(env.store, scopeWithOriginalBinding, env.nowClock.value);
		const payload = {
			id: "interaction-5",
			type: 3,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				component_type: 2,
				custom_id: encodeDiscordCustomId(event),
			},
		};
		const timestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(discordRequest("discord-sign", payload, timestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_scope_mismatch");
	});

	test("missing command_text metadata returns deterministic no-op reason", async () => {
		const env = await setupDiscordAdapter();
		const event = createUiEvent();
		event.metadata = {};
		const record = await env.store.issue({
			scope: BASE_DISCORD_SCOPE,
			uiEvent: event,
			ttlMs: 30_000,
			nowMs: env.nowClock.value,
		});
		event.callback_token = record.callback_data;
		const payload = {
			id: "interaction-missing-command",
			type: 3,
			guild_id: "guild-1",
			channel_id: "channel-1",
			token: "interaction-token",
			member: { user: { id: "user-1" } },
			data: {
				component_type: 2,
				custom_id: encodeDiscordCustomId(event),
			},
		};
		const timestamp = Math.floor(env.nowClock.value / 1000);
		const result = await env.adapter.ingest(discordRequest("discord-sign", payload, timestamp));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_event_missing_command_text");
		const body = (await result.response.json()) as { data?: { content?: string } };
		expect(String(body.data?.content ?? "")).toContain("missing command_text metadata");
	});
});

describe("Neovim frontend UI event ingress", () => {
	test("issues callback tokens on outbound ui_docs actions and accepts follow-up ui_event payload", async () => {
		const uiDoc = {
			v: 1,
			ui_id: "ui:prompt",
			title: "Prompt",
			components: [{ kind: "text", id: "intro", text: "Continue?", metadata: {} }],
			actions: [{ id: "confirm", label: "Confirm", payload: {}, metadata: { command_text: "/mu confirm" } }],
			revision: { id: "rev-1", version: 1 },
			updated_at_ms: 1,
			metadata: {},
		} as const;
		let seenCommandTexts: string[] = [];
		const env = await setupNeovimAdapter(
			"binding-1",
			1_000,
			(inbound) => {
				seenCommandTexts.push(inbound.command_text);
			},
			(inbound) => {
				if (inbound.command_text === "/mu status") {
					return { kind: "operator_response", message: "Pick an action", ui_docs: [uiDoc] };
				}
				return { kind: "noop", reason: "callback_ok" };
			},
		);
		const initial = await env.adapter.ingest(
			neovimRequest("nvim-sign", {
				tenant_id: "workspace-1",
				conversation_id: "workspace:main",
				actor_id: "actor-1",
				command_text: "status",
			}),
		);
		expect(initial.accepted).toBe(true);
		const initialBody = (await initial.response.json()) as {
			result?: {
				kind?: string;
				ui_docs?: Array<{
					ui_id: string;
					revision: { id: string; version: number };
					actions: Array<{
						id: string;
						payload: Record<string, unknown>;
						metadata: Record<string, unknown>;
						callback_token?: string;
					}>;
				}>;
			};
		};
		expect(initialBody.result?.kind).toBe("operator_response");
		const returnedDoc = initialBody.result?.ui_docs?.[0];
		expect(returnedDoc).toBeDefined();
		const returnedAction = returnedDoc?.actions?.[0];
		expect(typeof returnedAction?.callback_token).toBe("string");
		const callbackToken = String(returnedAction?.callback_token ?? "");
		expect(callbackToken.startsWith("mu-ui:")).toBe(true);

		const followup = await env.adapter.ingest(
			neovimRequest("nvim-sign", {
				tenant_id: "workspace-1",
				conversation_id: "workspace:main",
				actor_id: "actor-1",
				ui_event: {
					ui_id: String(returnedDoc?.ui_id ?? "ui:prompt"),
					action_id: String(returnedAction?.id ?? "confirm"),
					revision: returnedDoc?.revision ?? { id: "rev-1", version: 1 },
					payload: returnedAction?.payload ?? {},
					created_at_ms: env.nowClock.value + 1,
					metadata: returnedAction?.metadata ?? { command_text: "/mu confirm" },
					callback_token: callbackToken,
				},
			}),
		);
		expect(followup.accepted).toBe(true);
		expect(seenCommandTexts).toContain("/mu status");
		expect(seenCommandTexts).toContain("/mu confirm");
		expect(followup.inbound?.metadata?.ui_event_token_id).toBeDefined();
	});

	test("rejects legacy text-only ingress payloads", async () => {
		const env = await setupNeovimAdapter("binding-1", 1_000);
		const result = await env.adapter.ingest(
			neovimRequest("nvim-sign", {
				tenant_id: "workspace-1",
				conversation_id: "workspace:main",
				actor_id: "actor-1",
				text: "status",
			}),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("invalid_payload");
		expect(result.response.status).toBe(400);
	});

	test("accepts explicit ui_event payload and emits metadata", async () => {
		const env = await setupNeovimAdapter("binding-1", 1_000);
		const event = await prepareSignedUiEvent(env.store, BASE_NEOVIM_SCOPE, env.nowClock.value);
		const payload = {
			tenant_id: "workspace-1",
			conversation_id: "workspace:main",
			actor_id: "actor-1",
			ui_event: event,
		};
		const result = await env.adapter.ingest(neovimRequest("nvim-sign", payload));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBeUndefined();
		const inbound = result.inbound;
		expect(inbound).not.toBeNull();
		if (!inbound) {
			throw new Error("expected inbound envelope");
		}
		expect(inbound.command_text).toBe("/mu confirm");
		expect(inbound.metadata?.ui_event_token_id).toBeDefined();
		expect((inbound.metadata?.ui_event as Record<string, unknown> | undefined)?.callback_token).toBeUndefined();
	});

	test("missing command_text metadata returns deterministic no-op reason", async () => {
		const env = await setupNeovimAdapter("binding-1", 1_000);
		const event = createUiEvent();
		event.metadata = {};
		const record = await env.store.issue({
			scope: BASE_NEOVIM_SCOPE,
			uiEvent: event,
			ttlMs: 30_000,
			nowMs: env.nowClock.value,
		});
		event.callback_token = record.callback_data;
		const payload = {
			tenant_id: "workspace-1",
			conversation_id: "workspace:main",
			actor_id: "actor-1",
			ui_event: event,
		};
		const result = await env.adapter.ingest(neovimRequest("nvim-sign", payload));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_event_missing_command_text");
		const body = (await result.response.json()) as { ok?: boolean; reason?: string; message?: string };
		expect(body.ok).toBe(false);
		expect(body.reason).toBe("ui_event_missing_command_text");
		expect(String(body.message ?? "")).toContain("missing command_text metadata");
	});

	test("rejects invalid callback tokens", async () => {
		const env = await setupNeovimAdapter();
		const event = createUiEvent();
		event.callback_token = "mu-ui:invalid";
		const payload = {
			tenant_id: "workspace-1",
			conversation_id: "workspace:main",
			actor_id: "actor-1",
			ui_event: event,
		};
		const result = await env.adapter.ingest(neovimRequest("nvim-sign", payload));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_invalid_callback_data");
		const body = (await result.response.json()) as { ok: boolean; reason?: string };
		expect(body.ok).toBe(false);
		expect(body.reason).toBe("ui_callback_invalid_callback_data");
	});

	test("rejects expired callback tokens", async () => {
		const env = await setupNeovimAdapter();
		const ttlMs = 5_000;
		const event = await prepareSignedUiEvent(env.store, BASE_NEOVIM_SCOPE, env.nowClock.value, ttlMs);
		const payload = {
			tenant_id: "workspace-1",
			conversation_id: "workspace:main",
			actor_id: "actor-1",
			ui_event: event,
		};
		env.nowClock.value += ttlMs + 1;
		const result = await env.adapter.ingest(neovimRequest("nvim-sign", payload));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("expired_ui_callback_token");
	});

	test("rejects consumed callback tokens", async () => {
		const env = await setupNeovimAdapter();
		const event = await prepareSignedUiEvent(env.store, BASE_NEOVIM_SCOPE, env.nowClock.value);
		const payload = {
			tenant_id: "workspace-1",
			conversation_id: "workspace:main",
			actor_id: "actor-1",
			ui_event: event,
		};
		await env.adapter.ingest(neovimRequest("nvim-sign", payload));
		const result = await env.adapter.ingest(neovimRequest("nvim-sign", payload));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("consumed_ui_callback_token");
	});

	test("enforces actor binding scope checks", async () => {
		const env = await setupNeovimAdapter("binding-2");
		const scopeWithOriginalBinding: UiScope = { ...BASE_NEOVIM_SCOPE, actorBindingId: "binding-1" };
		const event = await prepareSignedUiEvent(env.store, scopeWithOriginalBinding, env.nowClock.value);
		const payload = {
			tenant_id: "workspace-1",
			conversation_id: "workspace:main",
			actor_id: "actor-1",
			ui_event: event,
		};
		const result = await env.adapter.ingest(neovimRequest("nvim-sign", payload));
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_scope_mismatch");
	});
});
