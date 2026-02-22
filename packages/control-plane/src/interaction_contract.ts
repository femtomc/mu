import { z } from "zod";
import type { CommandPipelineResult } from "./command_pipeline.js";
import type { CommandRecord } from "./command_record.js";

/**
 * Interaction contract + style guide.
 *
 * Prior control-plane responses were ad-hoc plain strings (for example `state: completed`)
 * that omitted stable speaker/intent/state semantics. This module centralizes:
 *
 * - deterministic message structure for user/operator/mu/tool updates and errors
 * - compact + detailed rendering modes (summary-first with expandable payload detail)
 * - stable JSON serialization for payload metadata
 */

export const CONTROL_PLANE_INTERACTION_CONTRACT_VERSION = 1;

export const InteractionSpeakerSchema = z.enum(["user", "operator", "mu_system", "mu_tool"]);
export type InteractionSpeaker = z.infer<typeof InteractionSpeakerSchema>;

export const InteractionIntentSchema = z.enum(["chat", "ack", "lifecycle", "result", "error"]);
export type InteractionIntent = z.infer<typeof InteractionIntentSchema>;

export const InteractionStatusSchema = z.enum(["info", "success", "warning", "error"]);
export type InteractionStatus = z.infer<typeof InteractionStatusSchema>;

export const InteractionDetailImportanceSchema = z.enum(["primary", "secondary"]);
export type InteractionDetailImportance = z.infer<typeof InteractionDetailImportanceSchema>;

export const InteractionDetailSchema = z.object({
	key: z.string().min(1),
	label: z.string().min(1),
	value: z.string().min(1),
	importance: InteractionDetailImportanceSchema.default("secondary"),
});
export type InteractionDetail = z.infer<typeof InteractionDetailSchema>;

export const InteractionActionSchema = z.object({
	label: z.string().min(1),
	command: z.string().min(1),
	kind: z.enum(["primary", "secondary"]).default("secondary"),
});
export type InteractionAction = z.infer<typeof InteractionActionSchema>;

export const InteractionTransitionSchema = z.object({
	from: z.string().min(1).nullable().default(null),
	to: z.string().min(1),
});
export type InteractionTransition = z.infer<typeof InteractionTransitionSchema>;

export const ControlPlaneInteractionMessageSchema = z.object({
	v: z.literal(CONTROL_PLANE_INTERACTION_CONTRACT_VERSION).default(CONTROL_PLANE_INTERACTION_CONTRACT_VERSION),
	speaker: InteractionSpeakerSchema,
	intent: InteractionIntentSchema,
	status: InteractionStatusSchema,
	state: z.string().min(1),
	summary: z.string().min(1),
	details: z.array(InteractionDetailSchema).default([]),
	actions: z.array(InteractionActionSchema).default([]),
	transition: InteractionTransitionSchema.nullable().default(null),
	payload: z.record(z.string(), z.unknown()).default({}),
});
export type ControlPlaneInteractionMessage = z.infer<typeof ControlPlaneInteractionMessageSchema>;

export type InteractionRenderMode = "compact" | "detailed";

export type PresentedControlPlaneMessage = {
	message: ControlPlaneInteractionMessage;
	compact: string;
	detailed: string;
};

const SPEAKER_VIEW: Record<InteractionSpeaker, { label: string }> = {
	user: { label: "User" },
	operator: { label: "Operator" },
	mu_system: { label: "mu" },
	mu_tool: { label: "mu tool" },
};

const INTENT_VIEW: Record<InteractionIntent, string> = {
	chat: "CHAT",
	ack: "ACK",
	lifecycle: "LIFECYCLE",
	result: "RESULT",
	error: "ERROR",
};

const STATUS_VIEW: Record<InteractionStatus, string> = {
	info: "INFO",
	success: "OK",
	warning: "WARN",
	error: "ERROR",
};

const REASON_LABELS: Record<string, string> = {
	identity_not_linked: "Identity is not linked to a control-plane binding.",
	missing_scope: "Your linked identity is missing a required scope.",
	unmapped_command: "That command is not mapped in the control-plane policy.",
	idempotency_conflict: "A command with this idempotency key conflicts with a different fingerprint.",
	duplicate_in_flight: "A duplicate command is already in-flight.",
	duplicate_missing_command: "A duplicate command was detected but the original command record is missing.",
	confirmation_not_found: "The referenced confirmation command was not found.",
	confirmation_invalid_actor: "Only the original actor can confirm or cancel this command.",
	confirmation_invalid_state: "That command is no longer awaiting confirmation.",
	operator_disabled: "The messaging operator is disabled for this channel.",
	operator_action_disallowed: "The operator proposed an action that is not allowed.",
	operator_invalid_output: "The operator produced invalid output.",
	context_missing: "Required command context is missing.",
	context_ambiguous: "Command context is ambiguous and needs clarification.",
	context_unauthorized: "Command context is outside authorized scope.",
	cli_validation_failed: "CLI command validation failed before execution.",
	mutations_disabled_global: "Mutations are globally disabled by policy.",
	not_command: "Message did not contain a control-plane command.",
	empty_input: "Message contained no usable input.",
	empty_command: "Command invocation was empty.",
	missing_command_id: "Command id was required but missing.",
};

