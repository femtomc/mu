import {
	type AdapterIngressResult,
	type ControlPlaneAdapter,
	ControlPlaneAdapterSpecSchema,
	defaultWebhookRouteForChannel,
} from "./adapter_contract.js";
import type { CommandPipelineResult, ControlPlaneCommandPipeline } from "./command_pipeline.js";
import { type CommandRecord, correlationFromCommandRecord } from "./command_record.js";
import { assuranceTierForChannel, type Channel, ChannelSchema } from "./identity_store.js";
import { formatAdapterAckMessage, presentPipelineResultMessage } from "./interaction_contract.js";
import { type AssuranceTier, type InboundEnvelope, InboundEnvelopeSchema, type OutboundEnvelope } from "./models.js";
import type { ControlPlaneOutbox, OutboxRecord } from "./outbox.js";

function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

function hmacSha256Hex(secret: string, input: string): string {
	const hasher = new Bun.CryptoHasher("sha256", secret);
	hasher.update(input);
	return hasher.digest("hex");
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	const maxLen = Math.max(left.length, right.length);
	for (let i = 0; i < maxLen; i++) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}

function copyHeaders(initHeaders: unknown): Headers {
	const headers = new Headers();
	if (!initHeaders) {
		return headers;
	}

	if (Array.isArray(initHeaders)) {
		for (const entry of initHeaders) {
			const [key, value] = entry as [unknown, unknown];
			headers.append(String(key), String(value));
		}
		return headers;
	}

	if (typeof (initHeaders as any).forEach === "function") {
		(initHeaders as any).forEach((value: unknown, key: unknown) => {
			headers.append(String(key), String(value));
		});
		return headers;
	}

	if (typeof (initHeaders as any)[Symbol.iterator] === "function") {
		for (const entry of initHeaders as any) {
			if (Array.isArray(entry) && entry.length >= 2) {
				headers.append(String(entry[0]), String(entry[1]));
			}
		}
		return headers;
	}

	for (const [key, value] of Object.entries(initHeaders as Record<string, unknown>)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(key, String(item));
			}
		} else if (value != null) {
			headers.set(key, String(value));
		}
	}
	return headers;
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	const headers = copyHeaders(init.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "application/json; charset=utf-8");
	}
	return new Response(JSON.stringify(data), { ...init, headers });
}

function textResponse(text: string, init: ResponseInit = {}): Response {
	const headers = copyHeaders(init.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "text/plain; charset=utf-8");
	}
	return new Response(text, { ...init, headers });
}

function normalizeSlashMuCommand(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("/mu")) {
		return trimmed;
	}
	if (trimmed.length === 0) {
		return "/mu";
	}
	return `/mu ${trimmed}`;
}

function normalizeTelegramMessageCommand(text: string, botUsername: string | null): string {
	const trimmed = text.trim();
	const botTarget = botUsername ? botUsername.replace(/^@/, "").toLowerCase() : null;
	const mentionMatch = /^\/mu@([a-z0-9_]+)(?:\s+(.*))?$/i.exec(trimmed);
	if (mentionMatch) {
		const mentioned = mentionMatch[1]!.toLowerCase();
		if (botTarget && mentioned !== botTarget) {
			return trimmed;
		}
		const suffix = (mentionMatch[2] ?? "").trim();
		return suffix.length > 0 ? `/mu ${suffix}` : "/mu";
	}
	if (trimmed.startsWith("/mu")) {
		return trimmed;
	}
	return trimmed;
}

function normalizeTelegramCallbackData(data: string): string | null {
	const trimmed = data.trim();
	const confirmMatch = /^confirm:([^\s:]+)$/i.exec(trimmed);
	if (confirmMatch?.[1]) {
		return `/mu confirm ${confirmMatch[1]}`;
	}
	const cancelMatch = /^cancel:([^\s:]+)$/i.exec(trimmed);
	if (cancelMatch?.[1]) {
		return `/mu cancel ${cancelMatch[1]}`;
	}
	return null;
}

function stringId(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(Math.trunc(value));
	}
	return null;
}

function resolveAssuranceFallback(channel: string): AssuranceTier {
	const parsed = ChannelSchema.safeParse(channel);
	if (!parsed.success) {
		return "tier_c";
	}
	return assuranceTierForChannel(parsed.data);
}

