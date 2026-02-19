import {
	type AdapterIngressResult,
	type ControlPlaneAdapter,
	ControlPlaneAdapterSpecSchema,
	defaultWebhookRouteForChannel,
} from "../adapter_contract.js";
import type { ControlPlaneCommandPipeline } from "../command_pipeline.js";
import { InboundEnvelopeSchema } from "../models.js";
import type { ControlPlaneOutbox } from "../outbox.js";
import {
	acceptedIngressResult,
	hmacSha256Hex,
	jsonResponse,
	normalizeSlashMuCommand,
	rejectedIngressResult,
	resolveBindingHint,
	runPipelineForInbound,
	sha256Hex,
	textResponse,
	timingSafeEqualUtf8,
} from "./shared.js";

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
	delivery_semantics: "at_least_once",
	deferred_delivery: true,
});

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
