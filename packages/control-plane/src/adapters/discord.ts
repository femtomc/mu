import { normalizeUiDocs, type UiDoc, type UiEvent } from "@femtomc/mu-core";
import {
	type AdapterIngressResult,
	type ControlPlaneAdapter,
	ControlPlaneAdapterSpecSchema,
	defaultWebhookRouteForChannel,
} from "../adapter_contract.js";
import type { CommandPipelineResult, ControlPlaneCommandPipeline } from "../command_pipeline.js";
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
import { UiCallbackTokenStore } from "../ui_callback_token_store.js";
import {
	commandTextFromUiEvent,
	decodeUiEventToken,
	UiEventContext,
	uiCallbackTokenFailurePayload,
	uiEventForMetadata,
} from "../ui_event_ingress.js";
import { issueUiDocActionPayloads, uiDocActionPayloadKey } from "../ui_event_egress.js";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function stringIdFrom(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

const DISCORD_UI_DOCS_MAX = 3;
const DISCORD_ACTION_ROWS_MAX = 5;
const DISCORD_ACTIONS_PER_ROW = 5;
const DISCORD_ACTION_LABEL_MAX_LEN = 80;
const DISCORD_CUSTOM_ID_MAX_BYTES = 100;
const DISCORD_UI_EVENT_PAYLOAD_PREFIX = "mu_evt";

type DiscordButtonStyle = 1 | 2 | 3 | 4;
type DiscordButtonComponent = {
	type: 2;
	style: DiscordButtonStyle;
	label: string;
	custom_id: string;
};

type DiscordActionRowComponent = {
	type: 1;
	components: DiscordButtonComponent[];
};

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function truncateDiscordLabel(label: string): string {
	if (label.length <= DISCORD_ACTION_LABEL_MAX_LEN) {
		return label;
	}
	if (DISCORD_ACTION_LABEL_MAX_LEN <= 1) {
		return label.slice(0, DISCORD_ACTION_LABEL_MAX_LEN);
	}
	return `${label.slice(0, DISCORD_ACTION_LABEL_MAX_LEN - 1)}…`;
}

function discordButtonStyleForActionKind(kind: unknown): DiscordButtonStyle {
	if (kind === "primary") {
		return 1;
	}
	if (kind === "danger") {
		return 4;
	}
	if (kind === "success") {
		return 3;
	}
	return 2;
}

function commandTextForUiAction(action: UiDoc["actions"][number]): string | null {
	const fromMetadata = typeof action.metadata.command_text === "string" ? action.metadata.command_text.trim() : "";
	if (fromMetadata.length === 0) {
		return null;
	}
	return fromMetadata;
}

function uiDocComponentLines(doc: UiDoc): string[] {
	const lines: string[] = [];
	const components = [...doc.components].sort((a, b) => a.id.localeCompare(b.id));
	for (const component of components) {
		switch (component.kind) {
			case "text": {
				lines.push(component.text);
				break;
			}
			case "list": {
				if (component.title) {
					lines.push(component.title);
				}
				for (const item of component.items) {
					lines.push(`• ${item.label}${item.detail ? ` · ${item.detail}` : ""}`);
				}
				break;
			}
			case "key_value": {
				if (component.title) {
					lines.push(component.title);
				}
				for (const row of component.rows) {
					lines.push(`• ${row.key}: ${row.value}`);
				}
				break;
			}
			case "divider": {
				lines.push("────────");
				break;
			}
		}
	}
	return lines;
}

function uiDocActionLines(doc: UiDoc): string[] {
	const actions = [...doc.actions].sort((a, b) => a.id.localeCompare(b.id));
	return actions.map((action) => {
		const parts = [`• ${action.label}`];
		if (action.description) {
			parts.push(action.description);
		}
		parts.push(`(id=${action.id})`);
		return parts.join(" ");
	});
}

function uiDocTextLines(doc: UiDoc): string[] {
	const lines = [`UI · ${doc.title}`];
	if (doc.summary) {
		lines.push(doc.summary);
	}
	lines.push(...uiDocComponentLines(doc));
	const actionLines = uiDocActionLines(doc);
	if (actionLines.length > 0) {
		lines.push("Actions:");
		lines.push(...actionLines);
	}
	return lines;
}

function uiDocsTextFallback(uiDocs: readonly UiDoc[]): string {
	if (uiDocs.length === 0) {
		return "";
	}
	return uiDocs.map((doc) => uiDocTextLines(doc).join("\n")).join("\n\n");
}

function actionFallbackLine(label: string, commandText: string | null): string {
	if (commandText && commandText.trim().length > 0) {
		return `• ${label}: ${commandText.trim()}`;
	}
	return `• ${label}: interactive unavailable (missing command_text)`;
}

function encodeDiscordUiEventPayload(opts: {
	uiId: string;
	actionId: string;
	revision: number;
	callbackToken: string;
}): string {
	return [
		DISCORD_UI_EVENT_PAYLOAD_PREFIX,
		encodeURIComponent(opts.uiId),
		String(opts.revision),
		encodeURIComponent(opts.actionId),
		opts.callbackToken,
	].join("|");
}

function parseDiscordCompactUiEventPayload(value: string): UiEvent | null {
	const parts = value.split("|");
	if (parts.length !== 5 || parts[0] !== DISCORD_UI_EVENT_PAYLOAD_PREFIX) {
		return null;
	}
	const revision = Number.parseInt(parts[2] ?? "", 10);
	if (!Number.isFinite(revision) || revision < 0) {
		return null;
	}
	const callbackToken = (parts[4] ?? "").trim();
	if (callbackToken.length === 0) {
		return null;
	}

	let uiId = "";
	let actionId = "";
	try {
		uiId = decodeURIComponent(parts[1] ?? "").trim();
		actionId = decodeURIComponent(parts[3] ?? "").trim();
	} catch {
		return null;
	}
	if (uiId.length === 0 || actionId.length === 0) {
		return null;
	}
	return {
		ui_id: uiId,
		action_id: actionId,
		revision: {
			id: `v${revision}`,
			version: Math.trunc(revision),
		},
		callback_token: callbackToken,
		payload: {},
		created_at_ms: 0,
		metadata: {},
	};
}

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
	uiCallbackTokenStore: UiCallbackTokenStore;
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
	readonly #uiCallbackTokenStore: UiCallbackTokenStore;

	async #renderUiActions(opts: {
		uiDocs: readonly UiDoc[];
		channelTenantId: string;
		channelConversationId: string;
		actorBindingId: string;
		nowMs: number;
	}): Promise<{ components: DiscordActionRowComponent[]; overflowLines: string[] }> {
		const fallbackForAll = opts.uiDocs
			.flatMap((doc) =>
				[...doc.actions]
					.sort((a, b) => a.id.localeCompare(b.id))
					.map((action) => actionFallbackLine(action.label, commandTextForUiAction(action))),
			)
			.sort((a, b) => a.localeCompare(b));

		let issuedByKey = new Map<
			string,
			{
				callback_token: string;
				command_text: string;
			}
		>();
		try {
			const issued = await issueUiDocActionPayloads({
				uiDocs: opts.uiDocs,
				tokenStore: this.#uiCallbackTokenStore,
				context: {
					channel: this.spec.channel,
					channelTenantId: opts.channelTenantId,
					channelConversationId: opts.channelConversationId,
					actorBindingId: opts.actorBindingId,
				},
				nowMs: opts.nowMs,
			});
			issuedByKey = new Map(
				issued.map((entry) => {
					const commandText =
						typeof entry.ui_event.metadata.command_text === "string" ? entry.ui_event.metadata.command_text : "";
					return [
						entry.key,
						{
							callback_token: entry.callback_token,
							command_text: commandText,
						},
					] as const;
				}),
			);
		} catch {
			return { components: [], overflowLines: fallbackForAll };
		}

		const buttonEntries: Array<{ button: DiscordButtonComponent; fallbackLine: string }> = [];
		const overflowLines: string[] = [];

		for (const doc of opts.uiDocs) {
			const actions = [...doc.actions].sort((a, b) => a.id.localeCompare(b.id));
			for (const action of actions) {
				const key = uiDocActionPayloadKey(doc.ui_id, action.id);
				const issued = issuedByKey.get(key);
				const metadataCommandText = commandTextForUiAction(action);
				const commandText = issued?.command_text?.trim().length ? issued.command_text.trim() : metadataCommandText;
				const fallbackLine = actionFallbackLine(action.label, commandText);
				if (!issued) {
					overflowLines.push(fallbackLine);
					continue;
				}
				const customId = encodeDiscordUiEventPayload({
					uiId: doc.ui_id,
					actionId: action.id,
					revision: doc.revision.version,
					callbackToken: issued.callback_token,
				});
				if (utf8ByteLength(customId) > DISCORD_CUSTOM_ID_MAX_BYTES) {
					overflowLines.push(fallbackLine);
					continue;
				}
				buttonEntries.push({
					button: {
						type: 2,
						style: discordButtonStyleForActionKind(action.kind),
						label: truncateDiscordLabel(action.label),
						custom_id: customId,
					},
					fallbackLine,
				});
			}
		}

		const maxButtons = DISCORD_ACTION_ROWS_MAX * DISCORD_ACTIONS_PER_ROW;
		const visibleButtons = buttonEntries.slice(0, maxButtons);
		for (const omitted of buttonEntries.slice(maxButtons)) {
			overflowLines.push(omitted.fallbackLine);
		}

		const components: DiscordActionRowComponent[] = [];
		for (let idx = 0; idx < visibleButtons.length && components.length < DISCORD_ACTION_ROWS_MAX; idx += DISCORD_ACTIONS_PER_ROW) {
			components.push({
				type: 1,
				components: visibleButtons.slice(idx, idx + DISCORD_ACTIONS_PER_ROW).map((entry) => entry.button),
			});
		}
		return { components, overflowLines };
	}

	async #responseDataForDispatch(opts: {
		pipelineResult: CommandPipelineResult;
		ackText: string;
		channelTenantId: string;
		channelConversationId: string;
		actorBindingId: string;
		nowMs: number;
	}): Promise<{ content: string; flags: 64; components?: DiscordActionRowComponent[] }> {
		const baseContent =
			opts.pipelineResult.kind === "operator_response" ? opts.pipelineResult.message.trim() : opts.ackText.trim();
		let content = baseContent.length > 0 ? baseContent : "Done.";
		if (opts.pipelineResult.kind !== "operator_response") {
			return { content, flags: 64 };
		}

		const uiDocs = normalizeUiDocs(opts.pipelineResult.ui_docs, { maxDocs: DISCORD_UI_DOCS_MAX });
		if (uiDocs.length === 0) {
			return { content, flags: 64 };
		}

		const rendered = await this.#renderUiActions({
			uiDocs,
			channelTenantId: opts.channelTenantId,
			channelConversationId: opts.channelConversationId,
			actorBindingId: opts.actorBindingId,
			nowMs: opts.nowMs,
		});
		const fallback = uiDocsTextFallback(uiDocs);
		const sections = [content];
		if (fallback.trim().length > 0) {
			sections.push(fallback.trim());
		}
		if (rendered.overflowLines.length > 0) {
			sections.push(`Actions:\n${rendered.overflowLines.join("\n")}`);
		}
		content = sections
			.map((section) => section.trim())
			.filter((section) => section.length > 0)
			.join("\n\n");
		if (rendered.components.length === 0) {
			return { content, flags: 64 };
		}
		return { content, flags: 64, components: rendered.components };
	}

	public constructor(opts: DiscordControlPlaneAdapterOpts) {
		this.#pipeline = opts.pipeline;
		this.#outbox = opts.outbox;
		this.#signingSecret = opts.signingSecret;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#allowedTimestampSkewSec = Math.max(1, Math.trunc(opts.allowedTimestampSkewSec ?? 5 * 60));
		this.#uiCallbackTokenStore = opts.uiCallbackTokenStore;
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

		if (payload.type === 3) {
			return await this.#ingestComponentInteraction(payload);
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
		const rawText = typeof payload.data?.text === "string" ? payload.data.text : "";
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
			suppressOperatorOutbox: true,
		});
		const responseData = await this.#responseDataForDispatch({
			pipelineResult: dispatched.pipelineResult,
			ackText: dispatched.ackText,
			channelTenantId: guildId,
			channelConversationId: channelId,
			actorBindingId: bindingHint.actorBindingId,
			nowMs,
		});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({ type: 4, data: responseData }, { status: 200 }),
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}

	async #ingestComponentInteraction(payload: Record<string, unknown>): Promise<AdapterIngressResult> {
		const interactionId =
			typeof payload.id === "string" && payload.id.length > 0 ? payload.id : sha256Hex(JSON.stringify(payload)).slice(0, 24);
		const channelId = typeof payload.channel_id === "string" && payload.channel_id.length > 0 ? payload.channel_id : "unknown-channel";
		const guildId = typeof payload.guild_id === "string" && payload.guild_id.length > 0 ? payload.guild_id : null;
		const memberRecord = asRecord(payload.member);
		const userRecord = asRecord(memberRecord?.user) ?? asRecord(payload.user);
		const actorId = stringIdFrom(userRecord?.id) ?? "unknown-user";
		const tenantId = guildId ?? actorId;
		const componentData = (() => {
			const data = payload.data;
			if (data && typeof data === "object" && !Array.isArray(data)) {
				return data as Record<string, unknown>;
			}
			return null;
		})();
		const customId = typeof componentData?.custom_id === "string" ? componentData.custom_id : "";
		const uiEvent = parseDiscordCompactUiEventPayload(customId);
		if (!uiEvent || typeof uiEvent.callback_token !== "string" || uiEvent.callback_token.trim().length === 0) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "unsupported_discord_component_payload",
				response: jsonResponse(
					{
						type: 4,
						data: {
							content: "Unsupported Discord interaction.",
							flags: 64,
						},
					},
					{ status: 200 },
				),
			});
		}

		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, tenantId, actorId);
		const context: UiEventContext = {
			channel: this.spec.channel,
			channelTenantId: tenantId,
			channelConversationId: channelId,
			actorBindingId: bindingHint.actorBindingId,
		};
		const nowMs = Math.trunc(this.#nowMs());
		const tokenDecision = await decodeUiEventToken({
			tokenStore: this.#uiCallbackTokenStore,
			context,
			uiEvent,
			nowMs,
		});
		if (tokenDecision.kind !== "ok") {
			const failure = uiCallbackTokenFailurePayload(tokenDecision);
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: failure.reason,
				response: jsonResponse(
					{
						type: 4,
						data: {
							content: failure.text,
							flags: 64,
						},
					},
					{ status: 200 },
				),
				inbound: null,
				pipelineResult: { kind: "noop", reason: failure.reason },
				outboxRecord: null,
			});
		}

		const resolvedUiEvent = tokenDecision.record.ui_event;
		const normalizedText = commandTextFromUiEvent(resolvedUiEvent);
		if (!normalizedText) {
			const reason = "ui_event_missing_command_text";
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason,
				response: jsonResponse(
					{
						type: 4,
						data: {
							content: "This action is missing command_text metadata. Please rerun the request.",
							flags: 64,
						},
					},
					{ status: 200 },
				),
				inbound: null,
				pipelineResult: { kind: "noop", reason },
				outboxRecord: null,
			});
		}
		const eventMetadata = uiEventForMetadata(resolvedUiEvent);
		const stableSource = `${interactionId}:${tenantId}:${channelId}:${actorId}:${resolvedUiEvent.ui_id}:${resolvedUiEvent.action_id}:${resolvedUiEvent.revision.version}`;
		const stableId = sha256Hex(stableSource).slice(0, 32);
		const requestId = `discord-req-${interactionId}`;
		const deliveryId = `discord-delivery-ui-event-${stableId}`;
		const componentMeta: Record<string, unknown> = {
			adapter: this.spec.channel,
			source: "discord:component_interaction",
			interaction_id: interactionId,
			interaction_token: typeof payload.token === "string" ? payload.token : null,
			ui_event: eventMetadata,
			ui_event_token_id: tokenDecision.record.token_id,
			...(componentData?.component_type != null ? { component_type: componentData.component_type } : {}),
			...(componentData?.custom_id ? { component_custom_id: componentData.custom_id } : {}),
		};
		const messageRecord = asRecord(payload.message);
		const messageId = stringIdFrom(messageRecord?.id);
		if (messageId) {
			componentMeta.message_id = messageId;
		}
		const messageChannelId = stringIdFrom(messageRecord?.channel_id);
		if (messageChannelId) {
			componentMeta.message_channel_id = messageChannelId;
		}

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: this.spec.channel,
			channel_tenant_id: tenantId,
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
			idempotency_key: `discord-idem-ui-event-${stableId}`,
			fingerprint: `discord-fp-ui-event-${sha256Hex(normalizedText.toLowerCase())}`,
			metadata: componentMeta,
		});

		const dispatched = await runPipelineForInbound({
			pipeline: this.#pipeline,
			outbox: this.#outbox,
			inbound,
			nowMs,
			metadata: {
				...componentMeta,
				delivery_id: deliveryId,
			},
			suppressOperatorOutbox: true,
		});
		const responseData = await this.#responseDataForDispatch({
			pipelineResult: dispatched.pipelineResult,
			ackText: dispatched.ackText,
			channelTenantId: tenantId,
			channelConversationId: channelId,
			actorBindingId: bindingHint.actorBindingId,
			nowMs,
		});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({ type: 4, data: responseData }, { status: 200 }),
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}
}