function resolveBindingHint(
	pipeline: ControlPlaneCommandPipeline,
	channel: Channel,
	channelTenantId: string,
	actorId: string,
): {
	actorBindingId: string;
	assuranceTier: AssuranceTier;
} {
	const binding = pipeline.identities.resolveActive({
		channel,
		channelTenantId,
		channelActorId: actorId,
	});
	if (!binding) {
		const fallbackId = `unlinked-${channel}-${sha256Hex(`${channelTenantId}:${actorId}`).slice(0, 16)}`;
		return {
			actorBindingId: fallbackId,
			assuranceTier: resolveAssuranceFallback(channel),
		};
	}
	return {
		actorBindingId: binding.binding_id,
		assuranceTier: binding.assurance_tier,
	};
}

function commandFromPipelineResult(result: CommandPipelineResult): CommandRecord | null {
	switch (result.kind) {
		case "awaiting_confirmation":
		case "completed":
		case "cancelled":
		case "expired":
		case "deferred":
		case "failed":
			return result.command;
		default:
			return null;
	}
}

function outboundKindForPipelineResult(result: CommandPipelineResult): OutboundEnvelope["kind"] {
	switch (result.kind) {
		case "awaiting_confirmation":
		case "cancelled":
		case "expired":
		case "deferred":
			return "lifecycle";
		case "completed":
			return "result";
		case "failed":
			return "error";
		default:
			return "ack";
	}
}

async function enqueueDeferredPipelineResult(opts: {
	outbox: ControlPlaneOutbox;
	result: CommandPipelineResult;
	nowMs: number;
	metadata?: Record<string, unknown>;
}): Promise<OutboxRecord | null> {
	const command = commandFromPipelineResult(opts.result);
	if (!command) {
		return null;
	}
	const correlation = correlationFromCommandRecord(command);
	const presented = presentPipelineResultMessage(opts.result);
	const interactionRenderMode = command.channel === "telegram" ? "compact" : "detailed";
	const envelopeBody = interactionRenderMode === "compact" ? presented.compact : presented.detailed;
	const envelope: OutboundEnvelope = {
		v: 1,
		ts_ms: opts.nowMs,
		channel: command.channel,
		channel_tenant_id: command.channel_tenant_id,
		channel_conversation_id: command.channel_conversation_id,
		request_id: command.request_id,
		response_id: `resp-${sha256Hex(`${command.command_id}:${command.state}:${opts.nowMs}`).slice(0, 20)}`,
		kind: outboundKindForPipelineResult(opts.result),
		body: envelopeBody,
		correlation,
		metadata: {
			pipeline_result_kind: opts.result.kind,
			interaction_contract_version: presented.message.v,
			interaction_message: presented.message,
			interaction_render_mode: interactionRenderMode,
			...(opts.metadata ?? {}),
		},
	};
	const dedupeKey = `${command.channel}:${command.command_id}:${opts.result.kind}:${command.state}`;
	const decision = await opts.outbox.enqueue({
		dedupeKey,
		envelope,
		nowMs: opts.nowMs,
	});
	return decision.record;
}

