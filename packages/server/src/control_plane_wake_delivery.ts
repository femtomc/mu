import type { Channel, IdentityBinding, OutboundEnvelope } from "@femtomc/mu-control-plane";

function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeChannel(value: unknown): Channel | null {
	switch (value) {
		case "slack":
		case "discord":
		case "telegram":
		case "neovim":
		case "terminal":
			return value;
		default:
			return null;
	}
}

export type WakeFanoutSkipReasonCode =
	| "channel_delivery_unsupported"
	| "slack_bot_token_missing"
	| "telegram_bot_token_missing";

export type WakeFanoutContext = {
	wakeId: string;
	dedupeKey: string;
	wakeSource: string | null;
	programId: string | null;
	sourceTsMs: number | null;
};

export type WakeDeliveryMetadata = {
	wakeId: string;
	wakeDedupeKey: string;
	bindingId: string;
	channel: Channel;
	outboxId: string;
	outboxDedupeKey: string;
};

export function wakeFanoutDedupeKey(opts: {
	dedupeKey: string;
	wakeId: string;
	binding: Pick<IdentityBinding, "channel" | "binding_id">;
}): string {
	const base = opts.dedupeKey.trim().length > 0 ? opts.dedupeKey.trim() : `wake:${opts.wakeId}`;
	return `${base}:wake:${opts.wakeId}:${opts.binding.channel}:${opts.binding.binding_id}`;
}

export function resolveWakeFanoutCapability(opts: {
	binding: IdentityBinding;
	isChannelDeliverySupported: (channel: Channel) => boolean;
	slackBotToken: string | null;
	telegramBotToken: string | null;
}): { ok: true } | { ok: false; reasonCode: WakeFanoutSkipReasonCode } {
	const { binding } = opts;
	if (!opts.isChannelDeliverySupported(binding.channel)) {
		return { ok: false, reasonCode: "channel_delivery_unsupported" };
	}
	if (binding.channel === "slack" && (!opts.slackBotToken || opts.slackBotToken.trim().length === 0)) {
		return { ok: false, reasonCode: "slack_bot_token_missing" };
	}
	if (binding.channel === "telegram" && (!opts.telegramBotToken || opts.telegramBotToken.trim().length === 0)) {
		return { ok: false, reasonCode: "telegram_bot_token_missing" };
	}
	return { ok: true };
}

export function buildWakeOutboundEnvelope(opts: {
	repoRoot: string;
	nowMs: number;
	message: string;
	binding: IdentityBinding;
	context: WakeFanoutContext;
	metadata?: Record<string, unknown>;
}): OutboundEnvelope {
	const channelConversationId = opts.binding.channel_actor_id;
	const requestId = `wake-req-${sha256Hex(`${opts.context.wakeId}:${opts.binding.binding_id}`).slice(0, 20)}`;
	const responseId = `wake-resp-${sha256Hex(`${opts.context.wakeId}:${opts.binding.binding_id}:${opts.nowMs}`).slice(0, 20)}`;

	return {
		v: 1,
		ts_ms: opts.nowMs,
		channel: opts.binding.channel,
		channel_tenant_id: opts.binding.channel_tenant_id,
		channel_conversation_id: channelConversationId,
		request_id: requestId,
		response_id: responseId,
		kind: "lifecycle",
		body: opts.message,
		correlation: {
			command_id: `wake-${opts.context.wakeId}-${opts.binding.binding_id}`,
			idempotency_key: `wake-idem-${opts.context.wakeId}-${opts.binding.binding_id}`,
			request_id: requestId,
			channel: opts.binding.channel,
			channel_tenant_id: opts.binding.channel_tenant_id,
			channel_conversation_id: channelConversationId,
			actor_id: opts.binding.channel_actor_id,
			actor_binding_id: opts.binding.binding_id,
			assurance_tier: opts.binding.assurance_tier,
			repo_root: opts.repoRoot,
			scope_required: "cp.ops.admin",
			scope_effective: "cp.ops.admin",
			target_type: "operator_wake",
			target_id: opts.context.wakeId,
			attempt: 1,
			state: "completed",
			error_code: null,
			operator_session_id: null,
			operator_turn_id: null,
			cli_invocation_id: null,
			cli_command_kind: null,
			run_root_id: null,
		},
		metadata: {
			wake_delivery: true,
			wake_id: opts.context.wakeId,
			wake_dedupe_key: opts.context.dedupeKey,
			wake_binding_id: opts.binding.binding_id,
			wake_channel: opts.binding.channel,
			wake_source: opts.context.wakeSource,
			wake_program_id: opts.context.programId,
			wake_source_ts_ms: opts.context.sourceTsMs,
			...(opts.metadata ?? {}),
		},
	};
}

export function wakeDeliveryMetadataFromOutboxRecord(record: {
	outbox_id: string;
	dedupe_key: string;
	envelope: Pick<OutboundEnvelope, "channel" | "metadata">;
}): WakeDeliveryMetadata | null {
	const metadata = record.envelope.metadata;
	if (metadata.wake_delivery !== true) {
		return null;
	}
	const wakeId = normalizeString(metadata.wake_id);
	const bindingId = normalizeString(metadata.wake_binding_id);
	const wakeDedupeKey = normalizeString(metadata.wake_dedupe_key) ?? record.dedupe_key;
	const metadataChannel = normalizeChannel(metadata.wake_channel);
	const envelopeChannel = normalizeChannel(record.envelope.channel);
	const channel = metadataChannel ?? envelopeChannel;
	if (!wakeId || !bindingId || !channel) {
		return null;
	}
	return {
		wakeId,
		wakeDedupeKey,
		bindingId,
		channel,
		outboxId: record.outbox_id,
		outboxDedupeKey: record.dedupe_key,
	};
}

export function wakeDispatchReasonCode(opts: {
	state: "delivered" | "retried" | "dead_letter";
	lastError: string | null;
	deadLetterReason: string | null;
}): string {
	switch (opts.state) {
		case "delivered":
			return "outbox_delivered";
		case "retried":
			return opts.lastError && opts.lastError.trim().length > 0 ? opts.lastError : "outbox_retry";
		case "dead_letter":
			return opts.deadLetterReason && opts.deadLetterReason.trim().length > 0
				? opts.deadLetterReason
				: "outbox_dead_letter";
	}
}
