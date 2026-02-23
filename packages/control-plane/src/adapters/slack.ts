import { AdapterAuditLog } from "../adapter_audit.js";
import {
	type AdapterIngressResult,
	type ControlPlaneAdapter,
	ControlPlaneAdapterSpecSchema,
	defaultWebhookRouteForChannel,
} from "../adapter_contract.js";
import type { ControlPlaneCommandPipeline } from "../command_pipeline.js";
import {
	evaluateInboundAttachmentPostDownload,
	evaluateInboundAttachmentPreDownload,
	inboundAttachmentExpiryMs,
	type InboundAttachmentPolicy,
	DEFAULT_INBOUND_ATTACHMENT_POLICY,
} from "../inbound_attachment_policy.js";
import { InboundAttachmentStore, toInboundAttachmentReference } from "../inbound_attachment_store.js";
import { InboundEnvelopeSchema, type AttachmentDescriptor } from "../models.js";
import type { ControlPlaneOutbox } from "../outbox.js";
import {
	acceptedIngressResult,
	hmacSha256Hex,
	jsonResponse,
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
	botToken?: string | null;
	nowMs?: () => number;
	allowedTimestampSkewSec?: number;
	fetchImpl?: typeof fetch;
	inboundAttachmentPolicy?: InboundAttachmentPolicy;
};

type SlackEventFile = {
	id: string;
	mimetype: string | null;
	size: number | null;
	name: string | null;
	url_private_download: string | null;
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

function parseSlackEventFiles(value: unknown): SlackEventFile[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: SlackEventFile[] = [];
	for (const row of value) {
		if (!row || typeof row !== "object") {
			continue;
		}
		const data = row as Record<string, unknown>;
		const id = typeof data.id === "string" ? data.id.trim() : "";
		if (id.length === 0) {
			continue;
		}
		out.push({
			id,
			mimetype: typeof data.mimetype === "string" ? data.mimetype : null,
			size: typeof data.size === "number" && Number.isFinite(data.size) ? Math.trunc(data.size) : null,
			name: typeof data.name === "string" ? data.name : null,
			url_private_download: typeof data.url_private_download === "string" ? data.url_private_download : null,
		});
	}
	return out;
}

function normalizeSlackEventCommandText(eventType: string, text: string): string {
	const trimmed = text.trim();
	if (eventType !== "app_mention") {
		return trimmed;
	}
	return trimmed.replace(/^(?:<@[^>\s]+>\s*)+/, "").trim();
}

const CONVERSATIONAL_EVENT_DEDUPE_TTL_MS = 10 * 60 * 1_000;
const CONVERSATIONAL_EVENT_DEDUPE_MAX = 4_096;

type SlackActionPayloadBase = {
	teamId: string;
	channelId: string;
	actorId: string;
	triggerId: string;
	actionTs: string;
	messageTs: string;
	threadTs: string | null;
	responseUrl: string | null;
};

type SlackActionPayloadCancelTurn = SlackActionPayloadBase & {
	kind: "cancel_turn";
	actionId: typeof SLACK_CANCEL_ACTION_ID;
};

type SlackActionPayloadHudAction = SlackActionPayloadBase & {
	kind: "hud_action";
	actionId: string;
	hudActionId: string;
	commandText: string | null;
};

export type SlackActionParseResult =
	| { kind: "none" }
	| { kind: "cancel_turn"; payload: SlackActionPayloadCancelTurn }
	| { kind: "hud_action"; payload: SlackActionPayloadHudAction }
	| { kind: "unsupported"; reason: "unsupported_slack_action_payload" };

export const SLACK_CANCEL_ACTION_ID = "mu_cancel_turn";
export const SLACK_HUD_ACTION_ID_PREFIX = "mu_hud_action:";
const SLACK_HUD_ACTION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SLACK_HUD_ACTION_COMMAND_MAX_CHARS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function firstActionRecord(value: unknown): Record<string, unknown> | null {
	if (!Array.isArray(value)) {
		return null;
	}
	for (const item of value) {
		const rec = asRecord(item);
		if (!rec) {
			continue;
		}
		if (nonEmptyString(rec.action_id)) {
			return rec;
		}
	}
	return null;
}

function normalizeSlackHudActionIdentifier(value: string): string | null {
	const trimmed = value.trim();
	if (!SLACK_HUD_ACTION_ID_RE.test(trimmed)) {
		return null;
	}
	return trimmed;
}

export function buildSlackHudActionId(hudActionId: string): string {
	const normalized = normalizeSlackHudActionIdentifier(hudActionId) ?? "action";
	return `${SLACK_HUD_ACTION_ID_PREFIX}${normalized}`;
}

function parseSlackHudActionId(actionId: string): string | null {
	const trimmed = actionId.trim();
	if (!trimmed.startsWith(SLACK_HUD_ACTION_ID_PREFIX)) {
		return null;
	}
	return normalizeSlackHudActionIdentifier(trimmed.slice(SLACK_HUD_ACTION_ID_PREFIX.length));
}

function normalizeSlackActionCommandText(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > SLACK_HUD_ACTION_COMMAND_MAX_CHARS) {
		return null;
	}
	return trimmed;
}

