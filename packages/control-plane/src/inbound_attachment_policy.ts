import { z } from "zod";
import { type Channel, ChannelSchema } from "./identity_store.js";

const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_INBOUND_ATTACHMENT_ALLOWED_MIME_TYPES = [
	"application/pdf",
	"image/svg+xml",
	"image/png",
	"image/jpeg",
	"image/webp",
	"text/plain",
] as const;

export type InboundAttachmentPolicyReason =
	| "inbound_attachment_channel_disabled"
	| "inbound_attachment_missing_mime"
	| "inbound_attachment_unsupported_mime"
	| "inbound_attachment_missing_size"
	| "inbound_attachment_oversize"
	| "inbound_attachment_missing_channel_file_id"
	| "inbound_attachment_malware_flagged"
	| "inbound_attachment_missing_content_hash";

export const InboundAttachmentDownloadModeSchema = z.enum(["disabled", "enabled"]);
export type InboundAttachmentDownloadMode = z.infer<typeof InboundAttachmentDownloadModeSchema>;

export const InboundAttachmentMalwarePolicySchema = z.object({
	hook_enabled: z.boolean().default(false),
	quarantine_on_suspect: z.boolean().default(true),
});
export type InboundAttachmentMalwarePolicy = z.infer<typeof InboundAttachmentMalwarePolicySchema>;

export const InboundAttachmentRetentionPolicySchema = z.object({
	ttl_ms: z.number().int().positive().default(DAY_MS),
	cleanup_batch_limit: z.number().int().positive().default(200),
});
export type InboundAttachmentRetentionPolicy = z.infer<typeof InboundAttachmentRetentionPolicySchema>;

export const InboundAttachmentPolicySchema = z.object({
	version: z.literal(1).default(1),
	allowed_mime_types: z.array(z.string().min(1)).min(1),
	max_size_bytes: z.number().int().positive().default(10 * MiB),
	channels: z.partialRecord(ChannelSchema, InboundAttachmentDownloadModeSchema).default({}),
	malware: InboundAttachmentMalwarePolicySchema.default(() => ({
		hook_enabled: false,
		quarantine_on_suspect: true,
	})),
	retention: InboundAttachmentRetentionPolicySchema.default(() => ({
		ttl_ms: DAY_MS,
		cleanup_batch_limit: 200,
	})),
	dedupe: z
		.object({
			prefer_channel_file_id: z.boolean().default(true),
			require_content_hash_when_available: z.boolean().default(true),
		})
		.default(() => ({
			prefer_channel_file_id: true,
			require_content_hash_when_available: true,
		})),
});
export type InboundAttachmentPolicy = z.infer<typeof InboundAttachmentPolicySchema>;

export const DEFAULT_INBOUND_ATTACHMENT_POLICY: InboundAttachmentPolicy = InboundAttachmentPolicySchema.parse({
	version: 1,
	allowed_mime_types: [...DEFAULT_INBOUND_ATTACHMENT_ALLOWED_MIME_TYPES],
	max_size_bytes: 10 * MiB,
	channels: {
		slack: "enabled",
		telegram: "enabled",
		discord: "disabled",
		neovim: "disabled",
		terminal: "disabled",
	},
	malware: {
		hook_enabled: false,
		quarantine_on_suspect: true,
	},
	retention: {
		ttl_ms: DAY_MS,
		cleanup_batch_limit: 200,
	},
	dedupe: {
		prefer_channel_file_id: true,
		require_content_hash_when_available: true,
	},
});

export type InboundAttachmentCandidate = {
	channel: Channel;
	adapter: string;
	attachment_id: string;
	channel_file_id: string | null;
	declared_mime_type: string | null;
	declared_size_bytes: number | null;
};

export type InboundStoredAttachment = {
	channel: Channel;
	attachment_id: string;
	channel_file_id: string | null;
	stored_mime_type: string | null;
	stored_size_bytes: number | null;
	content_hash: string | null;
	malware_flagged: boolean;
};

export type InboundAttachmentPolicyDecision =
	| {
			kind: "allow";
			reason: null;
			audit: Record<string, unknown>;
	  }
	| {
			kind: "deny";
			reason: InboundAttachmentPolicyReason;
			audit: Record<string, unknown>;
	  };

