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

type SlackActionParseResult =
	| { kind: "none" }
	| {
			kind: "ok";
			teamId: string;
			channelId: string;
			actorId: string;
			triggerId: string;
			normalizedText: string;
			threadTs?: string;
		}
	| { kind: "unsupported"; reason: "unsupported_slack_action_payload" };

function parseSlackActionPayload(payloadRaw: string | null): SlackActionParseResult {
	if (!payloadRaw || payloadRaw.trim().length === 0) {
		return { kind: "none" };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(payloadRaw);
	} catch {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}
	if (!payload || typeof payload !== "object") {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}
	const data = payload as Record<string, unknown>;
	const actions = Array.isArray(data.actions) ? data.actions : [];
	const action0 = actions[0];
	if (!action0 || typeof action0 !== "object") {
		return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
	}
	const action = action0 as Record<string, unknown>;
	const value = typeof action.value === "string" ? action.value.trim() : "";
	const team = data.team && typeof data.team === "object" ? (data.team as Record<string, unknown>) : null;
	const channel = data.channel && typeof data.channel === "object" ? (data.channel as Record<string, unknown>) : null;
	const user = data.user && typeof data.user === "object" ? (data.user as Record<string, unknown>) : null;
	const teamId = typeof team?.id === "string" ? team.id : "unknown-team";
	const channelId = typeof channel?.id === "string" ? channel.id : "unknown-channel";
	const actorId = typeof user?.id === "string" ? user.id : "unknown-user";
	const triggerId = typeof data.trigger_id === "string" ? data.trigger_id : sha256Hex(payloadRaw).slice(0, 24);
	const container = data.container && typeof data.container === "object" ? (data.container as Record<string, unknown>) : null;
	const message = data.message && typeof data.message === "object" ? (data.message as Record<string, unknown>) : null;
	const threadTs = [container?.thread_ts, container?.message_ts, message?.thread_ts, message?.ts].find(
		(candidate) => typeof candidate === "string" && candidate.trim().length > 0,
	) as string | undefined;

	const confirmMatch = /^confirm:([^\s:]+)$/i.exec(value);
	if (confirmMatch?.[1]) {
		return {
			kind: "ok",
			teamId,
			channelId,
			actorId,
			triggerId,
			normalizedText: `/mu confirm ${confirmMatch[1]}`,
			...(threadTs ? { threadTs } : {}),
		};
	}
	const cancelMatch = /^cancel:([^\s:]+)$/i.exec(value);
	if (cancelMatch?.[1]) {
		return {
			kind: "ok",
			teamId,
			channelId,
			actorId,
			triggerId,
			normalizedText: `/mu cancel ${cancelMatch[1]}`,
			...(threadTs ? { threadTs } : {}),
		};
	}
	return { kind: "unsupported", reason: "unsupported_slack_action_payload" };
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
						text: "Unsupported Slack action payload. Use `/mu confirm <id>` or `/mu cancel <id>`.",
					},
					{ status: 200 },
				),
				inbound: null,
				pipelineResult: { kind: "noop", reason: parsedAction.reason },
				outboxRecord: null,
			});
		}

		const teamId = parsedAction.kind === "ok" ? parsedAction.teamId : (form.get("team_id") ?? "unknown-team");
		const channelId = parsedAction.kind === "ok" ? parsedAction.channelId : (form.get("channel_id") ?? "unknown-channel");
		const actorId = parsedAction.kind === "ok" ? parsedAction.actorId : (form.get("user_id") ?? "unknown-user");
		const command = (form.get("command") ?? "").trim();
		const text = form.get("text") ?? "";
		if (parsedAction.kind !== "ok" && command !== "/mu") {
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "slack_command_required",
				response: jsonResponse(
					{
						response_type: "ephemeral",
						text: "Slack ingress is command-only on this route. Use `/mu <command>` for actionable requests.",
					},
					{ status: 200 },
				),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "slack_command_required" },
				outboxRecord: null,
			});
		}
		const triggerId =
			parsedAction.kind === "ok"
				? parsedAction.triggerId
				: (form.get("trigger_id") ?? form.get("command_ts") ?? sha256Hex(rawBody).slice(0, 24));
		const normalizedText = parsedAction.kind === "ok" ? parsedAction.normalizedText : normalizeSlashMuCommand(text);
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
				...(parsedAction.kind === "ok" && parsedAction.threadTs ? { slack_thread_ts: parsedAction.threadTs } : {}),
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
				...(parsedAction.kind === "ok" && parsedAction.threadTs ? { slack_thread_ts: parsedAction.threadTs } : {}),
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
		const rawText = typeof event.text === "string" ? event.text.trim() : "";
		if (eventType !== "message") {
			await this.#appendAudit({
				requestId,
				deliveryId,
				teamId,
				channelId,
				actorId,
				commandText: rawText.length > 0 ? rawText : "/mu",
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

		if (!rawText.startsWith("/mu")) {
			await this.#appendAudit({
				requestId,
				deliveryId,
				teamId,
				channelId,
				actorId,
				commandText: rawText.length > 0 ? rawText : "/mu",
				event: "slack.event.ignored",
				reason: "channel_requires_explicit_command",
				metadata: { event_type: eventType, event_id: eventId },
			});
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "channel_requires_explicit_command",
				response: jsonResponse({ ok: true }, { status: 200 }),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "channel_requires_explicit_command" },
				outboxRecord: null,
			});
		}

		const triggerId = typeof event.event_ts === "string" ? event.event_ts : eventId;
		const threadTsCandidate = [event.thread_ts, event.ts].find(
			(candidate) => typeof candidate === "string" && candidate.trim().length > 0,
		) as string | undefined;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, teamId, actorId);
		const nowMs = Math.trunc(this.#nowMs());
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
					commandText: rawText,
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
					commandText: rawText,
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
					commandText: rawText,
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
					commandText: rawText,
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
			command_text: rawText,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: channelId,
			idempotency_key: `slack-idem-event-${eventId}`,
			fingerprint: `slack-fp-event-${sha256Hex(rawText.toLowerCase())}`,
			attachments: attachments.length > 0 ? attachments : undefined,
			metadata: {
				adapter: this.spec.channel,
				source: "slack:event_callback",
				event_id: eventId,
				trigger_id: triggerId,
				...(threadTsCandidate ? { slack_thread_ts: threadTsCandidate } : {}),
			},
		});

		await this.#appendAudit({
			requestId,
			deliveryId,
			teamId,
			channelId,
			actorId,
			commandText: rawText,
			event: "slack.event.accepted",
			metadata: { event_id: eventId, attachment_count: attachments.length },
		});

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
			},
		});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response: jsonResponse({ ok: true }, { status: 200 }),
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}
}