async function enqueueTelegramOperatorResponse(opts: {
	outbox: ControlPlaneOutbox;
	inbound: InboundEnvelope;
	result: Extract<CommandPipelineResult, { kind: "operator_response" }>;
	nowMs: number;
	metadata?: Record<string, unknown>;
}): Promise<OutboxRecord | null> {
	const message = opts.result.message.trim();
	if (message.length === 0) {
		return null;
	}

	const syntheticCommandId = `op-${sha256Hex(opts.inbound.request_id).slice(0, 24)}`;
	const presented = presentPipelineResultMessage(opts.result);
	const envelope: OutboundEnvelope = {
		v: 1,
		ts_ms: opts.nowMs,
		channel: opts.inbound.channel,
		channel_tenant_id: opts.inbound.channel_tenant_id,
		channel_conversation_id: opts.inbound.channel_conversation_id,
		request_id: opts.inbound.request_id,
		response_id: `resp-${sha256Hex(`${opts.inbound.request_id}:operator:${opts.nowMs}`).slice(0, 20)}`,
		kind: "result",
		body: message,
		correlation: {
			command_id: syntheticCommandId,
			idempotency_key: opts.inbound.idempotency_key,
			request_id: opts.inbound.request_id,
			channel: opts.inbound.channel,
			channel_tenant_id: opts.inbound.channel_tenant_id,
			channel_conversation_id: opts.inbound.channel_conversation_id,
			actor_id: opts.inbound.actor_id,
			actor_binding_id: opts.inbound.actor_binding_id,
			assurance_tier: opts.inbound.assurance_tier,
			repo_root: opts.inbound.repo_root,
			scope_required: opts.inbound.scope_required,
			scope_effective: opts.inbound.scope_effective,
			target_type: "operator_chat",
			target_id: opts.inbound.target_id,
			attempt: 1,
			state: "completed",
			error_code: null,
			operator_session_id: null,
			operator_turn_id: null,
			cli_invocation_id: null,
			cli_command_kind: null,
			run_root_id: null,
		},
		metadata: {
			pipeline_result_kind: opts.result.kind,
			interaction_contract_version: presented.message.v,
			interaction_message: presented.message,
			interaction_render_mode: "chat_plain",
			...(opts.metadata ?? {}),
		},
	};

	const dedupeKey = `telegram:operator:${opts.inbound.request_id}`;
	const decision = await opts.outbox.enqueue({
		dedupeKey,
		envelope,
		nowMs: opts.nowMs,
	});
	return decision.record;
}

type AdapterPipelineDispatchResult = {
	pipelineResult: CommandPipelineResult;
	outboxRecord: OutboxRecord | null;
	ackText: string;
};

async function runPipelineForInbound(opts: {
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	inbound: InboundEnvelope;
	nowMs: number;
	metadata?: Record<string, unknown>;
}): Promise<AdapterPipelineDispatchResult> {
	const pipelineResult = await opts.pipeline.handleInbound(opts.inbound);
	let outboxRecord = await enqueueDeferredPipelineResult({
		outbox: opts.outbox,
		result: pipelineResult,
		nowMs: opts.nowMs,
		metadata: opts.metadata,
	});

	if (!outboxRecord && opts.inbound.channel === "telegram" && pipelineResult.kind === "operator_response") {
		outboxRecord = await enqueueTelegramOperatorResponse({
			outbox: opts.outbox,
			inbound: opts.inbound,
			result: pipelineResult,
			nowMs: opts.nowMs,
			metadata: opts.metadata,
		});
	}

	return {
		pipelineResult,
		outboxRecord,
		ackText: formatAdapterAckMessage(pipelineResult, {
			deferred: outboxRecord != null,
		}),
	};
}

function rejectedIngressResult(opts: { channel: Channel; reason: string; response: Response }): AdapterIngressResult {
	return {
		channel: opts.channel,
		accepted: false,
		reason: opts.reason,
		response: opts.response,
		inbound: null,
		pipelineResult: null,
		outboxRecord: null,
		auditEntry: null,
	};
}

function acceptedIngressResult(opts: {
	channel: Channel;
	response: Response;
	inbound: InboundEnvelope | null;
	pipelineResult: CommandPipelineResult | null;
	outboxRecord: OutboxRecord | null;
	reason?: string;
}): AdapterIngressResult {
	return {
		channel: opts.channel,
		accepted: true,
		reason: opts.reason,
		response: opts.response,
		inbound: opts.inbound,
		pipelineResult: opts.pipelineResult,
		outboxRecord: opts.outboxRecord,
		auditEntry: null,
	};
}

export const SlackControlPlaneAdapterSpec = ControlPlaneAdapterSpecSchema.parse({
	channel: "slack",
	route: defaultWebhookRouteForChannel("slack"),
	ingress_payload: "form_urlencoded",
	verification: {
		kind: "hmac_sha256",
		signature_header: "x-slack-signature",
		timestamp_header: "x-slack-request-timestamp",
		signature_prefix: "v0",
		max_clock_skew_sec: 5 * 60,
	},
	ack_format: "slack_ephemeral_json",
	deferred_delivery: true,
});

export const DiscordControlPlaneAdapterSpec = ControlPlaneAdapterSpecSchema.parse({
	channel: "discord",
	route: defaultWebhookRouteForChannel("discord"),
	ingress_payload: "json",
	verification: {
		kind: "hmac_sha256",
		signature_header: "x-discord-signature",
		timestamp_header: "x-discord-request-timestamp",
		signature_prefix: "v1",
		max_clock_skew_sec: 5 * 60,
	},
	ack_format: "discord_ephemeral_json",
	deferred_delivery: true,
});

