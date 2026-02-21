import { z } from "zod";

export const FrontendChannelSchema = z.enum(["neovim"]);
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
	ingress_mode: z.enum(["command_only", "conversational"]),
	configured: z.boolean(),
	active: z.boolean(),
	frontend: z.boolean(),
	media: z.object({
		outbound_delivery: z.object({
			supported: z.boolean(),
			configured: z.boolean(),
			reason: z.string().nullable(),
		}),
		inbound_attachment_download: z.object({
			supported: z.boolean(),
			configured: z.boolean(),
			reason: z.string().nullable(),
		}),
	}),
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

export const SessionTurnRequestSchema = z.object({
	session_id: z.string().trim().min(1),
	session_kind: z.enum(["operator", "cp_operator"]).optional(),
	body: z.string().trim().min(1),
	source: z.string().trim().min(1).optional(),
	provider: z.string().trim().min(1).optional(),
	model: z.string().trim().min(1).optional(),
	thinking: z.string().trim().min(1).optional(),
	session_file: z.string().trim().min(1).optional(),
	session_dir: z.string().trim().min(1).optional(),
	extension_profile: z.enum(["operator", "none"]).optional(),
});
export type SessionTurnRequest = z.infer<typeof SessionTurnRequestSchema>;

export const SessionTurnResultSchema = z.object({
	session_id: z.string().trim().min(1),
	session_kind: z.enum(["operator", "cp_operator"]).nullable(),
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
} as const satisfies Record<FrontendChannel, string>;

export function frontendSharedSecretHeaderForChannel(channel: FrontendChannel): string {
	return FRONTEND_SHARED_SECRET_HEADER_BY_CHANNEL[channel];
}
