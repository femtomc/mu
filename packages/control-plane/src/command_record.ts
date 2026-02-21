import { z } from "zod";
import {
	assertValidTransition,
	type CommandState,
	CommandStateSchema,
	isTerminalCommandState,
} from "./command_state.js";
import {
	AssuranceTierSchema,
	type CorrelationMetadata,
	CorrelationMetadataSchema,
	type InboundEnvelope,
	InboundEnvelopeSchema,
} from "./models.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const CommandRecordSchema = z.object({
	command_id: z.string().min(1),
	idempotency_key: z.string().min(1),
	fingerprint: z.string().min(1),
	request_id: z.string().min(1),
	channel: z.string().min(1),
	channel_tenant_id: z.string().min(1),
	channel_conversation_id: z.string().min(1),
	actor_id: z.string().min(1),
	actor_binding_id: z.string().min(1),
	assurance_tier: AssuranceTierSchema,
	repo_root: z.string().min(1),
	scope_required: z.string().min(1),
	scope_effective: z.string().min(1),
	target_type: z.string().min(1),
	target_id: z.string().min(1),
	command_text: z.string().min(1).nullable().default(null),
	command_args: z.array(z.string().min(1)).default([]),
	state: CommandStateSchema,
	attempt: z.number().int().nonnegative(),
	created_at_ms: z.number().int(),
	updated_at_ms: z.number().int(),
	confirmation_expires_at_ms: z.number().int().nullable().default(null),
	retry_at_ms: z.number().int().nullable().default(null),
	terminal_at_ms: z.number().int().nullable().default(null),
	error_code: z.string().nullable().default(null),
	operator_session_id: z.string().min(1).nullable().default(null),
	operator_turn_id: z.string().min(1).nullable().default(null),
	cli_invocation_id: z.string().min(1).nullable().default(null),
	cli_command_kind: z.string().min(1).nullable().default(null),
	result: JsonObjectSchema.nullable().default(null),
	replay_of: z.string().nullable().default(null),
});
export type CommandRecord = z.infer<typeof CommandRecordSchema>;

export type CreateAcceptedCommandRecordOpts = {
	commandId: string;
	inbound: InboundEnvelope;
	nowMs?: number;
	confirmationExpiresAtMs?: number | null;
	replayOf?: string | null;
	operatorSessionId?: string | null;
	operatorTurnId?: string | null;
	cliInvocationId?: string | null;
	cliCommandKind?: string | null;
};