export const TelegramControlPlaneAdapterSpec = ControlPlaneAdapterSpecSchema.parse({
	channel: "telegram",
	route: defaultWebhookRouteForChannel("telegram"),
	ingress_payload: "json",
	verification: {
		kind: "shared_secret_header",
		secret_header: "x-telegram-bot-api-secret-token",
	},
	ack_format: "telegram_ok_json",
	deferred_delivery: true,
});

export const CONTROL_PLANE_CHANNEL_ADAPTER_SPECS = [
	SlackControlPlaneAdapterSpec,
	DiscordControlPlaneAdapterSpec,
	TelegramControlPlaneAdapterSpec,
] as const;

export type SlackControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	signingSecret: string;
	nowMs?: () => number;
	allowedTimestampSkewSec?: number;
};

function verifySlackRequest(
	req: Request,
	rawBody: string,
	opts: Pick<SlackControlPlaneAdapterOpts, "signingSecret" | "allowedTimestampSkewSec" | "nowMs">,
): { ok: true } | { ok: false; status: number; reason: string } {
	const timestamp = req.headers.get("x-slack-request-timestamp");
	const signature = req.headers.get("x-slack-signature");
	if (!timestamp || !signature) {
		return { ok: false, status: 401, reason: "missing_slack_signature" };
	}

	const parsedTimestamp = Number.parseInt(timestamp, 10);
	if (!Number.isFinite(parsedTimestamp)) {
		return { ok: false, status: 401, reason: "invalid_slack_timestamp" };
	}

	const nowS = Math.trunc((opts.nowMs?.() ?? Date.now()) / 1000);
	const skewSec = Math.max(1, Math.trunc(opts.allowedTimestampSkewSec ?? 5 * 60));
	if (Math.abs(nowS - parsedTimestamp) > skewSec) {
		return { ok: false, status: 401, reason: "stale_slack_timestamp" };
	}

	const expected = `v0=${hmacSha256Hex(opts.signingSecret, `v0:${timestamp}:${rawBody}`)}`;
	if (!timingSafeEqualUtf8(expected, signature)) {
		return { ok: false, status: 401, reason: "invalid_slack_signature" };
	}

	return { ok: true };
}

export class SlackControlPlaneAdapter implements ControlPlaneAdapter {
	public readonly spec = SlackControlPlaneAdapterSpec;
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #outbox: ControlPlaneOutbox;
	readonly #signingSecret: string;
	readonly #nowMs: () => number;
	readonly #allowedTimestampSkewSec: number;

	public constructor(opts: SlackControlPlaneAdapterOpts) {
		this.#pipeline = opts.pipeline;
		this.#outbox = opts.outbox;
		this.#signingSecret = opts.signingSecret;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#allowedTimestampSkewSec = Math.max(1, Math.trunc(opts.allowedTimestampSkewSec ?? 5 * 60));
	}

