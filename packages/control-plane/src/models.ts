import { z } from "zod";
import { CommandStateSchema } from "./command_state.js";

export const CONTROL_PLANE_SCHEMA_VERSION = 1;

export const AssuranceTierSchema = z.enum(["tier_a", "tier_b", "tier_c"]);
export type AssuranceTier = z.infer<typeof AssuranceTierSchema>;

export const CorrelationMetadataSchema = z.object({
	command_id: z.string().min(1),
	idempotency_key: z.string().min(1),
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
	attempt: z.number().int().nonnegative(),
	state: CommandStateSchema,
	error_code: z.string().nullable(),
	operator_session_id: z.string().min(1).nullable().default(null),
	operator_turn_id: z.string().min(1).nullable().default(null),
	cli_invocation_id: z.string().min(1).nullable().default(null),
	cli_command_kind: z.string().min(1).nullable().default(null),
	run_root_id: z.string().min(1).nullable().default(null),
});
export type CorrelationMetadata = z.infer<typeof CorrelationMetadataSchema>;

export const AttachmentReferenceSchema = z
	.object({
		source: z.string().min(1),
		file_id: z.string().min(1).nullable().optional(),
		url: z.string().url().nullable().optional(),
	})
	.superRefine((value, ctx) => {
		const hasFileId = typeof value.file_id === "string" && value.file_id.length > 0;
		const hasUrl = typeof value.url === "string" && value.url.length > 0;
		if (hasFileId || hasUrl) {
			return;
		}
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "attachment reference requires file_id or url",
			path: ["file_id"],
		});
	});
export type AttachmentReference = z.infer<typeof AttachmentReferenceSchema>;

export const AttachmentDescriptorSchema = z.object({
	type: z.string().min(1),
	filename: z.string().min(1).nullable().optional(),
	mime_type: z.string().min(1).nullable().optional(),
	size_bytes: z.number().int().nonnegative().nullable().optional(),
	reference: AttachmentReferenceSchema,
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;

export const InboundEnvelopeSchema = z.object({
	v: z.literal(CONTROL_PLANE_SCHEMA_VERSION).default(CONTROL_PLANE_SCHEMA_VERSION),
	received_at_ms: z.number().int(),
	request_id: z.string().min(1),
	delivery_id: z.string().min(1),
	channel: z.string().min(1),
	channel_tenant_id: z.string().min(1),
	channel_conversation_id: z.string().min(1),
	actor_id: z.string().min(1),
	actor_binding_id: z.string().min(1),
	assurance_tier: AssuranceTierSchema,
	repo_root: z.string().min(1),
	command_text: z.string().min(1),
	scope_required: z.string().min(1),
	scope_effective: z.string().min(1),
	target_type: z.string().min(1),
	target_id: z.string().min(1),
	idempotency_key: z.string().min(1),
	fingerprint: z.string().min(1),
	attachments: z.array(AttachmentDescriptorSchema).optional(),
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type InboundEnvelope = z.infer<typeof InboundEnvelopeSchema>;

export const OutboundEnvelopeSchema = z.object({
	v: z.literal(CONTROL_PLANE_SCHEMA_VERSION).default(CONTROL_PLANE_SCHEMA_VERSION),
	ts_ms: z.number().int(),
	channel: z.string().min(1),
	channel_tenant_id: z.string().min(1),
	channel_conversation_id: z.string().min(1),
	request_id: z.string().min(1),
	response_id: z.string().min(1),
	kind: z.enum(["ack", "lifecycle", "result", "error"]),
	body: z.string(),
	attachments: z.array(AttachmentDescriptorSchema).optional(),
	correlation: CorrelationMetadataSchema,
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type OutboundEnvelope = z.infer<typeof OutboundEnvelopeSchema>;