function safeCommandTextForSlackAction(action: SlackActionPayloadCancelTurn | SlackActionPayloadHudAction): string | null {
	if (action.kind === "cancel_turn") {
		return "cancel";
	}
	const HUD_ACTION_COMMAND_MAP: Record<string, string> = {
		"operator.cancel": "cancel",
	};
	const mapped = HUD_ACTION_COMMAND_MAP[action.hudActionId];
	if (mapped) {
		return mapped;
	}
	return normalizeSlackActionCommandText(action.commandText);
}

export function parseSlackActionPayload(payloadRaw: string | null): SlackActionParseResult {
	if (!payloadRaw || payloadRaw.trim().length === 0) {
		return { kind: "none" };
	}

	let payload: Record<string, unknown> | null = null;
	try {
		payload = asRecord(JSON.parse(payloadRaw));
	} catch {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}
	if (!payload) {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}

	if (nonEmptyString(payload.type) !== "block_actions") {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}

	const action = firstActionRecord(payload.actions);
	if (!action) {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}
	const actionId = nonEmptyString(action.action_id);
	if (!actionId) {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}

	const team = asRecord(payload.team);
	const channel = asRecord(payload.channel);
	const user = asRecord(payload.user);
	const container = asRecord(payload.container);
	const message = asRecord(payload.message);

	const teamId = nonEmptyString(team?.id) ?? nonEmptyString(user?.team_id);
	const channelId = nonEmptyString(channel?.id) ?? nonEmptyString(container?.channel_id);
	const actorId = nonEmptyString(user?.id);
	const triggerId =
		nonEmptyString(payload.trigger_id) ??
		nonEmptyString(action.action_ts) ??
		nonEmptyString(container?.message_ts);
	const messageTs = nonEmptyString(container?.message_ts) ?? nonEmptyString(message?.ts);
	if (!teamId || !channelId || !actorId || !triggerId || !messageTs) {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}

	const threadTs = nonEmptyString(message?.thread_ts) ?? nonEmptyString(message?.ts) ?? null;
	const actionTs = nonEmptyString(action.action_ts) ?? triggerId;
	const actionCommandText = normalizeSlackActionCommandText(nonEmptyString(action.value));
	const basePayload = {
		teamId,
		channelId,
		actorId,
		triggerId,
		actionTs,
		messageTs,
		threadTs,
		responseUrl: nonEmptyString(payload.response_url),
	};
	if (actionId === SLACK_CANCEL_ACTION_ID) {
		return {
			kind: "cancel_turn",
			payload: {
				kind: "cancel_turn",
				actionId: SLACK_CANCEL_ACTION_ID,
				...basePayload,
			},
		};
	}
	const hudActionId = parseSlackHudActionId(actionId);
	if (hudActionId) {
		return {
			kind: "hud_action",
			payload: {
				kind: "hud_action",
				actionId,
				hudActionId,
				commandText: actionCommandText,
				...basePayload,
			},
		};
	}
	return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
}

const SLACK_PROGRESS_REQUEST_PREVIEW_MAX_CHARS = 96;
const SLACK_PROGRESS_DELAY_NOTICE_MS = 2 * 60 * 1_000;
const SLACK_PROGRESS_RETRY_HINT_MS = 8 * 60 * 1_000;

function compactSingleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function summarizeSlackRequest(commandText: string): string {
	const compact = compactSingleLine(commandText);
	if (compact.length === 0) {
		return "(request text unavailable)";
	}
	if (compact.length <= SLACK_PROGRESS_REQUEST_PREVIEW_MAX_CHARS) {
		return compact;
	}
	return `${compact.slice(0, SLACK_PROGRESS_REQUEST_PREVIEW_MAX_CHARS - 1)}…`;
}

function progressPhaseForElapsedMs(elapsedMs: number): { stage: string; phase: string } {
	if (elapsedMs < 15_000) {
		return { stage: "working_heartbeat.analyzing", phase: "Analyzing the request" };
	}
	if (elapsedMs < 90_000) {
		return { stage: "working_heartbeat.reasoning", phase: "Reasoning about the best approach" };
	}
	if (elapsedMs < 4 * 60 * 1_000) {
		return { stage: "working_heartbeat.executing", phase: "Running tools and validating results" };
	}
	return { stage: "working_heartbeat.delayed", phase: "Still running long-tail steps" };
}

export function buildSlackProgressActionBlocks(statusText: string): Record<string, unknown>[] {
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: statusText,
			},
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: SLACK_CANCEL_ACTION_ID,
					text: {
						type: "plain_text",
						text: "Cancel turn",
						emoji: true,
					},
					style: "danger",
					value: "cancel_turn",
					confirm: {
						title: { type: "plain_text", text: "Cancel this turn?" },
						text: {
							type: "plain_text",
							text: "The current in-thread operator turn will be aborted.",
							emoji: true,
						},
						confirm: { type: "plain_text", text: "Cancel turn", emoji: true },
						deny: { type: "plain_text", text: "Keep running", emoji: true },
					},
				},
			],
		},
	];
}