	public async ingest(req: Request): Promise<AdapterIngressResult> {
		if (req.method !== "POST") {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "method_not_allowed",
				response: textResponse("method not allowed", { status: 405 }),
			});
		}

		const rawBody = await req.text();
		const verified = verifySlackRequest(req, rawBody, {
			signingSecret: this.#signingSecret,
			allowedTimestampSkewSec: this.#allowedTimestampSkewSec,
			nowMs: this.#nowMs,
		});
		if (!verified.ok) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: verified.reason,
				response: textResponse(verified.reason, { status: verified.status }),
			});
		}

		const form = new URLSearchParams(rawBody);
		const teamId = form.get("team_id") ?? "unknown-team";
		const channelId = form.get("channel_id") ?? "unknown-channel";
		const actorId = form.get("user_id") ?? "unknown-user";
		const command = form.get("command") ?? "/mu";
		const text = form.get("text") ?? "";
		const triggerId = form.get("trigger_id") ?? form.get("command_ts") ?? sha256Hex(rawBody).slice(0, 24);
		const normalizedText = normalizeSlashMuCommand(command === "/mu" ? text : `${command} ${text}`);
		const stableSource = `${teamId}:${channelId}:${actorId}:${triggerId}:${normalizedText}`;
		const stableId = sha256Hex(stableSource).slice(0, 32);
		const requestIdHeader = req.headers.get("x-slack-request-id");
		const requestId =
			requestIdHeader && requestIdHeader.trim().length > 0
				? `slack-req-${requestIdHeader.trim()}`
				: `slack-req-${stableId}`;
		const deliveryId = `slack-delivery-${stableId}`;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, teamId, actorId);
		const nowMs = Math.trunc(this.#nowMs());

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: this.spec.channel,
			channel_tenant_id: teamId,
			channel_conversation_id: channelId,
			actor_id: actorId,
			actor_binding_id: bindingHint.actorBindingId,
			assurance_tier: bindingHint.assuranceTier,
			repo_root: this.#pipeline.runtime.paths.repoRoot,
			command_text: normalizedText,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: channelId,
			idempotency_key: `slack-idem-${stableId}`,
			fingerprint: `slack-fp-${sha256Hex(normalizedText.toLowerCase())}`,
			metadata: {
				adapter: this.spec.channel,
				response_url: form.get("response_url"),
				trigger_id: triggerId,
			},
		});

		const dispatched = await runPipelineForInbound({
			pipeline: this.#pipeline,
			outbox: this.#outbox,
			inbound,
			nowMs,
			metadata: {
				adapter: this.spec.channel,
				response_url: form.get("response_url"),
				delivery_id: deliveryId,
			},
		});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({ response_type: "ephemeral", text: dispatched.ackText }, { status: 200 }),
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}
}

export type DiscordControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	signingSecret: string;
	nowMs?: () => number;
	allowedTimestampSkewSec?: number;
};

function verifyDiscordRequest(
	req: Request,
	rawBody: string,
	opts: Pick<DiscordControlPlaneAdapterOpts, "signingSecret" | "allowedTimestampSkewSec" | "nowMs">,
): { ok: true } | { ok: false; status: number; reason: string } {
	const timestamp = req.headers.get("x-discord-request-timestamp");
	const signature = req.headers.get("x-discord-signature");
	if (!timestamp || !signature) {
		return { ok: false, status: 401, reason: "missing_discord_signature" };
	}

	const parsedTimestamp = Number.parseInt(timestamp, 10);
	if (!Number.isFinite(parsedTimestamp)) {
		return { ok: false, status: 401, reason: "invalid_discord_timestamp" };
	}

	const nowS = Math.trunc((opts.nowMs?.() ?? Date.now()) / 1000);
	const skewSec = Math.max(1, Math.trunc(opts.allowedTimestampSkewSec ?? 5 * 60));
	if (Math.abs(nowS - parsedTimestamp) > skewSec) {
		return { ok: false, status: 401, reason: "stale_discord_timestamp" };
	}

	const expected = `v1=${hmacSha256Hex(opts.signingSecret, `v1:${timestamp}:${rawBody}`)}`;
	if (!timingSafeEqualUtf8(expected, signature)) {
		return { ok: false, status: 401, reason: "invalid_discord_signature" };
	}

	return { ok: true };
}

export class DiscordControlPlaneAdapter implements ControlPlaneAdapter {
	public readonly spec = DiscordControlPlaneAdapterSpec;
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #outbox: ControlPlaneOutbox;
	readonly #signingSecret: string;
	readonly #nowMs: () => number;
	readonly #allowedTimestampSkewSec: number;

	public constructor(opts: DiscordControlPlaneAdapterOpts) {
		this.#pipeline = opts.pipeline;
		this.#outbox = opts.outbox;
		this.#signingSecret = opts.signingSecret;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#allowedTimestampSkewSec = Math.max(1, Math.trunc(opts.allowedTimestampSkewSec ?? 5 * 60));
	}