function normalizeMimeType(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

function normalizeSizeBytes(value: number | null): number | null {
	if (value == null || !Number.isFinite(value)) {
		return null;
	}
	const rounded = Math.trunc(value);
	return rounded >= 0 ? rounded : null;
}

function baseAuditMetadata(opts: {
	stage: "pre_download" | "post_download";
	channel: Channel;
	attachmentId: string;
	reason: InboundAttachmentPolicyReason | null;
	metadata?: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		policy: "inbound_attachment",
		policy_version: DEFAULT_INBOUND_ATTACHMENT_POLICY.version,
		stage: opts.stage,
		channel: opts.channel,
		attachment_id: opts.attachmentId,
		reason_code: opts.reason,
		redacted: true,
		...(opts.metadata ?? {}),
	};
}

function channelDownloadEnabled(policy: InboundAttachmentPolicy, channel: Channel): boolean {
	return (policy.channels[channel] ?? "disabled") === "enabled";
}

export function evaluateInboundAttachmentPreDownload(
	candidate: InboundAttachmentCandidate,
	policy: InboundAttachmentPolicy = DEFAULT_INBOUND_ATTACHMENT_POLICY,
): InboundAttachmentPolicyDecision {
	const parsedPolicy = InboundAttachmentPolicySchema.parse(policy);
	if (!channelDownloadEnabled(parsedPolicy, candidate.channel)) {
		return {
			kind: "deny",
			reason: "inbound_attachment_channel_disabled",
			audit: baseAuditMetadata({
				stage: "pre_download",
				channel: candidate.channel,
				attachmentId: candidate.attachment_id,
				reason: "inbound_attachment_channel_disabled",
			}),
		};
	}

	if (!candidate.channel_file_id || candidate.channel_file_id.trim().length === 0) {
		return {
			kind: "deny",
			reason: "inbound_attachment_missing_channel_file_id",
			audit: baseAuditMetadata({
				stage: "pre_download",
				channel: candidate.channel,
				attachmentId: candidate.attachment_id,
				reason: "inbound_attachment_missing_channel_file_id",
			}),
		};
	}

	const mime = normalizeMimeType(candidate.declared_mime_type);
	if (!mime) {
		return {
			kind: "deny",
			reason: "inbound_attachment_missing_mime",
			audit: baseAuditMetadata({
				stage: "pre_download",
				channel: candidate.channel,
				attachmentId: candidate.attachment_id,
				reason: "inbound_attachment_missing_mime",
			}),
		};
	}

	if (!parsedPolicy.allowed_mime_types.includes(mime)) {
		return {
			kind: "deny",
			reason: "inbound_attachment_unsupported_mime",
			audit: baseAuditMetadata({
				stage: "pre_download",
				channel: candidate.channel,
				attachmentId: candidate.attachment_id,
				reason: "inbound_attachment_unsupported_mime",
				metadata: {
					declared_mime_type: mime,
				},
			}),
		};
	}

	const sizeBytes = normalizeSizeBytes(candidate.declared_size_bytes);
	if (sizeBytes == null) {
		return {
			kind: "deny",
			reason: "inbound_attachment_missing_size",
			audit: baseAuditMetadata({
				stage: "pre_download",
				channel: candidate.channel,
				attachmentId: candidate.attachment_id,
				reason: "inbound_attachment_missing_size",
			}),
		};
	}

	if (sizeBytes > parsedPolicy.max_size_bytes) {
		return {
			kind: "deny",
			reason: "inbound_attachment_oversize",
			audit: baseAuditMetadata({
				stage: "pre_download",
				channel: candidate.channel,
				attachmentId: candidate.attachment_id,
				reason: "inbound_attachment_oversize",
				metadata: {
					declared_size_bytes: sizeBytes,
					max_size_bytes: parsedPolicy.max_size_bytes,
				},
			}),
		};
	}

	return {
		kind: "allow",
		reason: null,
		audit: baseAuditMetadata({
			stage: "pre_download",
			channel: candidate.channel,
			attachmentId: candidate.attachment_id,
			reason: null,
			metadata: {
				declared_mime_type: mime,
				declared_size_bytes: sizeBytes,
			},
		}),
	};
}

export function evaluateInboundAttachmentPostDownload(
	stored: InboundStoredAttachment,
	policy: InboundAttachmentPolicy = DEFAULT_INBOUND_ATTACHMENT_POLICY,
): InboundAttachmentPolicyDecision {
	const parsedPolicy = InboundAttachmentPolicySchema.parse(policy);
	const mime = normalizeMimeType(stored.stored_mime_type);
	const sizeBytes = normalizeSizeBytes(stored.stored_size_bytes);

	if (stored.malware_flagged && parsedPolicy.malware.quarantine_on_suspect) {
		return {
			kind: "deny",
			reason: "inbound_attachment_malware_flagged",
			audit: baseAuditMetadata({
				stage: "post_download",
				channel: stored.channel,
				attachmentId: stored.attachment_id,
				reason: "inbound_attachment_malware_flagged",
			}),
		};
	}

	if (!mime) {
		return {
			kind: "deny",
			reason: "inbound_attachment_missing_mime",
			audit: baseAuditMetadata({
				stage: "post_download",
				channel: stored.channel,
				attachmentId: stored.attachment_id,
				reason: "inbound_attachment_missing_mime",
			}),
		};
	}
	if (!parsedPolicy.allowed_mime_types.includes(mime)) {
		return {
			kind: "deny",
			reason: "inbound_attachment_unsupported_mime",
			audit: baseAuditMetadata({
				stage: "post_download",
				channel: stored.channel,
				attachmentId: stored.attachment_id,
				reason: "inbound_attachment_unsupported_mime",
				metadata: {
					stored_mime_type: mime,
				},
			}),
		};
	}

	if (sizeBytes == null) {
		return {
			kind: "deny",
			reason: "inbound_attachment_missing_size",
			audit: baseAuditMetadata({
				stage: "post_download",
				channel: stored.channel,
				attachmentId: stored.attachment_id,
				reason: "inbound_attachment_missing_size",
			}),
		};
		}

	if (sizeBytes > parsedPolicy.max_size_bytes) {
		return {
			kind: "deny",
			reason: "inbound_attachment_oversize",
			audit: baseAuditMetadata({
				stage: "post_download",
				channel: stored.channel,
				attachmentId: stored.attachment_id,
				reason: "inbound_attachment_oversize",
				metadata: {
					stored_size_bytes: sizeBytes,
					max_size_bytes: parsedPolicy.max_size_bytes,
				},
			}),
		};
	}

	if (parsedPolicy.dedupe.require_content_hash_when_available && (!stored.content_hash || stored.content_hash.length === 0)) {
		return {
			kind: "deny",
			reason: "inbound_attachment_missing_content_hash",
			audit: baseAuditMetadata({
				stage: "post_download",
				channel: stored.channel,
				attachmentId: stored.attachment_id,
				reason: "inbound_attachment_missing_content_hash",
			}),
		};
	}

	return {
		kind: "allow",
		reason: null,
		audit: baseAuditMetadata({
			stage: "post_download",
			channel: stored.channel,
			attachmentId: stored.attachment_id,
			reason: null,
			metadata: {
				stored_mime_type: mime,
				stored_size_bytes: sizeBytes,
				content_hash_present: stored.content_hash != null && stored.content_hash.length > 0,
			},
		}),
	};
}

export function inboundAttachmentExpiryMs(
	nowMs: number,
	policy: InboundAttachmentPolicy = DEFAULT_INBOUND_ATTACHMENT_POLICY,
): number {
	const parsedPolicy = InboundAttachmentPolicySchema.parse(policy);
	return Math.trunc(nowMs) + parsedPolicy.retention.ttl_ms;
}

export function summarizeInboundAttachmentPolicy(policy: InboundAttachmentPolicy = DEFAULT_INBOUND_ATTACHMENT_POLICY): {
	version: number;
	allowed_mime_types: string[];
	max_size_bytes: number;
	retention_ttl_ms: number;
	channel_modes: Record<Channel, InboundAttachmentDownloadMode>;
} {
	const parsed = InboundAttachmentPolicySchema.parse(policy);
	return {
		version: parsed.version,
		allowed_mime_types: [...parsed.allowed_mime_types].sort(),
		max_size_bytes: parsed.max_size_bytes,
		retention_ttl_ms: parsed.retention.ttl_ms,
		channel_modes: {
			slack: parsed.channels.slack ?? "disabled",
			discord: parsed.channels.discord ?? "disabled",
			telegram: parsed.channels.telegram ?? "disabled",
			neovim: parsed.channels.neovim ?? "disabled",
			terminal: parsed.channels.terminal ?? "disabled",
		},
	};
}
