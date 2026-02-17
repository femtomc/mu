import { z } from "zod";
import type { AdapterAuditEntry } from "./adapter_audit.js";
import type { CommandPipelineResult } from "./command_pipeline.js";
import { type Channel, ChannelSchema } from "./identity_store.js";
import type { InboundEnvelope } from "./models.js";
import type { OutboxRecord } from "./outbox.js";

export const CONTROL_PLANE_ADAPTER_CONTRACT_VERSION = 1;

export const AdapterIngressPayloadSchema = z.enum(["form_urlencoded", "json"]);
export type AdapterIngressPayload = z.infer<typeof AdapterIngressPayloadSchema>;

export const AdapterVerificationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("hmac_sha256"),
		signature_header: z.string().min(1),
		timestamp_header: z.string().min(1).nullable().default(null),
		signature_prefix: z.string().min(1),
		max_clock_skew_sec: z.number().int().positive().nullable().default(null),
	}),
	z.object({
		kind: z.literal("shared_secret_header"),
		secret_header: z.string().min(1),
	}),
]);
export type AdapterVerification = z.infer<typeof AdapterVerificationSchema>;

export const AdapterAckFormatSchema = z.enum(["slack_ephemeral_json", "discord_ephemeral_json", "telegram_ok_json"]);
export type AdapterAckFormat = z.infer<typeof AdapterAckFormatSchema>;

export const ControlPlaneAdapterSpecSchema = z.object({
	v: z.literal(CONTROL_PLANE_ADAPTER_CONTRACT_VERSION).default(CONTROL_PLANE_ADAPTER_CONTRACT_VERSION),
	channel: ChannelSchema,
	route: z.string().min(1),
	ingress_payload: AdapterIngressPayloadSchema,
	verification: AdapterVerificationSchema,
	ack_format: AdapterAckFormatSchema,
	deferred_delivery: z.boolean().default(true),
});
export type ControlPlaneAdapterSpec = z.infer<typeof ControlPlaneAdapterSpecSchema>;

export const DEFAULT_CONTROL_PLANE_WEBHOOK_ROUTES = {
	slack: "/webhooks/slack",
	discord: "/webhooks/discord",
	telegram: "/webhooks/telegram",
} as const satisfies Record<Channel, string>;

export function defaultWebhookRouteForChannel(channel: Channel): string {
	return DEFAULT_CONTROL_PLANE_WEBHOOK_ROUTES[channel];
}

export type AdapterIngressResult = {
	channel: Channel;
	accepted: boolean;
	reason?: string;
	response: Response;
	inbound: InboundEnvelope | null;
	pipelineResult: CommandPipelineResult | null;
	outboxRecord: OutboxRecord | null;
	auditEntry: AdapterAuditEntry | null;
};

export interface ControlPlaneAdapter {
	readonly spec: ControlPlaneAdapterSpec;
	ingest(req: Request): Promise<AdapterIngressResult>;
	stop?(): Promise<void> | void;
}