function truncateLine(value: string, maxLen: number): string {
	if (value.length <= maxLen) {
		return value;
	}
	if (maxLen <= 3) {
		return value.slice(0, maxLen);
	}
	return `${value.slice(0, maxLen - 3)}...`;
}

function stateLabel(value: string): string {
	return value.replace(/[_-]+/g, " ").trim().toUpperCase();
}

function humanizeToken(value: string): string {
	return value.replace(/[_-]+/g, " ").trim();
}

function firstNonEmptyLine(value: string): string {
	for (const line of value.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return "";
}

function formatTimestamp(ms: number | null): string | null {
	if (ms == null || !Number.isFinite(ms)) {
		return null;
	}
	return `${Math.trunc(ms)} (${new Date(ms).toISOString()})`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeJson(entry));
	}
	if (!isPlainObject(value)) {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const nextValue = value[key];
		if (nextValue === undefined) {
			continue;
		}
		out[key] = canonicalizeJson(nextValue);
	}
	return out;
}

export function stableSerializeJson(value: unknown, opts: { pretty?: boolean } = {}): string {
	const normalized = canonicalizeJson(value);
	const text = JSON.stringify(normalized, null, opts.pretty ? 2 : undefined);
	return text ?? "null";
}

export function describeReasonCode(reason: string): string {
	return REASON_LABELS[reason] ?? humanizeToken(reason);
}

function makeDetail(
	key: string,
	label: string,
	value: string,
	importance: InteractionDetailImportance = "secondary",
): InteractionDetail {
	return InteractionDetailSchema.parse({ key, label, value, importance });
}

function maybePushDetail(
	details: InteractionDetail[],
	key: string,
	label: string,
	value: string | number | null,
	importance: InteractionDetailImportance = "secondary",
): void {
	if (value == null) {
		return;
	}
	const normalized = String(value).trim();
	if (normalized.length === 0) {
		return;
	}
	details.push(makeDetail(key, label, normalized, importance));
}

function summarizeCommandTarget(command: CommandRecord): string {
	const target = command.target_id.trim();
	if (target.length === 0) {
		return command.target_type;
	}
	return `${command.target_type} ${target}`;
}

function makeCommandPayload(command: CommandRecord): Record<string, unknown> {
	return {
		command_id: command.command_id,
		state: command.state,
		request_id: command.request_id,
		channel: command.channel,
		channel_conversation_id: command.channel_conversation_id,
		target_type: command.target_type,
		target_id: command.target_id,
		command_text: command.command_text,
		command_args: command.command_args,
		assurance_tier: command.assurance_tier,
		attempt: command.attempt,
		confirmation_expires_at_ms: command.confirmation_expires_at_ms,
		retry_at_ms: command.retry_at_ms,
		error_code: command.error_code,
		operator_session_id: command.operator_session_id,
		operator_turn_id: command.operator_turn_id,
		cli_invocation_id: command.cli_invocation_id,
		cli_command_kind: command.cli_command_kind,
		result: command.result,
	};
}

