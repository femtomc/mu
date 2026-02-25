import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboxRecordSchema, SlackControlPlaneAdapter, UiCallbackTokenStore } from "@femtomc/mu-control-plane";
import type { UiDoc, UiEvent } from "@femtomc/mu-core";
import { deliverSlackOutboxRecord } from "../src/control_plane.js";

const dirsToCleanup = new Set<string>();

afterEach(async () => {
	for (const dir of dirsToCleanup) {
		await rm(dir, { recursive: true, force: true });
	}
	dirsToCleanup.clear();
});

function hmac(secret: string, input: string): string {
	const hasher = new Bun.CryptoHasher("sha256", secret);
	hasher.update(input);
	return hasher.digest("hex");
}

function slackActionRequest(opts: {
	secret: string;
	timestampSec: number;
	actionId: string;
	actionValue: string;
}): Request {
	const payload = {
		type: "block_actions",
		team: { id: "team-1" },
		channel: { id: "chan-1" },
		user: { id: "slack-actor", team_id: "team-1" },
		trigger_id: "action-trigger-1",
		container: { message_ts: "171.7001", channel_id: "chan-1" },
		message: { ts: "171.7001", thread_ts: "171.7000" },
		actions: [{ action_id: opts.actionId, action_ts: "171.7002", value: opts.actionValue }],
	};
	const body = new URLSearchParams({
		payload: JSON.stringify(payload),
	}).toString();
	const timestamp = String(opts.timestampSec);
	const signature = `v0=${hmac(opts.secret, `v0:${timestamp}:${body}`)}`;
	return new Request("https://example.test/slack/actions", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-slack-request-timestamp": timestamp,
			"x-slack-signature": signature,
		},
		body,
	});
}

function mkUiDoc(): UiDoc {
	return {
		v: 1,
		ui_id: "ui:answer",
		title: "Answer",
		summary: "Choose how to answer.",
		components: [{ kind: "text", id: "prompt", text: "Should we answer yes?", metadata: {} }],
		actions: [
			{
				id: "answer_yes",
				label: "Answer yes",
				description: "Respond with yes",
				payload: { choice: "yes" },
				metadata: { command_text: "/answer yes" },
			},
		],
		revision: { id: "rev-1", version: 1 },
		updated_at_ms: 1_000,
		metadata: {},
	};
}