export function formatSlackWorkingHeartbeat(opts: {
	commandText: string;
	elapsedMs: number;
}): {
	text: string;
	stage: string;
} {
	const elapsedSec = Math.max(1, Math.trunc(opts.elapsedMs / 1000));
	const phase = progressPhaseForElapsedMs(opts.elapsedMs);
	const lines = [
		"INFO mu · ACK · WORKING",
		`Phase: ${phase.phase}`,
		`Request: ${summarizeSlackRequest(opts.commandText)}`,
		`Elapsed: ${elapsedSec}s`,
	];
	if (opts.elapsedMs >= SLACK_PROGRESS_DELAY_NOTICE_MS) {
		lines.push("This is taking longer than expected, but the turn is still active.");
	}
	if (opts.elapsedMs >= SLACK_PROGRESS_RETRY_HINT_MS) {
		lines.push("If this seems stuck, run `/mu status` in parallel, or send `cancel` / `/mu cancel` to abort this thread turn.");
	}
	return {
		text: lines.join("\n"),
		stage: phase.stage,
	};
}

function formatSlackOperatorTurnStartText(commandText: string): string {
	return [
		"INFO mu · ACK · WORKING",
		"Running the operator turn now.",
		`Request: ${summarizeSlackRequest(commandText)}`,
	].join("\n");
}

export class SlackControlPlaneAdapter implements ControlPlaneAdapter {
	public readonly spec = SlackControlPlaneAdapterSpec;
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #outbox: ControlPlaneOutbox;
	readonly #signingSecret: string;
	readonly #botToken: string | null;
	readonly #nowMs: () => number;
	readonly #allowedTimestampSkewSec: number;
	readonly #fetchImpl: typeof fetch;
	readonly #inboundAttachmentPolicy: InboundAttachmentPolicy;
	readonly #inboundAttachmentStore: InboundAttachmentStore | null;
	readonly #adapterAudit: AdapterAuditLog | null;
	readonly #conversationalEventInFlight = new Set<string>();
	readonly #conversationalEventSeenUntilMs = new Map<string, number>();

