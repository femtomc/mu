import { z } from "zod";

export const FrontendChannelSchema = z.enum(["neovim", "vscode"]);
export type FrontendChannel = z.infer<typeof FrontendChannelSchema>;

export const FrontendIngressRequestSchema = z.object({
	request_id: z.string().trim().min(1).optional(),
	tenant_id: z.string().trim().min(1),
	conversation_id: z.string().trim().min(1),
	actor_id: z.string().trim().min(1),
	text: z.string().optional(),
	command_text: z.string().optional(),
	target_type: z.string().trim().min(1).optional(),
	target_id: z.string().trim().min(1).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	client_context: z.unknown().optional(),
});
export type FrontendIngressRequest = z.infer<typeof FrontendIngressRequestSchema>;

export const FrontendIngressResponseSchema = z.object({
	ok: z.literal(true),
	accepted: z.boolean(),
	channel: FrontendChannelSchema,
	request_id: z.string().min(1),
	delivery_id: z.string().min(1),
	ack: z.string(),
	message: z.string(),
	interaction: z.unknown(),
	result: z.unknown(),
});
export type FrontendIngressResponse = z.infer<typeof FrontendIngressResponseSchema>;

export const ControlPlaneChannelCapabilitySchema = z.object({
	channel: z.string().min(1),
	route: z.string().min(1),
	ingress_payload: z.enum(["json", "form_urlencoded"]),
	verification: z.record(z.string(), z.unknown()),
	ack_format: z.string().min(1),
	delivery_semantics: z.string().min(1),
	deferred_delivery: z.boolean(),
	configured: z.boolean(),
	active: z.boolean(),
	frontend: z.boolean(),
});
export type ControlPlaneChannelCapability = z.infer<typeof ControlPlaneChannelCapabilitySchema>;

export const ControlPlaneChannelsResponseSchema = z.object({
	ok: z.literal(true),
	generated_at_ms: z.number().int(),
	channels: z.array(ControlPlaneChannelCapabilitySchema),
});
export type ControlPlaneChannelsResponse = z.infer<typeof ControlPlaneChannelsResponseSchema>;

export const FrontendChannelCapabilitySchema = ControlPlaneChannelCapabilitySchema.extend({
	channel: FrontendChannelSchema,
	verification: z.object({
		kind: z.literal("shared_secret_header"),
		secret_header: z.string().min(1),
	}),
	frontend: z.literal(true),
});
export type FrontendChannelCapability = z.infer<typeof FrontendChannelCapabilitySchema>;

export function frontendChannelCapabilitiesFromResponse(
	response: ControlPlaneChannelsResponse,
): FrontendChannelCapability[] {
	const out: FrontendChannelCapability[] = [];
	for (const capability of response.channels) {
		const parsed = FrontendChannelCapabilitySchema.safeParse(capability);
		if (parsed.success) {
			out.push(parsed.data);
		}
	}
	return out;
}

export const SessionFlashRecordSchema = z.object({
	flash_id: z.string().trim().min(1),
	created_at_ms: z.number().int(),
	session_id: z.string().trim().min(1),
	session_kind: z.string().trim().min(1).nullable(),
	body: z.string().trim().min(1),
	context_ids: z.array(z.string().trim().min(1)),
	source: z.string().trim().min(1).nullable(),
	metadata: z.record(z.string(), z.unknown()),
	from: z.object({
		channel: z.string().trim().min(1).nullable(),
		channel_tenant_id: z.string().trim().min(1).nullable(),
		channel_conversation_id: z.string().trim().min(1).nullable(),
		actor_binding_id: z.string().trim().min(1).nullable(),
	}),
	status: z.enum(["pending", "delivered"]),
	delivered_at_ms: z.number().int().nullable(),
	delivered_by: z.string().trim().min(1).nullable(),
	delivery_note: z.string().trim().min(1).nullable(),
});
export type SessionFlashRecord = z.infer<typeof SessionFlashRecordSchema>;

export const SessionFlashCreateRequestSchema = z.object({
	session_id: z.string().trim().min(1),
	session_kind: z.string().trim().min(1).optional(),
	body: z.string().trim().min(1),
	context_ids: z.array(z.string().trim().min(1)).optional(),
	source: z.string().trim().min(1).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	from: z
		.object({
			channel: z.string().trim().min(1).optional(),
			channel_tenant_id: z.string().trim().min(1).optional(),
			channel_conversation_id: z.string().trim().min(1).optional(),
			actor_binding_id: z.string().trim().min(1).optional(),
		})
		.optional(),
});
export type SessionFlashCreateRequest = z.infer<typeof SessionFlashCreateRequestSchema>;

export const SessionFlashCreateResponseSchema = z.object({
	ok: z.literal(true),
	flash: SessionFlashRecordSchema,
});
export type SessionFlashCreateResponse = z.infer<typeof SessionFlashCreateResponseSchema>;

export const SessionFlashListResponseSchema = z.object({
	ok: z.literal(true),
	count: z.number().int(),
	status: z.enum(["pending", "delivered", "all"]),
	flashes: z.array(SessionFlashRecordSchema),
});
export type SessionFlashListResponse = z.infer<typeof SessionFlashListResponseSchema>;

export const SessionTurnRequestSchema = z.object({
	session_id: z.string().trim().min(1),
	session_kind: z.string().trim().min(1).optional(),
	body: z.string().trim().min(1),
	source: z.string().trim().min(1).optional(),
	provider: z.string().trim().min(1).optional(),
	model: z.string().trim().min(1).optional(),
	thinking: z.string().trim().min(1).optional(),
	session_file: z.string().trim().min(1).optional(),
	session_dir: z.string().trim().min(1).optional(),
	extension_profile: z.enum(["operator", "worker", "orchestrator", "reviewer", "none"]).optional(),
});
export type SessionTurnRequest = z.infer<typeof SessionTurnRequestSchema>;

export const SessionTurnResultSchema = z.object({
	session_id: z.string().trim().min(1),
	session_kind: z.string().trim().min(1).nullable(),
	session_file: z.string().trim().min(1),
	context_entry_id: z.string().trim().min(1).nullable(),
	reply: z.string(),
	source: z.string().trim().min(1).nullable(),
	completed_at_ms: z.number().int(),
});
export type SessionTurnResult = z.infer<typeof SessionTurnResultSchema>;

export const SessionTurnCreateResponseSchema = z.object({
	ok: z.literal(true),
	turn: SessionTurnResultSchema,
});
export type SessionTurnCreateResponse = z.infer<typeof SessionTurnCreateResponseSchema>;

export const FRONTEND_SHARED_SECRET_HEADER_BY_CHANNEL = {
	neovim: "x-mu-neovim-secret",
	vscode: "x-mu-vscode-secret",
} as const satisfies Record<FrontendChannel, string>;

export function frontendSharedSecretHeaderForChannel(channel: FrontendChannel): string {
	return FRONTEND_SHARED_SECRET_HEADER_BY_CHANNEL[channel];
}