function mkSlackOutboxRecord(uiDoc: UiDoc) {
	return OutboxRecordSchema.parse({
		outbox_id: "out-slack-ui-1",
		dedupe_key: "dedupe-slack-ui-1",
		state: "pending",
		envelope: {
			v: 1,
			ts_ms: 1_000,
			channel: "slack",
			channel_tenant_id: "team-1",
			channel_conversation_id: "chan-1",
			request_id: "req-1",
			response_id: "resp-1",
			kind: "result",
			body: "ui response",
			correlation: {
				command_id: "cmd-1",
				idempotency_key: "idem-1",
				request_id: "req-1",
				channel: "slack",
				channel_tenant_id: "team-1",
				channel_conversation_id: "chan-1",
				actor_id: "slack-actor",
				actor_binding_id: "binding-slack",
				assurance_tier: "tier_a",
				repo_root: "/tmp/repo",
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
			metadata: { ui_docs: [uiDoc] },
		},
		created_at_ms: 1_000,
		updated_at_ms: 1_000,
		next_attempt_at_ms: 1_000,
		attempt_count: 0,
		max_attempts: 3,
		last_error: null,
		dead_letter_reason: null,
		replay_of_outbox_id: null,
		replay_requested_by_command_id: null,
	});
}

type DeliveredUiAction = {
	repoRoot: string;
	tokenStore: UiCallbackTokenStore;
	nowMs: number;
	payload: Record<string, unknown>;
	actionId: string;
	actionValue: string;
	uiEvent: UiEvent;
};

async function deliverAndCaptureUiAction(nowMs = 1_000): Promise<DeliveredUiAction> {
	const repoRoot = await mkdtemp(join(tmpdir(), "mu-slack-ui-delivery-"));
	dirsToCleanup.add(repoRoot);
	const tokenStore = new UiCallbackTokenStore(join(repoRoot, "ui_callback_tokens.jsonl"));
	await tokenStore.load();

	const postPayloads: Array<Record<string, unknown>> = [];
	const fetchImpl = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "https://slack.com/api/chat.postMessage") {
			postPayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify({ ok: true, ts: "171.7001" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch;

	const result = await deliverSlackOutboxRecord({
		botToken: "xoxb-test-token",
		record: mkSlackOutboxRecord(mkUiDoc()),
		uiCallbackTokenStore: tokenStore,
		nowMs: () => nowMs,
		fetchImpl,
	});
	expect(result.kind).toBe("delivered");

	expect(postPayloads).toHaveLength(1);
	const payload = postPayloads[0] as Record<string, unknown>;
	const blocks = Array.isArray(payload.blocks) ? (payload.blocks as Array<Record<string, unknown>>) : [];
	const actionBlock = blocks.find((block) => block.type === "actions") as
		| { elements?: Array<Record<string, unknown>> }
		| undefined;
	const firstButton = actionBlock?.elements?.[0] as Record<string, unknown> | undefined;
	const actionId = String(firstButton?.action_id ?? "");
	const actionValue = String(firstButton?.value ?? "");
	expect(actionId.length).toBeGreaterThan(0);
	expect(actionValue.length).toBeGreaterThan(0);
	const uiEvent = JSON.parse(actionValue) as UiEvent;

	return {
		repoRoot,
		tokenStore,
		nowMs,
		payload,
		actionId,
		actionValue,
		uiEvent,
	};
}

function createSlackAdapter(opts: {
	repoRoot: string;
	tokenStore: UiCallbackTokenStore;
	bindingId: string;
	nowMs: number;
	onInbound?: (inbound: Record<string, unknown>) => void;
}): SlackControlPlaneAdapter {
	const pipeline = {
		runtime: {
			paths: {
				repoRoot: opts.repoRoot,
				attachmentIndexPath: join(opts.repoRoot, "attachments.jsonl"),
				attachmentBlobRootDir: join(opts.repoRoot, "attachments"),
				adapterAuditPath: join(opts.repoRoot, "adapter_audit.jsonl"),
			},
		},
		identities: {
			resolveActive: () => ({ binding_id: opts.bindingId, assurance_tier: "tier_a" }),
			refreshIfStale: async () => undefined,
		},
		handleAdapterIngress: async (inbound: unknown) => {
			if (inbound && typeof inbound === "object") {
				opts.onInbound?.(inbound as Record<string, unknown>);
			}
			return { kind: "noop", reason: "test" };
		},
	} as unknown as ConstructorParameters<typeof SlackControlPlaneAdapter>[0]["pipeline"];
	const outbox = {
		enqueue: async () => ({ record: null }),
	} as unknown as ConstructorParameters<typeof SlackControlPlaneAdapter>[0]["outbox"];
	return new SlackControlPlaneAdapter({
		pipeline,
		outbox,
		signingSecret: "slack-secret",
		uiCallbackTokenStore: opts.tokenStore,
		nowMs: () => opts.nowMs,
	});
}

describe("Slack ui_docs interactive delivery", () => {
	test("renders interactive blocks for ui_docs actions without duplicate text fallback", async () => {
		const delivered = await deliverAndCaptureUiAction();

		expect(delivered.payload.text).toBe("ui response");
		expect(String(delivered.payload.text ?? "")).not.toContain("UI · ");

		const blocks = Array.isArray(delivered.payload.blocks)
			? (delivered.payload.blocks as Array<Record<string, unknown>>)
			: [];
		expect(blocks.length).toBeGreaterThan(0);
		expect(
			blocks.some((block) => {
				if (block.type !== "context") {
					return false;
				}
				const elements = block.elements as Array<Record<string, unknown>> | undefined;
				const text = elements?.[0]?.text;
				return typeof text === "string" && text.includes("UI · Answer");
			}),
		).toBe(true);
		expect(
			blocks.some((block) => {
				if (block.type !== "section") {
					return false;
				}
				const text = (block.text as Record<string, unknown>)?.text;
				return typeof text === "string" && text.includes("Actions:");
			}),
		).toBe(false);
		expect(delivered.uiEvent.callback_token?.startsWith("mu-ui:")).toBe(true);
	});

	test("routes delivery-emitted callback payloads through adapter ingress (success)", async () => {
		const delivered = await deliverAndCaptureUiAction();
		const adapter = createSlackAdapter({
			repoRoot: delivered.repoRoot,
			tokenStore: delivered.tokenStore,
			bindingId: "binding-slack",
			nowMs: delivered.nowMs,
		});

		const result = await adapter.ingest(
			slackActionRequest({
				secret: "slack-secret",
				timestampSec: Math.floor(delivered.nowMs / 1000),
				actionId: delivered.actionId,
				actionValue: delivered.actionValue,
			}),
		);
		expect(result.accepted).toBe(true);
		expect(result.reason).toBeUndefined();
		expect(await result.response.text()).toBe("");
		const inboundRecord = result.inbound as Record<string, unknown> | null;
		expect(inboundRecord?.["command_text"]).toBe("/answer yes");
		const metadata = inboundRecord?.["metadata"];
		const metadataRecord = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined;
		const uiEvent = metadataRecord?.ui_event;
		const uiEventRecord = uiEvent && typeof uiEvent === "object" ? (uiEvent as Record<string, unknown>) : undefined;
		expect(uiEventRecord?.callback_token).toBeUndefined();
	});

	test("routes delivery-emitted callback payloads through adapter ingress (invalid token)", async () => {
		const delivered = await deliverAndCaptureUiAction();
		const adapter = createSlackAdapter({
			repoRoot: delivered.repoRoot,
			tokenStore: delivered.tokenStore,
			bindingId: "binding-slack",
			nowMs: delivered.nowMs,
		});
		const invalidEvent: UiEvent = { ...delivered.uiEvent, callback_token: "mu-ui:invalid" };
		const result = await adapter.ingest(
			slackActionRequest({
				secret: "slack-secret",
				timestampSec: Math.floor(delivered.nowMs / 1000),
				actionId: delivered.actionId,
				actionValue: JSON.stringify(invalidEvent),
			}),
		);
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_invalid_callback_data");
		const body = (await result.response.json()) as { text?: string };
		expect(body.text).toBe("This interaction was not recognized.");
	});

	test("routes delivery-emitted callback payloads through adapter ingress (expired token)", async () => {
		const issuedAtMs = 1_000;
		const delivered = await deliverAndCaptureUiAction(issuedAtMs);
		const expiredNowMs = issuedAtMs + 15 * 60_000 + 1;
		const adapter = createSlackAdapter({
			repoRoot: delivered.repoRoot,
			tokenStore: delivered.tokenStore,
			bindingId: "binding-slack",
			nowMs: expiredNowMs,
		});
		const result = await adapter.ingest(
			slackActionRequest({
				secret: "slack-secret",
				timestampSec: Math.floor(expiredNowMs / 1000),
				actionId: delivered.actionId,
				actionValue: delivered.actionValue,
			}),
		);
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("expired_ui_callback_token");
		const body = (await result.response.json()) as { text?: string };
		expect(body.text).toBe("This interaction expired. Please rerun the request.");
	});

	test("routes delivery-emitted callback payloads through adapter ingress (consumed token)", async () => {
		const delivered = await deliverAndCaptureUiAction();
		const adapter = createSlackAdapter({
			repoRoot: delivered.repoRoot,
			tokenStore: delivered.tokenStore,
			bindingId: "binding-slack",
			nowMs: delivered.nowMs,
		});
		const first = await adapter.ingest(
			slackActionRequest({
				secret: "slack-secret",
				timestampSec: Math.floor(delivered.nowMs / 1000),
				actionId: delivered.actionId,
				actionValue: delivered.actionValue,
			}),
		);
		expect(first.reason).toBeUndefined();
		const second = await adapter.ingest(
			slackActionRequest({
				secret: "slack-secret",
				timestampSec: Math.floor(delivered.nowMs / 1000),
				actionId: delivered.actionId,
				actionValue: delivered.actionValue,
			}),
		);
		expect(second.accepted).toBe(true);
		expect(second.reason).toBe("consumed_ui_callback_token");
		const body = (await second.response.json()) as { text?: string };
		expect(body.text).toBe("This interaction was already used.");
	});

	test("routes delivery-emitted callback payloads through adapter ingress (scope mismatch)", async () => {
		const delivered = await deliverAndCaptureUiAction();
		const adapter = createSlackAdapter({
			repoRoot: delivered.repoRoot,
			tokenStore: delivered.tokenStore,
			bindingId: "binding-other",
			nowMs: delivered.nowMs,
		});
		const result = await adapter.ingest(
			slackActionRequest({
				secret: "slack-secret",
				timestampSec: Math.floor(delivered.nowMs / 1000),
				actionId: delivered.actionId,
				actionValue: delivered.actionValue,
			}),
		);
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("ui_callback_scope_mismatch");
		const body = (await result.response.json()) as { text?: string };
		expect(body.text).toBe("This action is not valid in this context.");
	});
});