	public constructor(opts: SlackControlPlaneAdapterOpts) {
		this.#pipeline = opts.pipeline;
		this.#outbox = opts.outbox;
		this.#signingSecret = opts.signingSecret;
		this.#botToken = opts.botToken?.trim() || null;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#allowedTimestampSkewSec = Math.max(1, Math.trunc(opts.allowedTimestampSkewSec ?? 5 * 60));
		this.#fetchImpl = opts.fetchImpl ?? fetch;
		this.#inboundAttachmentPolicy = opts.inboundAttachmentPolicy ?? DEFAULT_INBOUND_ATTACHMENT_POLICY;
		const runtimePaths = this.#pipeline?.runtime?.paths;
		if (runtimePaths) {
			this.#inboundAttachmentStore = new InboundAttachmentStore({
				indexPath: runtimePaths.attachmentIndexPath,
				blobRootDir: runtimePaths.attachmentBlobRootDir,
			});
			this.#adapterAudit = new AdapterAuditLog(runtimePaths.adapterAuditPath);
		} else {
			this.#inboundAttachmentStore = null;
			this.#adapterAudit = null;
		}
	}

	async #appendAudit(opts: {
		requestId: string;
		deliveryId: string;
		teamId: string;
		channelId: string;
		actorId: string;
		commandText: string;
		event: string;
		reason?: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		if (!this.#adapterAudit) {
			return;
		}
		try {
			await this.#adapterAudit.append({
				ts_ms: Math.trunc(this.#nowMs()),
				channel: this.spec.channel,
				request_id: opts.requestId,
				delivery_id: opts.deliveryId,
				channel_tenant_id: opts.teamId,
				channel_conversation_id: opts.channelId,
				actor_id: opts.actorId,
				command_text: opts.commandText,
				event: opts.event,
				reason: opts.reason ?? null,
				metadata: opts.metadata ?? {},
			});
		} catch {
			// Adapter audit must never break ingress.
		}
	}

	#pruneConversationalEventDedupe(nowMs: number): void {
		for (const [key, expiresAtMs] of this.#conversationalEventSeenUntilMs.entries()) {
			if (expiresAtMs <= nowMs) {
				this.#conversationalEventSeenUntilMs.delete(key);
			}
		}
		if (this.#conversationalEventSeenUntilMs.size <= CONVERSATIONAL_EVENT_DEDUPE_MAX) {
			return;
		}
		const byExpiry = [...this.#conversationalEventSeenUntilMs.entries()].sort((a, b) => a[1] - b[1]);
		while (this.#conversationalEventSeenUntilMs.size > CONVERSATIONAL_EVENT_DEDUPE_MAX && byExpiry.length > 0) {
			const [key] = byExpiry.shift()!;
			this.#conversationalEventSeenUntilMs.delete(key);
		}
	}

	#isDuplicateConversationalEvent(key: string, nowMs: number): "in_flight" | "seen" | null {
		this.#pruneConversationalEventDedupe(nowMs);
		if (this.#conversationalEventInFlight.has(key)) {
			return "in_flight";
		}
		const seenUntil = this.#conversationalEventSeenUntilMs.get(key);
		if (seenUntil && seenUntil > nowMs) {
			return "seen";
		}
		return null;
	}

	#markConversationalEventSeen(key: string, nowMs: number): void {
		this.#conversationalEventSeenUntilMs.set(key, nowMs + CONVERSATIONAL_EVENT_DEDUPE_TTL_MS);
		this.#pruneConversationalEventDedupe(nowMs);
	}

	async #postProgressAnchor(opts: {
		requestId: string;
		deliveryId: string;
		teamId: string;
		channelId: string;
		actorId: string;
		commandText: string;
		threadTs?: string;
		eventId: string;
	}): Promise<string | null> {
		if (!this.#botToken) {
			await this.#appendAudit({
				requestId: opts.requestId,
				deliveryId: opts.deliveryId,
				teamId: opts.teamId,
				channelId: opts.channelId,
				actorId: opts.actorId,
				commandText: opts.commandText.length > 0 ? opts.commandText : "/mu",
				event: "slack.progress_anchor.skipped",
				reason: "slack_bot_token_required",
				metadata: { event_id: opts.eventId },
			});
			return null;
		}

		const progressText = [
			"INFO mu · ACK · ACCEPTED",
			"Working this request in-thread. I will update this message with final output.",
			`Request: ${summarizeSlackRequest(opts.commandText)}`,
		].join("\n");
		const payload = {
			channel: opts.channelId,
			text: progressText,
			blocks: buildSlackProgressActionBlocks(progressText),
			unfurl_links: false,
			unfurl_media: false,
			...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
		};

		try {
			const response = await this.#fetchImpl("https://slack.com/api/chat.postMessage", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			});
			const body = (await response.json().catch(() => null)) as
				| { ok?: boolean; error?: string; ts?: string }
				| null;
			if (response.ok && body?.ok === true && typeof body.ts === "string" && body.ts.trim().length > 0) {
				await this.#appendAudit({
					requestId: opts.requestId,
					deliveryId: opts.deliveryId,
					teamId: opts.teamId,
					channelId: opts.channelId,
					actorId: opts.actorId,
					commandText: opts.commandText.length > 0 ? opts.commandText : "/mu",
					event: "slack.progress_anchor.sent",
					metadata: { event_id: opts.eventId, progress_anchor_ts: body.ts.trim() },
				});
				return body.ts.trim();
			}
			await this.#appendAudit({
				requestId: opts.requestId,
				deliveryId: opts.deliveryId,
				teamId: opts.teamId,
				channelId: opts.channelId,
				actorId: opts.actorId,
				commandText: opts.commandText.length > 0 ? opts.commandText : "/mu",
				event: "slack.progress_anchor.failed",
				reason: body?.error ?? `http_${response.status}`,
				metadata: { event_id: opts.eventId, http_status: response.status },
			});
			return null;
		} catch (err) {
			await this.#appendAudit({
				requestId: opts.requestId,
				deliveryId: opts.deliveryId,
				teamId: opts.teamId,
				channelId: opts.channelId,
				actorId: opts.actorId,
				commandText: opts.commandText.length > 0 ? opts.commandText : "/mu",
				event: "slack.progress_anchor.failed",
				reason: err instanceof Error ? err.message : "progress_anchor_failed",
				metadata: { event_id: opts.eventId },
			});
			return null;
		}
	}

	async #updateProgressAnchor(opts: {
		requestId: string;
		deliveryId: string;
		teamId: string;
		channelId: string;
		actorId: string;
		commandText: string;
		eventId: string;
		statusMessageTs: string;
		text: string;
		blocks?: Record<string, unknown>[];
		stage: string;
		elapsedMs?: number;
		tick?: number;
	}): Promise<boolean> {
		if (!this.#botToken) {
			return false;
		}
		try {
			const response = await this.#fetchImpl("https://slack.com/api/chat.update", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					channel: opts.channelId,
					ts: opts.statusMessageTs,
					text: opts.text,
					...(opts.blocks ? { blocks: opts.blocks } : {}),
					unfurl_links: false,
					unfurl_media: false,
				}),
			});
			const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
			if (response.ok && body?.ok === true) {
				await this.#appendAudit({
					requestId: opts.requestId,
					deliveryId: opts.deliveryId,
					teamId: opts.teamId,
					channelId: opts.channelId,
					actorId: opts.actorId,
					commandText: opts.commandText.length > 0 ? opts.commandText : "/mu",
					event: "slack.progress_checkpoint.sent",
					metadata: {
						event_id: opts.eventId,
						stage: opts.stage,
						status_message_ts: opts.statusMessageTs,
						elapsed_ms: opts.elapsedMs,
						tick: opts.tick,
					},
				});
				return true;
			}
			await this.#appendAudit({
				requestId: opts.requestId,
				deliveryId: opts.deliveryId,
				teamId: opts.teamId,
				channelId: opts.channelId,
				actorId: opts.actorId,
				commandText: opts.commandText.length > 0 ? opts.commandText : "/mu",
				event: "slack.progress_checkpoint.failed",
				reason: body?.error ?? `http_${response.status}`,
				metadata: {
					event_id: opts.eventId,
					stage: opts.stage,
					status_message_ts: opts.statusMessageTs,
					http_status: response.status,
				},
			});
			return false;
		} catch (err) {
			await this.#appendAudit({
				requestId: opts.requestId,
				deliveryId: opts.deliveryId,
				teamId: opts.teamId,
				channelId: opts.channelId,
				actorId: opts.actorId,
				commandText: opts.commandText.length > 0 ? opts.commandText : "/mu",
				event: "slack.progress_checkpoint.failed",
				reason: err instanceof Error ? err.message : "progress_checkpoint_failed",
				metadata: {
					event_id: opts.eventId,
					stage: opts.stage,
					status_message_ts: opts.statusMessageTs,
				},
			});
			return false;
		}
	}

	#startProgressTicker(opts: {
		requestId: string;
		deliveryId: string;
		teamId: string;
		channelId: string;
		actorId: string;
		commandText: string;
		eventId: string;
		statusMessageTs: string;
		startedAtMs: number;
	}): () => void {
		let stopped = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let tick = 0;

		const emitTick = async (): Promise<void> => {
			if (stopped) {
				return;
			}
			tick += 1;
			const elapsedMs = Math.max(0, Math.trunc(this.#nowMs()) - opts.startedAtMs);
			const heartbeat = formatSlackWorkingHeartbeat({
				commandText: opts.commandText,
				elapsedMs,
			});
			await this.#updateProgressAnchor({
				requestId: opts.requestId,
				deliveryId: opts.deliveryId,
				teamId: opts.teamId,
				channelId: opts.channelId,
				actorId: opts.actorId,
				commandText: opts.commandText,
				eventId: opts.eventId,
				statusMessageTs: opts.statusMessageTs,
				text: heartbeat.text,
				blocks: buildSlackProgressActionBlocks(heartbeat.text),
				stage: heartbeat.stage,
				elapsedMs,
				tick,
			});
		};

		timeoutHandle = setTimeout(() => {
			void emitTick();
			intervalHandle = setInterval(() => {
				void emitTick();
			}, 12_000);
		}, 3_000);

		return () => {
			stopped = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
			if (intervalHandle) {
				clearInterval(intervalHandle);
				intervalHandle = null;
			}
		};
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

		const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
		if (contentType.includes("application/json")) {
			return await this.#ingestEventPayload(req, rawBody);
		}
		return await this.#ingestSlashCommand(req, rawBody);
	}

	async #ingestSlashCommand(req: Request, rawBody: string): Promise<AdapterIngressResult> {
		const form = new URLSearchParams(rawBody);
		const parsedAction = parseSlackActionPayload(form.get("payload"));
		if (parsedAction.kind === "unsupported") {
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: parsedAction.reason,
				response: jsonResponse(
					{
						response_type: "ephemeral",
						text: "Unsupported Slack action payload. Use slash/app-mention ingress or the built-in Cancel turn button.",
					},
					{ status: 200 },
				),
				inbound: null,
				pipelineResult: { kind: "noop", reason: parsedAction.reason },
				outboxRecord: null,
			});
		}

		if (parsedAction.kind === "cancel_turn" || parsedAction.kind === "hud_action") {
			const action = parsedAction.payload;
			const normalizedText = safeCommandTextForSlackAction(action);
			if (!normalizedText) {
				return acceptedIngressResult({
					channel: this.spec.channel,
					reason: "unsupported_slack_action_payload",
					response: jsonResponse(
						{
							response_type: "ephemeral",
							text: "Unsupported Slack HUD action callback.",
						},
						{ status: 200 },
					),
					inbound: null,
					pipelineResult: { kind: "noop", reason: "unsupported_slack_action_payload" },
					outboxRecord: null,
				});
			}
			const stableSource = `${action.teamId}:${action.channelId}:${action.actorId}:${action.triggerId}:${action.actionTs}:${action.messageTs}:${action.actionId}:${normalizedText}`;
			const stableId = sha256Hex(stableSource).slice(0, 32);
			const requestIdHeader = req.headers.get("x-slack-request-id");
			const requestId =
				requestIdHeader && requestIdHeader.trim().length > 0
					? `slack-req-${requestIdHeader.trim()}`
					: `slack-req-action-${stableId}`;
			const deliveryId = `slack-delivery-action-${stableId}`;
			const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, action.teamId, action.actorId);
			const nowMs = Math.trunc(this.#nowMs());
			const actionMetadata: Record<string, unknown> = {
				adapter: this.spec.channel,
				source: "slack:action_payload",
				action_id: action.actionId,
				action_ts: action.actionTs,
				trigger_id: action.triggerId,
				slack_message_ts: action.messageTs,
				...(action.threadTs ? { slack_thread_ts: action.threadTs } : {}),
				slack_status_message_ts: action.messageTs,
				response_url: action.responseUrl,
				action_provenance: "slack:block_actions",
				...(action.kind === "hud_action"
					? {
						hud_action_id: action.hudActionId,
						hud_action_command_text: normalizedText,
					}
					: {}),
			};
			const inbound = InboundEnvelopeSchema.parse({
				v: 1,
				received_at_ms: nowMs,
				request_id: requestId,
				delivery_id: deliveryId,
				channel: this.spec.channel,
				channel_tenant_id: action.teamId,
				channel_conversation_id: action.channelId,
				actor_id: action.actorId,
				actor_binding_id: bindingHint.actorBindingId,
				assurance_tier: bindingHint.assuranceTier,
				repo_root: this.#pipeline.runtime.paths.repoRoot,
				command_text: normalizedText,
				scope_required: "cp.read",
				scope_effective: "cp.read",
				target_type: "status",
				target_id: action.channelId,
				idempotency_key: `slack-idem-action-${stableId}`,
				fingerprint: `slack-fp-action-${sha256Hex(normalizedText)}`,
				metadata: actionMetadata,
			});

			await this.#appendAudit({
				requestId,
				deliveryId,
				teamId: action.teamId,
				channelId: action.channelId,
				actorId: action.actorId,
				commandText: normalizedText,
				event: "slack.action.accepted",
				metadata: {
					action_id: action.actionId,
					message_ts: action.messageTs,
					thread_ts: action.threadTs,
					action_provenance: "slack:block_actions",
					...(action.kind === "hud_action" ? { hud_action_id: action.hudActionId } : {}),
				},
			});

			const dispatched = await runPipelineForInbound({
				pipeline: this.#pipeline,
				outbox: this.#outbox,
				inbound,
				nowMs,
				metadata: {
					...actionMetadata,
					delivery_id: deliveryId,
				},
				forceOutbox: true,
			});

			return acceptedIngressResult({
				channel: this.spec.channel,
				response: textResponse("", { status: 200 }),
				inbound,
				pipelineResult: dispatched.pipelineResult,
				outboxRecord: dispatched.outboxRecord,
			});
		}

		const teamId = form.get("team_id") ?? "unknown-team";
		const channelId = form.get("channel_id") ?? "unknown-channel";
		const actorId = form.get("user_id") ?? "unknown-user";
		const command = (form.get("command") ?? "").trim();
		const text = (form.get("text") ?? "").trim();
		const triggerId = form.get("trigger_id") ?? form.get("command_ts") ?? sha256Hex(rawBody).slice(0, 24);
		const normalizedText = text.length > 0 ? text : command;
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
				source: "slack:slash_command",
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
				source: "slack:slash_command",
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

	async #ingestEventPayload(req: Request, rawBody: string): Promise<AdapterIngressResult> {
		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(rawBody) as unknown;
			if (!parsed || typeof parsed !== "object") {
				throw new Error("invalid_json");
			}
			payload = parsed as Record<string, unknown>;
		} catch {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_json",
				response: textResponse("invalid_json", { status: 400 }),
			});
		}

		if (payload.type === "url_verification") {
			const challenge = typeof payload.challenge === "string" ? payload.challenge : "";
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "slack_url_verification",
				response: jsonResponse({ challenge }, { status: 200 }),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "not_command" },
				outboxRecord: null,
			});
		}

		const event = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : null;
		const teamId = typeof payload.team_id === "string" ? payload.team_id : "unknown-team";
		const eventId = typeof payload.event_id === "string" ? payload.event_id : sha256Hex(rawBody).slice(0, 24);
		const requestIdHeader = req.headers.get("x-slack-request-id");
		const requestId =
			requestIdHeader && requestIdHeader.trim().length > 0
				? `slack-req-${requestIdHeader.trim()}`
				: `slack-req-event-${eventId}`;
		const deliveryId = `slack-delivery-event-${eventId}`;

		if (!event || payload.type !== "event_callback") {
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "unsupported_slack_event",
				response: jsonResponse({ ok: true }, { status: 200 }),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "not_command" },
				outboxRecord: null,
			});
		}

		const eventType = typeof event.type === "string" ? event.type : "";
		const channelId = typeof event.channel === "string" ? event.channel : "unknown-channel";
		const actorId = typeof event.user === "string" ? event.user : "unknown-user";
		const rawText = typeof event.text === "string" ? event.text : "";
		const normalizedText = normalizeSlackEventCommandText(eventType, rawText);
		if (eventType !== "app_mention") {
			await this.#appendAudit({
				requestId,
				deliveryId,
				teamId,
				channelId,
				actorId,
				commandText: normalizedText.length > 0 ? normalizedText : "/mu",
				event: "slack.event.ignored",
				reason: "unsupported_slack_event",
				metadata: { event_type: eventType, event_id: eventId },
			});
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "unsupported_slack_event",
				response: jsonResponse({ ok: true }, { status: 200 }),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "not_command" },
				outboxRecord: null,
			});
		}

		const triggerId = typeof event.event_ts === "string" ? event.event_ts : eventId;
		const threadTsCandidate = [event.thread_ts, event.ts].find(
			(candidate) => typeof candidate === "string" && candidate.trim().length > 0,
		) as string | undefined;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, teamId, actorId);
		const nowMs = Math.trunc(this.#nowMs());
		const conversationalEventKey = `slack:${teamId}:${eventId}`;
		const duplicateReason = this.#isDuplicateConversationalEvent(conversationalEventKey, nowMs);
		if (duplicateReason) {
			await this.#appendAudit({
				requestId,
				deliveryId,
				teamId,
				channelId,
				actorId,
				commandText: normalizedText.length > 0 ? normalizedText : "/mu",
				event: "slack.event.ignored",
				reason: "duplicate_slack_event",
				metadata: {
					event_id: eventId,
					event_type: eventType,
					duplicate_reason: duplicateReason,
				},
			});
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "duplicate_slack_event",
				response: jsonResponse({ ok: true }, { status: 200 }),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "duplicate_slack_event" },
				outboxRecord: null,
			});
		}
		this.#conversationalEventInFlight.add(conversationalEventKey);
		const progressAnchorTs = await this.#postProgressAnchor({
			requestId,
			deliveryId,
			teamId,
			channelId,
			actorId,
			commandText: normalizedText,
			threadTs: threadTsCandidate,
			eventId,
		});
		const attachments: AttachmentDescriptor[] = [];
		for (const file of parseSlackEventFiles(event.files)) {
			const pre = evaluateInboundAttachmentPreDownload(
				{
					channel: "slack",
					adapter: this.spec.channel,
					attachment_id: `slack-file-${file.id}`,
					channel_file_id: file.id,
					declared_mime_type: file.mimetype,
					declared_size_bytes: file.size,
				},
				this.#inboundAttachmentPolicy,
			);
			if (pre.kind === "deny") {
				await this.#appendAudit({
					requestId,
					deliveryId,
					teamId,
					channelId,
					actorId,
					commandText: normalizedText,
					event: "slack.file.pre_download.deny",
					reason: pre.reason,
					metadata: { event_id: eventId, file_id: file.id, ...pre.audit },
				});
				continue;
			}
			if (!this.#botToken || !file.url_private_download) {
				await this.#appendAudit({
					requestId,
					deliveryId,
					teamId,
					channelId,
					actorId,
					commandText: normalizedText,
					event: "slack.file.download.skipped",
					reason: "slack_bot_token_required",
					metadata: { event_id: eventId, file_id: file.id },
				});
				continue;
			}
			let bytes: Uint8Array;
			try {
				const response = await this.#fetchImpl(file.url_private_download, {
					headers: {
						Authorization: `Bearer ${this.#botToken}`,
					},
				});
				if (!response.ok) {
					throw new Error(`http_${response.status}`);
				}
				const buffer = await response.arrayBuffer();
				bytes = new Uint8Array(buffer);
			} catch (err) {
				await this.#appendAudit({
					requestId,
					deliveryId,
					teamId,
					channelId,
					actorId,
					commandText: normalizedText,
					event: "slack.file.download.failed",
					reason: err instanceof Error ? err.message : "download_failed",
					metadata: { event_id: eventId, file_id: file.id },
				});
				continue;
			}
			const store = this.#inboundAttachmentStore;
			if (!store) {
				continue;
			}
			const ttlMs = inboundAttachmentExpiryMs(nowMs, this.#inboundAttachmentPolicy) - nowMs;
			const put = await store.put({
				channel: "slack",
				source: "slack",
				sourceFileId: file.id,
				filename: file.name,
				mimeType: file.mimetype,
				bytes,
				nowMs,
				ttlMs,
				metadata: {
					event_id: eventId,
					channel_id: channelId,
				},
			});
			const post = evaluateInboundAttachmentPostDownload(
				{
					channel: "slack",
					attachment_id: put.record.attachment_id,
					channel_file_id: put.record.source_file_id,
					stored_mime_type: put.record.mime_type,
					stored_size_bytes: put.record.size_bytes,
					content_hash: put.record.content_hash_sha256,
					malware_flagged: false,
				},
				this.#inboundAttachmentPolicy,
			);
			if (post.kind === "deny") {
				await this.#appendAudit({
					requestId,
					deliveryId,
					teamId,
					channelId,
					actorId,
					commandText: normalizedText,
					event: "slack.file.post_download.deny",
					reason: post.reason,
					metadata: { event_id: eventId, file_id: file.id, ...post.audit },
				});
				continue;
			}
			attachments.push({
				type: "document",
				filename: put.record.safe_filename,
				mime_type: put.record.mime_type,
				size_bytes: put.record.size_bytes,
				reference: toInboundAttachmentReference(put.record),
				metadata: {
					channel_file_id: file.id,
					dedupe_kind: put.dedupe_kind,
				},
			});
		}

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
			idempotency_key: `slack-idem-event-${eventId}`,
			fingerprint: `slack-fp-event-${sha256Hex(normalizedText.toLowerCase())}`,
			attachments: attachments.length > 0 ? attachments : undefined,
			metadata: {
				adapter: this.spec.channel,
				source: "slack:event_callback",
				event_id: eventId,
				trigger_id: triggerId,
				...(threadTsCandidate ? { slack_thread_ts: threadTsCandidate } : {}),
				...(progressAnchorTs ? { slack_status_message_ts: progressAnchorTs } : {}),
			},
		});

		await this.#appendAudit({
			requestId,
			deliveryId,
			teamId,
			channelId,
			actorId,
			commandText: normalizedText,
			event: "slack.event.accepted",
			metadata: {
				event_id: eventId,
				attachment_count: attachments.length,
				...(progressAnchorTs ? { progress_anchor_ts: progressAnchorTs } : {}),
			},
		});

		const turnStartedAtMs = Math.trunc(this.#nowMs());
		const stopProgressTicker = progressAnchorTs
			? this.#startProgressTicker({
					requestId,
					deliveryId,
					teamId,
					channelId,
					actorId,
					commandText: normalizedText,
					eventId,
					statusMessageTs: progressAnchorTs,
					startedAtMs: turnStartedAtMs,
				})
			: null;
		if (progressAnchorTs) {
			const turnStartText = formatSlackOperatorTurnStartText(normalizedText);
			await this.#updateProgressAnchor({
				requestId,
				deliveryId,
				teamId,
				channelId,
				actorId,
				commandText: normalizedText,
				eventId,
				statusMessageTs: progressAnchorTs,
				text: turnStartText,
				blocks: buildSlackProgressActionBlocks(turnStartText),
				stage: "operator_turn_start",
				elapsedMs: 0,
				tick: 0,
			});
		}
		await this.#appendAudit({
			requestId,
			deliveryId,
			teamId,
			channelId,
			actorId,
			commandText: normalizedText,
			event: "slack.operator_turn.started",
			metadata: {
				event_id: eventId,
				attachment_count: attachments.length,
				...(progressAnchorTs ? { progress_anchor_ts: progressAnchorTs } : {}),
			},
		});

		try {
			const dispatched = await runPipelineForInbound({
				pipeline: this.#pipeline,
				outbox: this.#outbox,
				inbound,
				nowMs,
				metadata: {
					adapter: this.spec.channel,
					delivery_id: deliveryId,
					source: "slack:event_callback",
					event_id: eventId,
					...(threadTsCandidate ? { slack_thread_ts: threadTsCandidate } : {}),
					...(progressAnchorTs ? { slack_status_message_ts: progressAnchorTs } : {}),
				},
				forceOutbox: true,
			});

			if (
				progressAnchorTs &&
				dispatched.pipelineResult.kind === "noop" &&
				dispatched.pipelineResult.reason === "operator_cancelled"
			) {
				await this.#updateProgressAnchor({
					requestId,
					deliveryId,
					teamId,
					channelId,
					actorId,
					commandText: normalizedText,
					eventId,
					statusMessageTs: progressAnchorTs,
					text: "INFO mu · ACK · CANCELLED\nThis operator turn was cancelled.",
					blocks: [],
					stage: "operator_turn_cancelled",
					elapsedMs: Math.max(0, Math.trunc(this.#nowMs()) - turnStartedAtMs),
					tick: undefined,
				});
			}

			await this.#appendAudit({
				requestId,
				deliveryId,
				teamId,
				channelId,
				actorId,
				commandText: normalizedText,
				event: "slack.operator_turn.completed",
				metadata: {
					event_id: eventId,
					pipeline_result_kind: dispatched.pipelineResult.kind,
					elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - turnStartedAtMs),
					...(progressAnchorTs ? { progress_anchor_ts: progressAnchorTs } : {}),
				},
			});

			return acceptedIngressResult({
				channel: this.spec.channel,
				response: jsonResponse({ ok: true }, { status: 200 }),
				inbound,
				pipelineResult: dispatched.pipelineResult,
				outboxRecord: dispatched.outboxRecord,
			});
		} finally {
			stopProgressTicker?.();
			this.#conversationalEventInFlight.delete(conversationalEventKey);
			this.#markConversationalEventSeen(conversationalEventKey, Math.trunc(this.#nowMs()));
		}
	}
}