function baseCommandDetails(command: CommandRecord): InteractionDetail[] {
	const details: InteractionDetail[] = [
		makeDetail("command_id", "Command", command.command_id, "primary"),
		makeDetail("command_target", "Target", summarizeCommandTarget(command), "primary"),
		makeDetail("state", "State", stateLabel(command.state), "secondary"),
		makeDetail("request_id", "Request", command.request_id, "secondary"),
		makeDetail(
			"channel",
			"Channel",
			`${command.channel}:${command.channel_tenant_id}:${command.channel_conversation_id}`,
			"secondary",
		),
	];

	maybePushDetail(details, "command_text", "Command text", command.command_text, "secondary");
	if ((command.command_args?.length ?? 0) > 0) {
		details.push(makeDetail("command_args", "Command args", command.command_args.join(" "), "secondary"));
	}

	const confirmBy = formatTimestamp(command.confirmation_expires_at_ms);
	if (confirmBy) {
		details.push(makeDetail("confirm_by", "Confirm by", confirmBy, "secondary"));
	}
	const retryAt = formatTimestamp(command.retry_at_ms);
	if (retryAt) {
		details.push(makeDetail("retry_at", "Retry at", retryAt, "secondary"));
	}
	maybePushDetail(details, "cli_command_kind", "CLI command", command.cli_command_kind, "secondary");
	maybePushDetail(details, "cli_invocation_id", "CLI invocation", command.cli_invocation_id, "secondary");
	maybePushDetail(details, "operator_session_id", "Operator session", command.operator_session_id, "secondary");
	maybePushDetail(details, "operator_turn_id", "Operator turn", command.operator_turn_id, "secondary");
	maybePushDetail(details, "error_code", "Error code", command.error_code, "secondary");

	if (command.result && Object.keys(command.result).length > 0) {
		details.push(
			makeDetail("result_preview", "Result", truncateLine(stableSerializeJson(command.result), 220), "secondary"),
		);
	}

	return details;
}

export function buildInteractionMessageFromPipelineResult(
	result: CommandPipelineResult,
): ControlPlaneInteractionMessage {
	switch (result.kind) {
		case "noop":
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "ack",
				status: "info",
				state: "ignored",
				summary: "Ignored message that is not an executable control-plane command.",
				details: [
					makeDetail("reason", "Reason", describeReasonCode(result.reason), "primary"),
					makeDetail("reason_code", "Reason code", result.reason, "secondary"),
				],
				payload: {
					reason_code: result.reason,
				},
			});
		case "invalid":
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "error",
				status: "error",
				state: "invalid",
				summary: "Could not parse the command.",
				details: [
					makeDetail("reason", "Reason", describeReasonCode(result.reason), "primary"),
					makeDetail("reason_code", "Reason code", result.reason, "secondary"),
					makeDetail("usage", "Usage", "Use /mu <command> or mu! <command>", "secondary"),
				],
				payload: {
					reason_code: result.reason,
				},
			});
		case "operator_response": {
			const message = result.message.trim();
			const summaryCandidate = firstNonEmptyLine(message) || "Operator response";
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "operator",
				intent: "chat",
				status: "info",
				state: "responded",
				summary: truncateLine(summaryCandidate, 180),
				details: message === summaryCandidate ? [] : [makeDetail("message", "Message", message, "primary")],
				payload: {
					message,
				},
			});
		}
		case "denied":
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "error",
				status: "error",
				state: "denied",
				summary: "Request denied by control-plane policy.",
				details: [
					makeDetail(
						"reason",
						"Reason",
						`${describeReasonCode(result.reason)} (code: ${result.reason})`,
						"primary",
					),
					makeDetail("reason_code", "Reason code", result.reason, "secondary"),
				],
				payload: {
					reason_code: result.reason,
				},
			});
		case "awaiting_confirmation": {
			const command = result.command;
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "lifecycle",
				status: "warning",
				state: "awaiting_confirmation",
				summary: `Command ${command.command_id} is awaiting confirmation.`,
				details: baseCommandDetails(command),
				actions: [
					{ label: "Confirm", command: `/mu confirm ${command.command_id}`, kind: "primary" },
					{ label: "Cancel", command: `/mu cancel ${command.command_id}`, kind: "secondary" },
				],
				transition: {
					from: "accepted",
					to: "awaiting_confirmation",
				},
				payload: makeCommandPayload(command),
			});
		}
		case "completed": {
			const command = result.command;
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: command.cli_command_kind ? "mu_tool" : "mu_system",
				intent: "result",
				status: "success",
				state: "completed",
				summary: `Command ${command.command_id} completed successfully.`,
				details: baseCommandDetails(command),
				transition: {
					from: "in_progress",
					to: "completed",
				},
				payload: makeCommandPayload(command),
			});
		}
		case "cancelled": {
			const command = result.command;
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "lifecycle",
				status: "warning",
				state: "cancelled",
				summary: `Command ${command.command_id} was cancelled.`,
				details: baseCommandDetails(command),
				transition: {
					from: "awaiting_confirmation",
					to: "cancelled",
				},
				payload: makeCommandPayload(command),
			});
		}
		case "expired": {
			const command = result.command;
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "lifecycle",
				status: "warning",
				state: "expired",
				summary: `Command ${command.command_id} expired before confirmation.`,
				details: baseCommandDetails(command),
				transition: {
					from: "awaiting_confirmation",
					to: "expired",
				},
				payload: makeCommandPayload(command),
			});
		}
		case "deferred": {
			const command = result.command;
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "lifecycle",
				status: "info",
				state: "deferred",
				summary: `Command ${command.command_id} deferred; retry scheduled.`,
				details: baseCommandDetails(command),
				transition: {
					from: "in_progress",
					to: "deferred",
				},
				payload: makeCommandPayload(command),
			});
		}
		case "failed": {
			const command = result.command;
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: command.cli_command_kind ? "mu_tool" : "mu_system",
				intent: "error",
				status: "error",
				state: "failed",
				summary: `Command ${command.command_id} failed.`,
				details: [
					makeDetail(
						"reason",
						"Reason",
						`${describeReasonCode(result.reason)} (code: ${result.reason})`,
						"primary",
					),
					makeDetail("reason_code", "Reason code", result.reason, "secondary"),
					...baseCommandDetails(command),
				],
				transition: {
					from: "in_progress",
					to: "failed",
				},
				payload: {
					...makeCommandPayload(command),
					pipeline_reason: result.reason,
				},
			});
		}
	}
}