	public async ingest(req: Request): Promise<AdapterIngressResult> {
		if (req.method !== "POST") {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "method_not_allowed",
				response: textResponse("method not allowed", { status: 405 }),
			});
		}

		const rawBody = await req.text();
		const verified = verifyDiscordRequest(req, rawBody, {
			signingSecret: this.#signingSecret,
			allowedTimestampSkewSec: this.#allowedTimestampSkewSec,
			nowMs: this.#nowMs,
		});
		if (!verified.ok) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: verified.reason,
				response: textResponse(verified.reason, { status: verified.status }),
			});
		}

		let payload: Record<string, any>;
		try {
			payload = JSON.parse(rawBody) as Record<string, any>;
		} catch {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_json",
				response: textResponse("invalid_json", { status: 400 }),
			});
		}

		if (payload.type === 1) {
			return acceptedIngressResult({
				channel: this.spec.channel,
				response: jsonResponse({ type: 1 }, { status: 200 }),
				inbound: null,
				pipelineResult: null,
				outboxRecord: null,
			});
		}

		const interactionId =
			typeof payload.id === "string" && payload.id.length > 0 ? payload.id : sha256Hex(rawBody).slice(0, 24);
		const channelId = typeof payload.channel_id === "string" ? payload.channel_id : "unknown-channel";
		const guildId = typeof payload.guild_id === "string" ? payload.guild_id : "dm";
		const actorId =
			typeof payload.member?.user?.id === "string"
				? payload.member.user.id
				: typeof payload.user?.id === "string"
					? payload.user.id
					: "unknown-user";
		const dataName = typeof payload.data?.name === "string" ? payload.data.name : "mu";
		const rawText =
			typeof payload.data?.text === "string"
				? payload.data.text
				: typeof payload.text === "string"
					? payload.text
					: "";
		if (dataName !== "mu") {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "unsupported_discord_command",
				response: jsonResponse({ type: 4, data: { content: "unsupported_discord_command" } }, { status: 200 }),
			});
		}

		const normalizedText = normalizeSlashMuCommand(rawText);
		const stableId = sha256Hex(`${interactionId}:${guildId}:${channelId}:${actorId}:${normalizedText}`).slice(0, 32);
		const requestId = `discord-req-${interactionId}`;
		const deliveryId = `discord-delivery-${stableId}`;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, guildId, actorId);
		const nowMs = Math.trunc(this.#nowMs());

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: this.spec.channel,
			channel_tenant_id: guildId,
			channel_conversation_id: channelId,
			actor_id: actorId,
			actor_binding_id: bindingHint.actorBindingId,
			assurance_tier: bindingHint.assuranceTier,
			repo_root: this.#pipeline.runtime.paths.repoRoot,
			command_text: normalizedText,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: channelId,
			idempotency_key: `discord-idem-${stableId}`,
			fingerprint: `discord-fp-${sha256Hex(normalizedText.toLowerCase())}`,
			metadata: {
				adapter: this.spec.channel,
				interaction_id: interactionId,
				interaction_token: payload.token,
			},
		});

		const dispatched = await runPipelineForInbound({
			pipeline: this.#pipeline,
			outbox: this.#outbox,
			inbound,
			nowMs,
			metadata: {
				adapter: this.spec.channel,
				interaction_id: interactionId,
				delivery_id: deliveryId,
			},
		});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({ type: 4, data: { content: dispatched.ackText, flags: 64 } }, { status: 200 }),
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}
}

export type TelegramControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	webhookSecret: string;
	tenantId?: string;
	botUsername?: string | null;
	nowMs?: () => number;
};

export class TelegramControlPlaneAdapter implements ControlPlaneAdapter {
	public readonly spec = TelegramControlPlaneAdapterSpec;
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #outbox: ControlPlaneOutbox;
	readonly #webhookSecret: string;
	readonly #tenantId: string;
	readonly #botUsername: string | null;
	readonly #nowMs: () => number;

	public constructor(opts: TelegramControlPlaneAdapterOpts) {
		this.#pipeline = opts.pipeline;
		this.#outbox = opts.outbox;
		this.#webhookSecret = opts.webhookSecret;
		this.#tenantId = opts.tenantId ?? "telegram-bot";
		this.#botUsername = opts.botUsername?.trim().replace(/^@/, "") || null;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	#verifyRequest(req: Request): { ok: true } | { ok: false; status: number; reason: string } {
		const token = req.headers.get("x-telegram-bot-api-secret-token");
		if (!token) {
			return { ok: false, status: 401, reason: "missing_telegram_secret_token" };
		}
		if (!timingSafeEqualUtf8(this.#webhookSecret, token)) {
			return { ok: false, status: 401, reason: "invalid_telegram_secret_token" };
		}
		return { ok: true };
	}

	public async ingest(req: Request): Promise<AdapterIngressResult> {
		if (req.method !== "POST") {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "method_not_allowed",
				response: textResponse("method not allowed", { status: 405 }),
			});
		}