function splitTokens(value: string): string[] {
	return value
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function extractCommandArgs(commandText: string, commandKey: string): string[] {
	const allTokens = splitTokens(commandText);
	if (allTokens.length === 0) {
		return [];
	}

	const invocationPrefix = allTokens[0]?.toLowerCase();
	const normalizedTokens =
		invocationPrefix === "/mu" || invocationPrefix === "mu!" || invocationPrefix === "mu?"
			? allTokens.slice(1)
			: allTokens;
	if (normalizedTokens.length === 0) {
		return [];
	}

	const keyTokens = splitTokens(commandKey.toLowerCase());
	const lowerTokens = normalizedTokens.map((token) => token.toLowerCase());
	const startsWithCommandKey =
		keyTokens.length <= lowerTokens.length && keyTokens.every((keyToken, idx) => lowerTokens[idx] === keyToken);
	if (!startsWithCommandKey) {
		return [];
	}

	return normalizedTokens.slice(keyTokens.length);
}

export function createAcceptedCommandRecord(opts: CreateAcceptedCommandRecordOpts): CommandRecord {
	const inbound = InboundEnvelopeSchema.parse(opts.inbound);
	const nowMs = Math.trunc(opts.nowMs ?? Date.now());
	return CommandRecordSchema.parse({
		command_id: opts.commandId,
		idempotency_key: inbound.idempotency_key,
		fingerprint: inbound.fingerprint,
		request_id: inbound.request_id,
		channel: inbound.channel,
		channel_tenant_id: inbound.channel_tenant_id,
		channel_conversation_id: inbound.channel_conversation_id,
		actor_id: inbound.actor_id,
		actor_binding_id: inbound.actor_binding_id,
		assurance_tier: inbound.assurance_tier,
		repo_root: inbound.repo_root,
		scope_required: inbound.scope_required,
		scope_effective: inbound.scope_effective,
		target_type: inbound.target_type,
		target_id: inbound.target_id,
		command_text: inbound.command_text,
		command_args: extractCommandArgs(inbound.command_text, inbound.target_type),
		state: "accepted",
		attempt: 0,
		created_at_ms: nowMs,
		updated_at_ms: nowMs,
		confirmation_expires_at_ms: opts.confirmationExpiresAtMs ?? null,
		retry_at_ms: null,
		terminal_at_ms: null,
		error_code: null,
		operator_session_id: opts.operatorSessionId ?? null,
		operator_turn_id: opts.operatorTurnId ?? null,
		cli_invocation_id: opts.cliInvocationId ?? null,
		cli_command_kind: opts.cliCommandKind ?? null,
		result: null,
		replay_of: opts.replayOf ?? null,
	});
}

export function correlationFromCommandRecord(record: CommandRecord): CorrelationMetadata {
	const parsed = CommandRecordSchema.parse(record);
	return CorrelationMetadataSchema.parse({
		command_id: parsed.command_id,
		idempotency_key: parsed.idempotency_key,
		request_id: parsed.request_id,
		channel: parsed.channel,
		channel_tenant_id: parsed.channel_tenant_id,
		channel_conversation_id: parsed.channel_conversation_id,
		actor_id: parsed.actor_id,
		actor_binding_id: parsed.actor_binding_id,
		assurance_tier: parsed.assurance_tier,
		repo_root: parsed.repo_root,
		scope_required: parsed.scope_required,
		scope_effective: parsed.scope_effective,
		target_type: parsed.target_type,
		target_id: parsed.target_id,
		attempt: parsed.attempt,
		state: parsed.state,
		error_code: parsed.error_code ?? null,
		operator_session_id: parsed.operator_session_id ?? null,
		operator_turn_id: parsed.operator_turn_id ?? null,
		cli_invocation_id: parsed.cli_invocation_id ?? null,
		cli_command_kind: parsed.cli_command_kind ?? null,
	});
}

export type TransitionCommandRecordOpts = {
	nextState: CommandState;
	nowMs?: number;
	attempt?: number;
	retryAtMs?: number | null;
	confirmationExpiresAtMs?: number | null;
	errorCode?: string | null;
	result?: Record<string, unknown> | null;
	operatorSessionId?: string | null;
	operatorTurnId?: string | null;
	cliInvocationId?: string | null;
	cliCommandKind?: string | null;
};

export type CommandRecordTraceUpdate = {
	operatorSessionId?: string | null;
	operatorTurnId?: string | null;
	cliInvocationId?: string | null;
	cliCommandKind?: string | null;
};

export function applyCommandRecordTrace(record: CommandRecord, update: CommandRecordTraceUpdate = {}): CommandRecord {
	return CommandRecordSchema.parse({
		...record,
		operator_session_id: update.operatorSessionId !== undefined ? update.operatorSessionId : record.operator_session_id,
		operator_turn_id: update.operatorTurnId !== undefined ? update.operatorTurnId : record.operator_turn_id,
		cli_invocation_id: update.cliInvocationId !== undefined ? update.cliInvocationId : record.cli_invocation_id,
		cli_command_kind: update.cliCommandKind !== undefined ? update.cliCommandKind : record.cli_command_kind,
	});
}

export function transitionCommandRecord(record: CommandRecord, opts: TransitionCommandRecordOpts): CommandRecord {
	const current = CommandRecordSchema.parse(record);
	assertValidTransition(current.state, opts.nextState);

	const nowMs = Math.trunc(opts.nowMs ?? Date.now());
	const nextAttempt = opts.attempt ?? (opts.nextState === "in_progress" ? current.attempt + 1 : current.attempt);

	const next: CommandRecord = {
		...current,
		state: opts.nextState,
		attempt: nextAttempt,
		updated_at_ms: nowMs,
		retry_at_ms: opts.retryAtMs !== undefined ? opts.retryAtMs : current.retry_at_ms,
		confirmation_expires_at_ms:
			opts.confirmationExpiresAtMs !== undefined ? opts.confirmationExpiresAtMs : current.confirmation_expires_at_ms,
		error_code: opts.errorCode !== undefined ? opts.errorCode : current.error_code,
		operator_session_id: opts.operatorSessionId !== undefined ? opts.operatorSessionId : current.operator_session_id,
		operator_turn_id: opts.operatorTurnId !== undefined ? opts.operatorTurnId : current.operator_turn_id,
		cli_invocation_id: opts.cliInvocationId !== undefined ? opts.cliInvocationId : current.cli_invocation_id,
		cli_command_kind: opts.cliCommandKind !== undefined ? opts.cliCommandKind : current.cli_command_kind,
		result: opts.result !== undefined ? opts.result : current.result,
		terminal_at_ms: isTerminalCommandState(opts.nextState) ? nowMs : current.terminal_at_ms,
	};

	if (opts.nextState === "completed" && opts.errorCode === undefined) {
		next.error_code = null;
	}
	if (opts.nextState === "deferred" && opts.retryAtMs === undefined) {
		next.retry_at_ms = current.retry_at_ms;
	}

	return CommandRecordSchema.parse(next);
}
