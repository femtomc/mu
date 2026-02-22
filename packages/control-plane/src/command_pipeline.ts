import { ChannelSchema, type IdentityBinding, IdentityStore, TERMINAL_IDENTITY_BINDING } from "./identity_store.js";
import {
	allowsConversationalIngressForInbound,
	CONVERSATIONAL_INGRESS_OVERRIDE_ALLOW,
	CONVERSATIONAL_INGRESS_OVERRIDE_KEY,
} from "./ingress_mode_policy.js";
import { type InboundEnvelope, InboundEnvelopeSchema } from "./models.js";
import type { MessagingOperatorRuntimeLike } from "./operator_contract.js";
import type { ControlPlaneRuntime } from "./runtime.js";

export type { CommandPipelineResult, ControlPlaneCommandPipelineOpts } from "./command_pipeline_types.js";
import type { CommandPipelineResult, ControlPlaneCommandPipelineOpts } from "./command_pipeline_types.js";

function idempotencyTtlMs(): number {
	return 24 * 60 * 60 * 1_000;
}

function normalizeOperatorMessage(message: string): string {
	const trimmed = message.trim();
	if (trimmed.length > 0) {
		return trimmed;
	}
	return "Operator response was empty.";
}

export class ControlPlaneCommandPipeline {
	public readonly runtime: ControlPlaneRuntime;
	public readonly identities: IdentityStore;
	readonly #operator: MessagingOperatorRuntimeLike | null;
	readonly #nowMs: () => number;
	#started = false;

	public constructor(opts: ControlPlaneCommandPipelineOpts) {
		this.runtime = opts.runtime;
		this.identities = opts.identityStore ?? new IdentityStore(this.runtime.paths.identitiesPath);
		this.#operator = opts.operator ?? null;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	public async start(): Promise<void> {
		if (this.#started) {
			return;
		}
		await this.runtime.start();
		await this.identities.load();
		this.#started = true;
	}

	public async stop(): Promise<void> {
		if (!this.#started) {
			return;
		}
		this.#started = false;
		try {
			const operator = this.#operator as { stop?: () => Promise<void> } | null;
			await operator?.stop?.();
		} finally {
			await this.runtime.stop();
		}
	}

	#assertStarted(): void {
		if (!this.#started) {
			throw new Error("control-plane command pipeline not started");
		}
	}

	#resolveBinding(inbound: InboundEnvelope): IdentityBinding | null {
		if (
			inbound.channel === "terminal" &&
			inbound.actor_binding_id === TERMINAL_IDENTITY_BINDING.binding_id &&
			inbound.actor_id === TERMINAL_IDENTITY_BINDING.channel_actor_id &&
			inbound.channel_tenant_id === TERMINAL_IDENTITY_BINDING.channel_tenant_id
		) {
			return TERMINAL_IDENTITY_BINDING;
		}

		const channel = ChannelSchema.safeParse(inbound.channel);
		if (!channel.success) {
			return null;
		}
		const binding = this.identities.resolveActive({
			channel: channel.data,
			channelTenantId: inbound.channel_tenant_id,
			channelActorId: inbound.actor_id,
		});
		if (!binding) {
			return null;
		}
		if (binding.binding_id !== inbound.actor_binding_id) {
			return null;
		}
		return binding;
	}

	async #runOperatorTurn(inbound: InboundEnvelope, binding: IdentityBinding): Promise<CommandPipelineResult> {
		if (!this.#operator) {
			return { kind: "denied", reason: "operator_unavailable" };
		}
		if (!allowsConversationalIngressForInbound(inbound.channel, inbound.metadata)) {
			return { kind: "denied", reason: "ingress_not_conversational" };
		}

		const idempotencyClaim = await this.runtime.claimIdempotency({
			key: inbound.idempotency_key,
			fingerprint: inbound.fingerprint,
			commandId: `ingress-${inbound.request_id}`,
			ttlMs: idempotencyTtlMs(),
			nowMs: Math.trunc(this.#nowMs()),
		});
		if (idempotencyClaim.kind === "conflict") {
			return { kind: "denied", reason: "idempotency_conflict" };
		}
		if (idempotencyClaim.kind === "duplicate") {
			return { kind: "noop", reason: "duplicate_delivery" };
		}

		const decision = await this.#operator.handleInbound({ inbound, binding });
		switch (decision.kind) {
			case "response":
				return { kind: "operator_response", message: normalizeOperatorMessage(decision.message) };
			case "reject":
				return { kind: "denied", reason: decision.reason };
			case "command":
				return { kind: "operator_response", message: normalizeOperatorMessage(decision.commandText) };
		}
	}

	public async handleAdapterIngress(inboundInput: InboundEnvelope): Promise<CommandPipelineResult> {
		this.#assertStarted();
		const inbound = InboundEnvelopeSchema.parse(inboundInput);
		const binding = this.#resolveBinding(inbound);
		if (!binding) {
			return { kind: "denied", reason: "identity_not_linked" };
		}
		return await this.#runOperatorTurn(inbound, binding);
	}

	public async handleInbound(inboundInput: InboundEnvelope): Promise<CommandPipelineResult> {
		return await this.handleAdapterIngress(inboundInput);
	}

	public async handleAutonomousIngress(opts: {
		text: string;
		repoRoot: string;
		requestId?: string;
		metadata?: Record<string, unknown>;
	}): Promise<CommandPipelineResult> {
		this.#assertStarted();

		const text = opts.text.trim();
		if (text.length === 0) {
			return { kind: "invalid", reason: "empty_input" };
		}

		const requestId = opts.requestId ?? `autonomous-${crypto.randomUUID()}`;
		const deliveryId = `autonomous-${crypto.randomUUID()}`;
		const nowMs = Math.trunc(this.#nowMs());
		const binding = TERMINAL_IDENTITY_BINDING;
		const metadata: Record<string, unknown> = {
			source: "autonomous_ingress",
			[CONVERSATIONAL_INGRESS_OVERRIDE_KEY]: CONVERSATIONAL_INGRESS_OVERRIDE_ALLOW,
			...(opts.metadata ?? {}),
		};

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: "terminal",
			channel_tenant_id: binding.channel_tenant_id,
			channel_conversation_id: "local",
			actor_id: binding.channel_actor_id,
			actor_binding_id: binding.binding_id,
			assurance_tier: binding.assurance_tier,
			repo_root: opts.repoRoot,
			command_text: text,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "operator_chat",
			target_id: "autonomous",
			idempotency_key: `autonomous:${requestId}`,
			fingerprint: `fp-autonomous-${requestId}`,
			metadata,
		});

		return await this.#runOperatorTurn(inbound, binding);
	}
}