		const verified = this.#verifyRequest(req);
		if (!verified.ok) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: verified.reason,
				response: textResponse(verified.reason, { status: verified.status }),
			});
		}

		let payload: Record<string, unknown>;
		try {
			payload = (await req.json()) as Record<string, unknown>;
		} catch {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_json",
				response: textResponse("invalid_json", { status: 400 }),
			});
		}

		const updateId = stringId(payload.update_id);
		if (!updateId) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_update_id",
				response: textResponse("invalid_update_id", { status: 400 }),
			});
		}

		const callbackQuery = payload.callback_query as Record<string, unknown> | undefined;
		const message = payload.message as Record<string, unknown> | undefined;

		let actorId = "unknown-user";
		let conversationId = "unknown-chat";
		let commandText = "";
		let sourceKind: "update" | "callback" = "update";
		let sourceId = updateId;
		const metadata: Record<string, unknown> = { adapter: this.spec.channel, update_id: updateId };

		if (callbackQuery) {
			sourceKind = "callback";
			sourceId = stringId(callbackQuery.id) ?? updateId;
			const callbackData = typeof callbackQuery.data === "string" ? callbackQuery.data : "";
			const normalized = normalizeTelegramCallbackData(callbackData);
			if (!normalized) {
				return rejectedIngressResult({
					channel: this.spec.channel,
					reason: "unsupported_telegram_callback",
					response: jsonResponse({ ok: true, result: "unsupported_telegram_callback" }, { status: 200 }),
				});
			}
			commandText = normalized;
			actorId = stringId((callbackQuery.from as Record<string, unknown> | undefined)?.id) ?? actorId;
			conversationId =
				stringId(
					(
						(callbackQuery.message as Record<string, unknown> | undefined)?.chat as
							| Record<string, unknown>
							| undefined
					)?.id,
				) ?? conversationId;
			metadata.callback_query_id = sourceId;
			metadata.callback_data = callbackData;
			metadata.message_id = stringId((callbackQuery.message as Record<string, unknown> | undefined)?.message_id);
		} else if (message) {
			actorId = stringId((message.from as Record<string, unknown> | undefined)?.id) ?? actorId;
			conversationId = stringId((message.chat as Record<string, unknown> | undefined)?.id) ?? conversationId;
			const rawText = typeof message.text === "string" ? message.text : "";
			commandText = normalizeTelegramMessageCommand(rawText, this.#botUsername);
			metadata.message_id = stringId(message.message_id);
			metadata.chat_type = (message.chat as Record<string, unknown> | undefined)?.type ?? null;
		} else {
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "unsupported_update",
				response: jsonResponse({ ok: true, result: "ignored_unsupported_update" }, { status: 200 }),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "not_command" },
				outboxRecord: null,
			});
		}

		const source = `telegram:${sourceKind}:${sourceId}`;
		const stableId = sha256Hex(source).slice(0, 32);
		const requestId = `telegram-req-${stableId}`;
		const deliveryId = `telegram-delivery-${stableId}`;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, this.#tenantId, actorId);
		const nowMs = Math.trunc(this.#nowMs());
		const normalizedCommandText = commandText.length > 0 ? commandText : "/mu";

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: this.spec.channel,
			channel_tenant_id: this.#tenantId,
			channel_conversation_id: conversationId,
			actor_id: actorId,
			actor_binding_id: bindingHint.actorBindingId,
			assurance_tier: bindingHint.assuranceTier,
			repo_root: this.#pipeline.runtime.paths.repoRoot,
			command_text: normalizedCommandText,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: conversationId,
			idempotency_key: `telegram-idem-${sourceKind}-${sourceId}`,
			fingerprint: `telegram-fp-${sha256Hex(normalizedCommandText.toLowerCase())}`,
			metadata,
		});

		const dispatched = await runPipelineForInbound({
			pipeline: this.#pipeline,
			outbox: this.#outbox,
			inbound,
			nowMs,
			metadata: {
				adapter: this.spec.channel,
				source,
				delivery_id: deliveryId,
			},
		});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({ ok: true, result: dispatched.ackText }, { status: 200 }),
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}
}