function detailsForMode(message: ControlPlaneInteractionMessage, mode: InteractionRenderMode): InteractionDetail[] {
	const primary = message.details.filter((detail) => detail.importance === "primary");
	const secondary = message.details.filter((detail) => detail.importance === "secondary");
	if (mode === "compact") {
		if (primary.length >= 2) {
			return primary.slice(0, 2);
		}
		const remaining = Math.max(0, 2 - primary.length);
		return [...primary, ...secondary.slice(0, remaining)];
	}
	return [...primary, ...secondary];
}

export function renderInteractionMessage(
	input: ControlPlaneInteractionMessage,
	opts: { mode?: InteractionRenderMode } = {},
): string {
	const message = ControlPlaneInteractionMessageSchema.parse(input);
	const mode = opts.mode ?? "detailed";
	const speaker = SPEAKER_VIEW[message.speaker];
	const header = `${STATUS_VIEW[message.status]} ${speaker.label} · ${INTENT_VIEW[message.intent]} · ${stateLabel(message.state)}`;

	const lines: string[] = [header, message.summary];

	if (message.transition) {
		const from = message.transition.from ? stateLabel(message.transition.from) : "UNKNOWN";
		lines.push(`↳ transition: ${from} → ${stateLabel(message.transition.to)}`);
	}

	const renderedDetails = detailsForMode(message, mode);
	if (renderedDetails.length > 0) {
		lines.push("Key details:");
		for (const detail of renderedDetails) {
			lines.push(`• ${detail.label}: ${detail.value}`);
		}
	}

	if (message.actions.length > 0) {
		const actions = mode === "compact" ? message.actions.slice(0, 2) : message.actions;
		lines.push("Next actions:");
		for (const action of actions) {
			const prefix = action.kind === "primary" ? "▶" : "•";
			lines.push(`${prefix} ${action.label}: ${action.command}`);
		}
	}

	if (mode === "detailed") {
		const payloadKeys = Object.keys(message.payload);
		if (payloadKeys.length > 0) {
			lines.push("Payload (structured; can be collapsed in rich clients):");
			lines.push("```json");
			lines.push(stableSerializeJson(message.payload, { pretty: true }));
			lines.push("```");
		}

		if (message.intent === "chat") {
			const chatMessage = typeof message.payload.message === "string" ? message.payload.message.trim() : "";
			if (chatMessage.length > 0 && chatMessage !== message.summary) {
				lines.push("Message:");
				lines.push(chatMessage);
			}
		}
	}

	return lines.join("\n");
}

export function presentControlPlaneMessage(messageInput: ControlPlaneInteractionMessage): PresentedControlPlaneMessage {
	const message = ControlPlaneInteractionMessageSchema.parse(messageInput);
	return {
		message,
		compact: renderInteractionMessage(message, { mode: "compact" }),
		detailed: renderInteractionMessage(message, { mode: "detailed" }),
	};
}

export function presentPipelineResultMessage(result: CommandPipelineResult): PresentedControlPlaneMessage {
	return presentControlPlaneMessage(buildInteractionMessageFromPipelineResult(result));
}

export function formatAdapterAckMessage(result: CommandPipelineResult, opts: { deferred: boolean }): string {
	const presented = presentPipelineResultMessage(result);
	if (!opts.deferred) {
		return presented.compact;
	}
	return `${presented.compact}\nDelivery: detailed update queued via outbox.`;
}
