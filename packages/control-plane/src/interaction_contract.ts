import { z } from "zod";
import type { CommandPipelineResult } from "./command_pipeline.js";

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
	idempotency_conflict: "A message with this idempotency key conflicts with a different fingerprint.",
	duplicate_delivery: "Duplicate delivery was detected and ignored.",
	not_command: "Message is not actionable.",
	empty_input: "Message contained no usable input.",
	operator_unavailable: "Messaging operator runtime is unavailable.",
	ingress_not_conversational: "Ingress channel is not enabled for conversational routing.",
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
				summary: "Ignored duplicate or non-actionable ingress message.",
				details: [
					makeDetail("reason", "Reason", describeReasonCode(result.reason), "primary"),
					makeDetail("reason_code", "Reason code", result.reason, "secondary"),
				],
				payload: { reason_code: result.reason },
			});
		case "invalid":
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "error",
				status: "error",
				state: "invalid",
				summary: "Could not process ingress payload.",
				details: [
					makeDetail("reason", "Reason", describeReasonCode(result.reason), "primary"),
					makeDetail("reason_code", "Reason code", result.reason, "secondary"),
				],
				payload: { reason_code: result.reason },
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
				payload: { message },
			});
		}
		case "denied":
			return ControlPlaneInteractionMessageSchema.parse({
				speaker: "mu_system",
				intent: "error",
				status: "error",
				state: "denied",
				summary: "Request denied by control-plane ingress policy.",
				details: [
					makeDetail("reason", "Reason", `${describeReasonCode(result.reason)} (code: ${result.reason})`, "primary"),
					makeDetail("reason_code", "Reason code", result.reason, "secondary"),
				],
				payload: { reason_code: result.reason },
			});
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
	return `${presented.compact}\nDelivery: update queued via outbox.`;
}
