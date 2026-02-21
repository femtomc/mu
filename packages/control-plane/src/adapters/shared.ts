import type { AdapterIngressResult } from "../adapter_contract.js";
import type { CommandPipelineResult, ControlPlaneCommandPipeline } from "../command_pipeline.js";
import { type CommandRecord, correlationFromCommandRecord } from "../command_record.js";
import type { CommandState } from "../command_state.js";
import { assuranceTierForChannel, type Channel, ChannelSchema } from "../identity_store.js";
import { formatAdapterAckMessage, presentPipelineResultMessage } from "../interaction_contract.js";
import { type AssuranceTier, type InboundEnvelope, type OutboundEnvelope } from "../models.js";
import type { ControlPlaneOutbox, OutboxRecord } from "../outbox.js";

export function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

export function hmacSha256Hex(secret: string, input: string): string {
	const hasher = new Bun.CryptoHasher("sha256", secret);
	hasher.update(input);
	return hasher.digest("hex");
}

export function timingSafeEqualUtf8(a: string, b: string): boolean {
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

export function copyHeaders(initHeaders: unknown): Headers {
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

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	const headers = copyHeaders(init.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "application/json; charset=utf-8");
	}
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function textResponse(text: string, init: ResponseInit = {}): Response {
	const headers = copyHeaders(init.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "text/plain; charset=utf-8");
	}
	return new Response(text, { ...init, headers });
}

export function normalizeSlashMuCommand(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("/mu")) {
		return trimmed;
	}
	if (trimmed.length === 0) {
		return "/mu";
	}
	return `/mu ${trimmed}`;
}

export function stringId(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(Math.trunc(value));
	}
	return null;
}

export function resolveAssuranceFallback(channel: string): AssuranceTier {
	const parsed = ChannelSchema.safeParse(channel);
	if (!parsed.success) {
		return "tier_c";
	}
	return assuranceTierForChannel(parsed.data);
}

export function resolveBindingHint(
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

export function commandFromPipelineResult(result: CommandPipelineResult): CommandRecord | null {
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

export function outboundKindForPipelineResult(result: CommandPipelineResult): OutboundEnvelope["kind"] {
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

export function pipelineResultErrorCode(result: CommandPipelineResult): string | null {
	switch (result.kind) {
		case "denied":
		case "invalid":
		case "noop":
			return result.reason;
		case "failed":
			return result.reason;
		default:
			return null;
	}
}

export function syntheticStateForPipelineResult(result: CommandPipelineResult): CommandState {
	switch (result.kind) {
		case "awaiting_confirmation":
			return "awaiting_confirmation";
		case "deferred":
			return "deferred";
		case "cancelled":
			return "cancelled";
		case "expired":
			return "expired";
		case "failed":
		case "denied":
		case "invalid":
			return "failed";
		default:
			return "completed";
	}
}

export async function enqueueFallbackPipelineResult(opts: {
	outbox: ControlPlaneOutbox;
	inbound: InboundEnvelope;
	result: CommandPipelineResult;
	nowMs: number;
	metadata?: Record<string, unknown>;
}): Promise<OutboxRecord | null> {
	const presented = presentPipelineResultMessage(opts.result);
	const syntheticState = syntheticStateForPipelineResult(opts.result);
	const syntheticCommandId = `fb-${sha256Hex(opts.inbound.request_id).slice(0, 24)}`;
	const envelope: OutboundEnvelope = {
		v: 1,
		ts_ms: opts.nowMs,
		channel: opts.inbound.channel,
		channel_tenant_id: opts.inbound.channel_tenant_id,
		channel_conversation_id: opts.inbound.channel_conversation_id,
		request_id: opts.inbound.request_id,
		response_id: `resp-${sha256Hex(`${opts.inbound.request_id}:fallback:${opts.nowMs}`).slice(0, 20)}`,
		kind: outboundKindForPipelineResult(opts.result),
		body: presented.compact,
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
			target_type: opts.inbound.target_type,
			target_id: opts.inbound.target_id,
			attempt: 1,
			state: syntheticState,
			error_code: pipelineResultErrorCode(opts.result),
			operator_session_id: null,
			operator_turn_id: null,
			cli_invocation_id: null,
			cli_command_kind: null,
		},
		metadata: {
			pipeline_result_kind: opts.result.kind,
			interaction_contract_version: presented.message.v,
			interaction_message: presented.message,
			interaction_render_mode: "compact",
			synthetic_correlation: true,
			...(opts.metadata ?? {}),
		},
	};

	const dedupeKey = `fallback:${opts.inbound.channel}:${opts.inbound.request_id}`;
	const decision = await opts.outbox.enqueue({
		dedupeKey,
		envelope,
		nowMs: opts.nowMs,
	});
	return decision.record;
}

export async function enqueueDeferredPipelineResult(opts: {
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

export async function enqueueTelegramOperatorResponse(opts: {
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

export type AdapterPipelineDispatchResult = {
	pipelineResult: CommandPipelineResult;
	outboxRecord: OutboxRecord | null;
	ackText: string;
};

export async function runPipelineForInbound(opts: {
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	inbound: InboundEnvelope;
	nowMs: number;
	metadata?: Record<string, unknown>;
	forceOutbox?: boolean;
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

	if (!outboxRecord && opts.forceOutbox) {
		outboxRecord = await enqueueFallbackPipelineResult({
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

export function rejectedIngressResult(opts: { channel: Channel; reason: string; response: Response }): AdapterIngressResult {
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

export function acceptedIngressResult(opts: {
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
