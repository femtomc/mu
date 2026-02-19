import {
	type AdapterIngressResult,
	type ControlPlaneAdapter,
	type ControlPlaneAdapterSpec,
	ControlPlaneAdapterSpecSchema,
} from "../adapter_contract.js";
import type { ControlPlaneCommandPipeline } from "../command_pipeline.js";
import {
	FrontendChannelSchema,
	FrontendIngressRequestSchema,
	type FrontendChannel,
	type FrontendIngressRequest,
} from "../frontend_client_contract.js";
import { presentPipelineResultMessage } from "../interaction_contract.js";
import { InboundEnvelopeSchema } from "../models.js";
import {
	acceptedIngressResult,
	jsonResponse,
	normalizeSlashMuCommand,
	rejectedIngressResult,
	resolveBindingHint,
	sha256Hex,
	textResponse,
	timingSafeEqualUtf8,
} from "./shared.js";

export const FrontendIngressPayloadSchema = FrontendIngressRequestSchema;
export type FrontendIngressPayload = FrontendIngressRequest;

export function createFrontendAdapterSpec(opts: {
	channel: FrontendChannel;
	route: string;
	sharedSecretHeader: string;
}): ControlPlaneAdapterSpec {
	return ControlPlaneAdapterSpecSchema.parse({
		channel: opts.channel,
		route: opts.route,
		ingress_payload: "json",
		verification: {
			kind: "shared_secret_header",
			secret_header: opts.sharedSecretHeader,
		},
		ack_format: "json",
		delivery_semantics: "at_least_once",
		deferred_delivery: false,
	});
}

export type FrontendControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	spec: ControlPlaneAdapterSpec;
	sharedSecretHeader: string;
	sharedSecret: string;
	nowMs?: () => number;
};

export class FrontendControlPlaneAdapter implements ControlPlaneAdapter {
	public readonly spec: ControlPlaneAdapterSpec;
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #sharedSecretHeader: string;
	readonly #sharedSecret: string;
	readonly #nowMs: () => number;

	public constructor(opts: FrontendControlPlaneAdapterOpts) {
		const channel = FrontendChannelSchema.safeParse(opts.spec.channel);
		if (!channel.success) {
			throw new Error(`unsupported frontend channel for adapter: ${opts.spec.channel}`);
		}
		if (opts.spec.verification.kind !== "shared_secret_header") {
			throw new Error(`frontend adapter ${opts.spec.channel} requires shared_secret_header verification`);
		}

		this.spec = opts.spec;
		this.#pipeline = opts.pipeline;
		this.#sharedSecretHeader = opts.sharedSecretHeader;
		this.#sharedSecret = opts.sharedSecret;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	public async ingest(req: Request): Promise<AdapterIngressResult> {
		if (req.method !== "POST") {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "method_not_allowed",
				response: textResponse("method not allowed", { status: 405 }),
			});
		}

		const providedSecret = req.headers.get(this.#sharedSecretHeader)?.trim() ?? "";
		if (!providedSecret) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "missing_frontend_secret",
				response: textResponse("missing_frontend_secret", { status: 401 }),
			});
		}
		if (!timingSafeEqualUtf8(this.#sharedSecret, providedSecret)) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_frontend_secret",
				response: textResponse("invalid_frontend_secret", { status: 401 }),
			});
		}

		let payloadRaw: unknown;
		try {
			payloadRaw = await req.json();
		} catch {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_json",
				response: textResponse("invalid_json", { status: 400 }),
			});
		}

		const payloadParse = FrontendIngressRequestSchema.safeParse(payloadRaw);
		if (!payloadParse.success) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_payload",
				response: textResponse("invalid_payload", { status: 400 }),
			});
		}
		const payload = payloadParse.data;

		const rawText = payload.command_text ?? payload.text ?? "";
		const normalizedText = normalizeSlashMuCommand(rawText);
		const stableSource = [
			payload.request_id ?? "",
			payload.tenant_id,
			payload.conversation_id,
			payload.actor_id,
			normalizedText,
		].join(":");
		const stableId = sha256Hex(stableSource).slice(0, 32);
		const requestId =
			payload.request_id && payload.request_id.trim().length > 0
				? `${this.spec.channel}-req-${payload.request_id.trim()}`
				: `${this.spec.channel}-req-${stableId}`;
		const deliveryId = `${this.spec.channel}-delivery-${stableId}`;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, payload.tenant_id, payload.actor_id);
		const nowMs = Math.trunc(this.#nowMs());

		const metadata: Record<string, unknown> = {
			...(payload.metadata ?? {}),
			adapter: this.spec.channel,
			frontend_channel: this.spec.channel,
		};
		if (payload.client_context !== undefined) {
			metadata.client_context = payload.client_context;
		}

		const targetType = payload.target_type ?? "status";
		const targetId = payload.target_id ?? payload.conversation_id;

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: this.spec.channel,
			channel_tenant_id: payload.tenant_id,
			channel_conversation_id: payload.conversation_id,
			actor_id: payload.actor_id,
			actor_binding_id: bindingHint.actorBindingId,
			assurance_tier: bindingHint.assuranceTier,
			repo_root: this.#pipeline.runtime.paths.repoRoot,
			command_text: normalizedText,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: targetType,
			target_id: targetId,
			idempotency_key: `${this.spec.channel}-idem-${stableId}`,
			fingerprint: `${this.spec.channel}-fp-${sha256Hex(normalizedText.toLowerCase())}`,
			metadata,
		});

		const pipelineResult = await this.#pipeline.handleInbound(inbound);
		const presented = presentPipelineResultMessage(pipelineResult);

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({
				ok: true,
				accepted: true,
				channel: this.spec.channel,
				request_id: requestId,
				delivery_id: deliveryId,
				ack: presented.compact,
				message: presented.detailed,
				interaction: presented.message,
				result: pipelineResult,
			}),
			inbound,
			pipelineResult,
			outboxRecord: null,
		});
	}
}
