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

export const SlackControlPlaneAdapterSpec = ControlPlaneAdapterSpecSchema.parse({
	channel: "slack",
	route: defaultWebhookRouteForChannel("slack"),
	ingress_payload: "form_urlencoded",
	verification: {
		kind: "hmac_sha256",
		signature_header: "x-slack-signature",
		timestamp_header: "x-slack-request-timestamp",
		signature_prefix: "v0",
		max_clock_skew_sec: 5 * 60,
	},
	ack_format: "slack_ephemeral_json",
	delivery_semantics: "at_least_once",
	deferred_delivery: true,
});

export type SlackControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	signingSecret: string;
	nowMs?: () => number;
	allowedTimestampSkewSec?: number;
};

function verifySlackRequest(
	req: Request,
	rawBody: string,
	opts: Pick<SlackControlPlaneAdapterOpts, "signingSecret" | "allowedTimestampSkewSec" | "nowMs">,
): { ok: true } | { ok: false; status: number; reason: string } {
	const timestamp = req.headers.get("x-slack-request-timestamp");
	const signature = req.headers.get("x-slack-signature");
	if (!timestamp || !signature) {
		return { ok: false, status: 401, reason: "missing_slack_signature" };
	}

	const parsedTimestamp = Number.parseInt(timestamp, 10);
	if (!Number.isFinite(parsedTimestamp)) {
		return { ok: false, status: 401, reason: "invalid_slack_timestamp" };
	}

	const nowS = Math.trunc((opts.nowMs?.() ?? Date.now()) / 1000);
	const skewSec = Math.max(1, Math.trunc(opts.allowedTimestampSkewSec ?? 5 * 60));
	if (Math.abs(nowS - parsedTimestamp) > skewSec) {
		return { ok: false, status: 401, reason: "stale_slack_timestamp" };
	}

	const expected = `v0=${hmacSha256Hex(opts.signingSecret, `v0:${timestamp}:${rawBody}`)}`;
	if (!timingSafeEqualUtf8(expected, signature)) {
		return { ok: false, status: 401, reason: "invalid_slack_signature" };
	}

	return { ok: true };
}

export class SlackControlPlaneAdapter implements ControlPlaneAdapter {
	public readonly spec = SlackControlPlaneAdapterSpec;
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #outbox: ControlPlaneOutbox;
	readonly #signingSecret: string;
	readonly #nowMs: () => number;
	readonly #allowedTimestampSkewSec: number;

	public constructor(opts: SlackControlPlaneAdapterOpts) {
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
		const verified = verifySlackRequest(req, rawBody, {
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

		const form = new URLSearchParams(rawBody);
		const teamId = form.get("team_id") ?? "unknown-team";
		const channelId = form.get("channel_id") ?? "unknown-channel";
		const actorId = form.get("user_id") ?? "unknown-user";
		const command = form.get("command") ?? "/mu";
		const text = form.get("text") ?? "";
		const triggerId = form.get("trigger_id") ?? form.get("command_ts") ?? sha256Hex(rawBody).slice(0, 24);
		const normalizedText = normalizeSlashMuCommand(command === "/mu" ? text : `${command} ${text}`);
		const stableSource = `${teamId}:${channelId}:${actorId}:${triggerId}:${normalizedText}`;
		const stableId = sha256Hex(stableSource).slice(0, 32);
		const requestIdHeader = req.headers.get("x-slack-request-id");
		const requestId =
			requestIdHeader && requestIdHeader.trim().length > 0
				? `slack-req-${requestIdHeader.trim()}`
				: `slack-req-${stableId}`;
		const deliveryId = `slack-delivery-${stableId}`;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, teamId, actorId);
		const nowMs = Math.trunc(this.#nowMs());

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: this.spec.channel,
			channel_tenant_id: teamId,
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
			idempotency_key: `slack-idem-${stableId}`,
			fingerprint: `slack-fp-${sha256Hex(normalizedText.toLowerCase())}`,
			metadata: {
				adapter: this.spec.channel,
				response_url: form.get("response_url"),
				trigger_id: triggerId,
			},
		});

		const dispatched = await runPipelineForInbound({
			pipeline: this.#pipeline,
			outbox: this.#outbox,
			inbound,
			nowMs,
			metadata: {
				adapter: this.spec.channel,
				response_url: form.get("response_url"),
				delivery_id: deliveryId,
			},
		});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({ response_type: "ephemeral", text: dispatched.ackText }, { status: 200 }),
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}
}
