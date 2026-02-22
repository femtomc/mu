import { join } from "node:path";
import { AdapterAuditLog } from "../adapter_audit.js";
import {
	DEFAULT_INBOUND_ATTACHMENT_POLICY,
	evaluateInboundAttachmentPostDownload,
	evaluateInboundAttachmentPreDownload,
	inboundAttachmentExpiryMs,
	type InboundAttachmentPolicy,
} from "../inbound_attachment_policy.js";
import {
	buildInboundAttachmentStorePaths,
	InboundAttachmentStore,
	toInboundAttachmentReference,
} from "../inbound_attachment_store.js";
import {
	type AdapterIngressResult,
	type ControlPlaneAdapter,
	ControlPlaneAdapterSpecSchema,
	defaultWebhookRouteForChannel,
} from "../adapter_contract.js";
import type { ControlPlaneCommandPipeline } from "../command_pipeline.js";
import { type InboundEnvelope, InboundEnvelopeSchema } from "../models.js";
import type { ControlPlaneSignalObserver } from "../observability.js";
import type { ControlPlaneOutbox } from "../outbox.js";
import { TelegramIngressQueue, type TelegramIngressRecord } from "../telegram_ingress_queue.js";
import {
	acceptedIngressResult,
	jsonResponse,
	rejectedIngressResult,
	resolveBindingHint,
	runPipelineForInbound,
	sha256Hex,
	stringId,
	textResponse,
	timingSafeEqualUtf8,
} from "./shared.js";

type TelegramWebhookSendMessagePayload = {
	method: "sendMessage";
	chat_id: string;
	text: string;
	disable_notification?: boolean;
	reply_to_message_id?: number;
	allow_sending_without_reply?: boolean;
};

type TelegramWebhookAnswerCallbackPayload = {
	method: "answerCallbackQuery";
	callback_query_id: string;
	text?: string;
	show_alert?: boolean;
};

type TelegramWebhookSendChatActionPayload = {
	method: "sendChatAction";
	chat_id: string;
	action: "typing";
};

type TelegramWebhookMethodPayload =
	| TelegramWebhookSendMessagePayload
	| TelegramWebhookAnswerCallbackPayload
	| TelegramWebhookSendChatActionPayload;

type TelegramMessageAttachmentCandidate = {
	telegram_type: "document" | "photo";
	file_id: string;
	file_unique_id: string | null;
	filename: string | null;
	mime_type: string | null;
	size_bytes: number | null;
	width: number | null;
	height: number | null;
};

function telegramWebhookMethodResponse(payload: TelegramWebhookMethodPayload): Response {
	return jsonResponse(payload, { status: 200 });
}

function truncateTelegramWebhookText(text: string, maxLen: number = 3_500): string {
	if (text.length <= maxLen) {
		return text;
	}
	if (maxLen <= 16) {
		return text.slice(0, maxLen);
	}
	const suffix = "\n…(truncated)";
	const headLen = Math.max(0, maxLen - suffix.length);
	return `${text.slice(0, headLen)}${suffix}`;
}

function maybeParseIntegerId(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!/^-?\d+$/.test(trimmed)) {
			return null;
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

function summarizeTelegramCallbackAck(text: string): string {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		if (line.length <= 160) {
			return line;
		}
		return `${line.slice(0, 157)}...`;
	}
	return "Processed request.";
}

function normalizeTelegramMessageCommand(text: string, _botUsername: string | null): string {
	return text.trim();
}

function normalizeTelegramCallbackData(_data: string): string | null {
	return null;
}

function extractTelegramMessageAttachments(message: Record<string, unknown>): TelegramMessageAttachmentCandidate[] {
	const out: TelegramMessageAttachmentCandidate[] = [];
	const doc = message.document as Record<string, unknown> | undefined;
	const docFileId = stringId(doc?.file_id);
	if (doc && docFileId) {
		out.push({
			telegram_type: "document",
			file_id: docFileId,
			file_unique_id: stringId(doc.file_unique_id),
			filename: typeof doc.file_name === "string" ? doc.file_name : null,
			mime_type: typeof doc.mime_type === "string" ? doc.mime_type : null,
			size_bytes: typeof doc.file_size === "number" ? Math.trunc(doc.file_size) : null,
			width: null,
			height: null,
		});
	}
	const photos = Array.isArray(message.photo) ? message.photo : [];
	let selectedPhoto: Record<string, unknown> | null = null;
	for (const entry of photos) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const photo = entry as Record<string, unknown>;
		if (!stringId(photo.file_id)) {
			continue;
		}
		if (!selectedPhoto) {
			selectedPhoto = photo;
			continue;
		}
		const currentSize = typeof photo.file_size === "number" ? photo.file_size : -1;
		const selectedSize = typeof selectedPhoto.file_size === "number" ? selectedPhoto.file_size : -1;
		if (currentSize > selectedSize) {
			selectedPhoto = photo;
		}
	}
	const photoFileId = stringId(selectedPhoto?.file_id);
	if (selectedPhoto && photoFileId) {
		out.push({
			telegram_type: "photo",
			file_id: photoFileId,
			file_unique_id: stringId(selectedPhoto.file_unique_id),
			filename: null,
			mime_type: "image/jpeg",
			size_bytes: typeof selectedPhoto.file_size === "number" ? Math.trunc(selectedPhoto.file_size) : null,
			width: typeof selectedPhoto.width === "number" ? Math.trunc(selectedPhoto.width) : null,
			height: typeof selectedPhoto.height === "number" ? Math.trunc(selectedPhoto.height) : null,
		});
	}
	return out;
}

function syntheticTelegramAttachmentPrompt(attachments: readonly TelegramMessageAttachmentCandidate[]): string {
	const summary = attachments
		.map((entry, idx) => {
			const parts = [`#${idx + 1}`, `type=${entry.telegram_type}`];
			if (entry.filename) parts.push(`filename=${entry.filename}`);
			if (entry.mime_type) parts.push(`mime=${entry.mime_type}`);
			if (entry.size_bytes != null) parts.push(`size_bytes=${entry.size_bytes}`);
			if (entry.width != null && entry.height != null) parts.push(`dimensions=${entry.width}x${entry.height}`);
			return parts.join(" ");
		})
		.join("; ");
	return `Telegram attachment message (no text/caption): ${summary}`;
}

function humanizeTelegramAttachmentFailureReason(reason: string): string {
	if (reason === "telegram_bot_token_missing") {
		return "Attachment download is not configured for Telegram yet.";
	}
	if (reason.startsWith("telegram_get_file_")) {
		return "Telegram did not provide attachment metadata (getFile failed).";
	}
	if (reason === "telegram_get_file_missing_path") {
		return "Telegram returned incomplete attachment metadata (missing file path).";
	}
	if (reason.startsWith("telegram_file_download_")) {
		return "Telegram attachment download failed.";
	}
	if (reason.startsWith("inbound_attachment_")) {
		return `Attachment blocked by inbound policy (${reason}).`;
	}
	return `Attachment could not be processed (${reason}).`;
}

function buildTelegramAttachmentFailurePrompt(opts: {
	attachments: readonly TelegramMessageAttachmentCandidate[];
	audit: readonly Record<string, unknown>[];
}): string | null {
	const reasons: string[] = [];
	for (const row of opts.audit) {
		if (!row || typeof row !== "object") {
			continue;
		}
		const kind = typeof row.kind === "string" ? row.kind : null;
		if (kind !== "download_failed" && kind !== "pre_deny" && kind !== "post_deny") {
			continue;
		}
		const reason = typeof row.reason === "string" ? row.reason : null;
		if (!reason) {
			continue;
		}
		reasons.push(humanizeTelegramAttachmentFailureReason(reason));
	}
	if (reasons.length === 0) {
		return null;
	}
	const attachmentSummary = syntheticTelegramAttachmentPrompt(opts.attachments);
	const guidance = Array.from(new Set(reasons)).join(" ");
	return `${attachmentSummary}\nAttachment ingest issue: ${guidance} Please resend as text, or retry with a supported file type/size.`;
}

export const TelegramControlPlaneAdapterSpec = ControlPlaneAdapterSpecSchema.parse({
	channel: "telegram",
	route: defaultWebhookRouteForChannel("telegram"),
	ingress_payload: "json",
	verification: {
		kind: "shared_secret_header",
		secret_header: "x-telegram-bot-api-secret-token",
	},
	ack_format: "telegram_ok_json",
	delivery_semantics: "at_least_once",
	deferred_delivery: true,
});

export type TelegramControlPlaneAdapterOpts = {
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	webhookSecret: string;
	tenantId?: string;
	botUsername?: string | null;
	nowMs?: () => number;
	deferredIngress?: boolean;
	ingressMaxAttempts?: number;
	onOutboxEnqueued?: () => void;
	signalObserver?: ControlPlaneSignalObserver;
	/**
	 * Generation swap support: stage a new adapter in standby (acceptIngress=false)
	 * and atomically activate it at cutover.
	 */
	acceptIngress?: boolean;
	/**
	 * Generation swap support: only the active generation drains the shared
	 * telegram ingress queue.
	 */
	ingressDrainEnabled?: boolean;
	botToken?: string | null;
	inboundAttachmentPolicy?: InboundAttachmentPolicy;
	fetchImpl?: typeof fetch;
};

export class TelegramControlPlaneAdapter implements ControlPlaneAdapter {
	public readonly spec = TelegramControlPlaneAdapterSpec;
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #outbox: ControlPlaneOutbox;
	readonly #webhookSecret: string;
	readonly #tenantId: string;
	readonly #botUsername: string | null;
	readonly #nowMs: () => number;
	readonly #deferredIngress: boolean;
	readonly #ingressMaxAttempts: number;
	readonly #onOutboxEnqueued: (() => void) | null;
	readonly #signalObserver: ControlPlaneSignalObserver | null;
	readonly #ingressQueue: TelegramIngressQueue | null;
	readonly #adapterAudit: AdapterAuditLog | null;
	readonly #botToken: string | null;
	readonly #inboundAttachmentPolicy: InboundAttachmentPolicy;
	readonly #inboundAttachmentStore: InboundAttachmentStore;
	readonly #fetchImpl: typeof fetch;
	#ingressDraining = false;
	#ingressDrainRequested = false;
	#ingressRetryTimer: ReturnType<typeof setTimeout> | null = null;
	#ingressRetryTimerAtMs: number | null = null;
	#ingressInFlight = 0;
	#acceptIngress: boolean;
	#ingressDrainEnabled: boolean;
	#stopped = false;

	public constructor(opts: TelegramControlPlaneAdapterOpts) {
		this.#pipeline = opts.pipeline;
		this.#outbox = opts.outbox;
		this.#webhookSecret = opts.webhookSecret;
		this.#tenantId = opts.tenantId ?? "telegram-bot";
		this.#botUsername = opts.botUsername?.trim().replace(/^@/, "") || null;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#deferredIngress = opts.deferredIngress ?? false;
		this.#ingressMaxAttempts = Math.max(1, Math.trunc(opts.ingressMaxAttempts ?? 5));
		this.#onOutboxEnqueued = opts.onOutboxEnqueued ?? null;
		this.#signalObserver = opts.signalObserver ?? null;
		this.#botToken = opts.botToken?.trim() || null;
		this.#inboundAttachmentPolicy = opts.inboundAttachmentPolicy ?? DEFAULT_INBOUND_ATTACHMENT_POLICY;
		this.#fetchImpl = opts.fetchImpl ?? fetch;
		const attachmentPaths = buildInboundAttachmentStorePaths(this.#pipeline.runtime.paths.controlPlaneDir);
		this.#inboundAttachmentStore = new InboundAttachmentStore(attachmentPaths);
		this.#acceptIngress = opts.acceptIngress ?? true;
		this.#ingressDrainEnabled = opts.ingressDrainEnabled ?? this.#acceptIngress;
		if (this.#deferredIngress) {
			this.#ingressQueue = new TelegramIngressQueue(
				join(this.#pipeline.runtime.paths.controlPlaneDir, "telegram_ingress.jsonl"),
				{
					nowMs: this.#nowMs,
					signalObserver: this.#signalObserver ?? undefined,
				},
			);
			this.#adapterAudit = new AdapterAuditLog(this.#pipeline.runtime.paths.adapterAuditPath);
			if (this.#ingressDrainEnabled) {
				this.#requestIngressDrain();
			}
		} else {
			this.#ingressQueue = null;
			this.#adapterAudit = null;
		}
	}

	#verifyRequest(req: Request): { ok: true } | { ok: false; status: number; reason: string } {
		const token = req.headers.get("x-telegram-bot-api-secret-token");
		if (!token) {
			return { ok: false, status: 401, reason: "missing_telegram_secret_token" };
		}
		if (!timingSafeEqualUtf8(this.#webhookSecret, token)) {
			return { ok: false, status: 401, reason: "invalid_telegram_secret_token" };
		}
		return { ok: true };
	}

	#clearIngressRetryTimer(): void {
		if (!this.#ingressRetryTimer) {
			return;
		}
		clearTimeout(this.#ingressRetryTimer);
		this.#ingressRetryTimer = null;
		this.#ingressRetryTimerAtMs = null;
	}

	#scheduleIngressDrainAt(atMs: number): void {
		if (!this.#deferredIngress || this.#stopped || !this.#ingressDrainEnabled) {
			return;
		}
		const nowMs = Math.trunc(this.#nowMs());
		if (atMs <= nowMs) {
			this.#requestIngressDrain();
			return;
		}
		if (this.#ingressRetryTimer && this.#ingressRetryTimerAtMs != null && this.#ingressRetryTimerAtMs <= atMs) {
			return;
		}
		this.#clearIngressRetryTimer();
		this.#ingressRetryTimerAtMs = atMs;
		this.#ingressRetryTimer = setTimeout(() => {
			this.#ingressRetryTimer = null;
			this.#ingressRetryTimerAtMs = null;
			this.#requestIngressDrain();
		}, atMs - nowMs);
	}

	#requestIngressDrain(): void {
		if (!this.#deferredIngress || this.#stopped || !this.#ingressDrainEnabled) {
			return;
		}
		queueMicrotask(() => {
			void this.#drainIngressQueue();
		});
	}

	async #appendAudit(
		inbound: InboundEnvelope,
		event: string,
		reason: string | null,
		metadata: Record<string, unknown>,
	): Promise<void> {
		if (!this.#adapterAudit) {
			return;
		}
		try {
			await this.#adapterAudit.append({
				ts_ms: Math.trunc(this.#nowMs()),
				channel: inbound.channel,
				request_id: inbound.request_id,
				delivery_id: inbound.delivery_id,
				channel_tenant_id: inbound.channel_tenant_id,
				channel_conversation_id: inbound.channel_conversation_id,
				actor_id: inbound.actor_id,
				command_text: inbound.command_text,
				event,
				reason,
				metadata,
			});
		} catch {
			// Adapter audit should never break command handling.
		}
	}

	async #processDeferredIngressRecord(record: TelegramIngressRecord): Promise<void> {
		const ingressQueue = this.#ingressQueue;
		if (!ingressQueue) {
			return;
		}
		const startedAtMs = Math.trunc(this.#nowMs());
		this.#ingressInFlight += 1;
		await this.#appendAudit(record.inbound, "telegram.ingress.process.start", null, {
			ingress_id: record.ingress_id,
			attempt: record.attempt_count + 1,
			next_attempt_at_ms: record.next_attempt_at_ms,
		});

		try {
			const nowMs = Math.trunc(this.#nowMs());
			const dispatched = await runPipelineForInbound({
				pipeline: this.#pipeline,
				outbox: this.#outbox,
				inbound: record.inbound,
				nowMs,
				metadata: {
					adapter: this.spec.channel,
					source: "telegram:deferred_ingress",
					delivery_id: record.inbound.delivery_id,
					ingress_id: record.ingress_id,
					at_least_once_safe: true,
				},
				forceOutbox: true,
			});
			await ingressQueue.markCompleted(record.ingress_id, Math.trunc(this.#nowMs()));
			if (dispatched.outboxRecord) {
				this.#onOutboxEnqueued?.();
			}
			await this.#appendAudit(record.inbound, "telegram.ingress.process.completed", null, {
				ingress_id: record.ingress_id,
				pipeline_result_kind: dispatched.pipelineResult.kind,
				outbox_enqueued: dispatched.outboxRecord != null,
				elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - startedAtMs),
			});
		} catch (err) {
			const errorMessage =
				err instanceof Error && err.message.length > 0 ? err.message : "telegram_ingress_processing_error";
			const updated = await ingressQueue.markFailure(record.ingress_id, {
				error: errorMessage,
				nowMs: Math.trunc(this.#nowMs()),
			});
			if (updated?.state === "pending") {
				this.#scheduleIngressDrainAt(updated.next_attempt_at_ms);
			}
			await this.#appendAudit(
				record.inbound,
				updated?.state === "dead_letter"
					? "telegram.ingress.process.dead_letter"
					: "telegram.ingress.process.retry",
				errorMessage,
				{
					ingress_id: record.ingress_id,
					attempt_count: updated?.attempt_count ?? record.attempt_count + 1,
					next_attempt_at_ms: updated?.next_attempt_at_ms ?? null,
					elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - startedAtMs),
				},
			);
		} finally {
			this.#ingressInFlight = Math.max(0, this.#ingressInFlight - 1);
		}
	}

	async #drainIngressQueue(): Promise<void> {
		const ingressQueue = this.#ingressQueue;
		if (!this.#deferredIngress || this.#stopped || !ingressQueue || !this.#ingressDrainEnabled) {
			return;
		}
		if (this.#ingressDraining) {
			this.#ingressDrainRequested = true;
			return;
		}

		this.#ingressDraining = true;
		try {
			do {
				this.#ingressDrainRequested = false;
				for (;;) {
					if (this.#stopped || !this.#ingressDrainEnabled) {
						return;
					}
					const due = await ingressQueue.pendingDue(Math.trunc(this.#nowMs()), 20);
					if (due.length === 0) {
						break;
					}
					for (const record of due) {
						if (this.#stopped || !this.#ingressDrainEnabled) {
							return;
						}
						await this.#processDeferredIngressRecord(record);
					}
					if (due.length < 20) {
						break;
					}
				}
				if (!this.#ingressDrainEnabled) {
					return;
				}
				const nextPendingAttemptAtMs = await ingressQueue.nextPendingAttemptAtMs();
				if (nextPendingAttemptAtMs != null) {
					this.#scheduleIngressDrainAt(nextPendingAttemptAtMs);
				}
			} while (this.#ingressDrainRequested && !this.#stopped && this.#ingressDrainEnabled);
		} finally {
			this.#ingressDraining = false;
		}
	}

	public async warmup(): Promise<void> {
		if (this.#stopped) {
			throw new Error("telegram_adapter_stopped");
		}
		await this.#inboundAttachmentStore.load();
		if (!this.#deferredIngress || !this.#ingressQueue) {
			return;
		}
		await this.#ingressQueue.load();
		await this.#ingressQueue.nextPendingAttemptAtMs();
	}

	public async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
		if (this.#stopped) {
			return { ok: false, reason: "telegram_adapter_stopped" };
		}
		if (this.#deferredIngress && !this.#ingressQueue) {
			return { ok: false, reason: "telegram_ingress_queue_unavailable" };
		}
		return { ok: true };
	}

	public activateIngress(): void {
		if (this.#stopped) {
			throw new Error("telegram_adapter_stopped");
		}
		this.#acceptIngress = true;
		this.#ingressDrainEnabled = true;
		this.#requestIngressDrain();
	}

	public beginDrain(): void {
		this.#acceptIngress = false;
		this.#ingressDrainEnabled = false;
		this.#ingressDrainRequested = false;
		this.#clearIngressRetryTimer();
	}

	public async drain(opts: { timeoutMs: number; reason?: string } = { timeoutMs: 0 }): Promise<{
		ok: boolean;
		drained: boolean;
		in_flight_at_start: number;
		in_flight_at_end: number;
		elapsed_ms: number;
		timed_out: boolean;
	}> {
		const startedAtMs = Math.trunc(this.#nowMs());
		const timeoutMs = Math.max(0, Math.trunc(opts.timeoutMs));
		const inFlightAtStart = this.#ingressInFlight + (this.#ingressDraining ? 1 : 0);
		this.beginDrain();
		const deadlineMs = startedAtMs + timeoutMs;
		for (;;) {
			if (!this.#ingressDraining && this.#ingressInFlight === 0) {
				break;
			}
			if (Math.trunc(this.#nowMs()) >= deadlineMs) {
				break;
			}
			await Bun.sleep(10);
		}
		const inFlightAtEnd = this.#ingressInFlight + (this.#ingressDraining ? 1 : 0);
		const timedOut = inFlightAtEnd > 0;
		const elapsedMs = Math.max(0, Math.trunc(this.#nowMs()) - startedAtMs);
		return {
			ok: !timedOut,
			drained: !timedOut,
			in_flight_at_start: inFlightAtStart,
			in_flight_at_end: inFlightAtEnd,
			elapsed_ms: elapsedMs,
			timed_out: timedOut,
		};
	}

	public async stop(opts: { force?: boolean; reason?: string } = {}): Promise<void> {
		if (!opts.force) {
			this.beginDrain();
		}
		this.#stopped = true;
		this.#ingressDrainRequested = false;
		this.#clearIngressRetryTimer();
	}

	async #buildInboundAttachments(opts: {
		requestId: string;
		attachments: readonly TelegramMessageAttachmentCandidate[];
		nowMs: number;
	}): Promise<{ descriptors: NonNullable<InboundEnvelope["attachments"]>; audit: Array<Record<string, unknown>> }> {
		const descriptors: NonNullable<InboundEnvelope["attachments"]> = [];
		const audit: Array<Record<string, unknown>> = [];
		for (const candidate of opts.attachments) {
			const pre = evaluateInboundAttachmentPreDownload(
				{
					channel: "telegram",
					adapter: this.spec.channel,
					attachment_id: `${opts.requestId}:${candidate.file_id}`,
					channel_file_id: candidate.file_id,
					declared_mime_type: candidate.mime_type,
					declared_size_bytes: candidate.size_bytes,
				},
				this.#inboundAttachmentPolicy,
			);
			if (pre.kind === "deny") {
				audit.push({ kind: "pre_deny", file_id: candidate.file_id, reason: pre.reason });
				continue;
			}
			if (!this.#botToken) {
				audit.push({ kind: "download_failed", file_id: candidate.file_id, reason: "telegram_bot_token_missing" });
				continue;
			}
			const fileInfoRes = await this.#fetchImpl(
				`https://api.telegram.org/bot${this.#botToken}/getFile?file_id=${encodeURIComponent(candidate.file_id)}`,
			);
			if (!fileInfoRes.ok) {
				audit.push({ kind: "download_failed", file_id: candidate.file_id, reason: `telegram_get_file_${fileInfoRes.status}` });
				continue;
			}
			const fileInfo = (await fileInfoRes.json().catch(() => null)) as { result?: { file_path?: string } } | null;
			const filePath = typeof fileInfo?.result?.file_path === "string" ? fileInfo.result.file_path : null;
			if (!filePath) {
				audit.push({ kind: "download_failed", file_id: candidate.file_id, reason: "telegram_get_file_missing_path" });
				continue;
			}
			const blobRes = await this.#fetchImpl(`https://api.telegram.org/file/bot${this.#botToken}/${filePath}`);
			if (!blobRes.ok) {
				audit.push({ kind: "download_failed", file_id: candidate.file_id, reason: `telegram_file_download_${blobRes.status}` });
				continue;
			}
			const bytes = new Uint8Array(await blobRes.arrayBuffer());
			const ttlMs = Math.max(1, inboundAttachmentExpiryMs(opts.nowMs, this.#inboundAttachmentPolicy) - opts.nowMs);
			const stored = await this.#inboundAttachmentStore.put({
				channel: "telegram",
				source: this.spec.channel,
				sourceFileId: candidate.file_id,
				filename: candidate.filename,
				mimeType: candidate.mime_type ?? blobRes.headers.get("content-type"),
				bytes,
				ttlMs,
				nowMs: opts.nowMs,
				metadata: { telegram_type: candidate.telegram_type, telegram_file_path: filePath },
			});
			const post = evaluateInboundAttachmentPostDownload(
				{
					channel: "telegram",
					attachment_id: stored.record.attachment_id,
					channel_file_id: candidate.file_id,
					stored_mime_type: stored.record.mime_type,
					stored_size_bytes: stored.record.size_bytes,
					content_hash: stored.record.content_hash_sha256,
					malware_flagged: false,
				},
				this.#inboundAttachmentPolicy,
			);
			if (post.kind === "deny") {
				audit.push({ kind: "post_deny", file_id: candidate.file_id, reason: post.reason });
				continue;
			}
			descriptors.push({
				type: candidate.telegram_type,
				filename: stored.record.safe_filename,
				mime_type: stored.record.mime_type,
				size_bytes: stored.record.size_bytes,
				reference: toInboundAttachmentReference(stored.record),
				metadata: {
					origin: "telegram_inbound",
					telegram_file_id: candidate.file_id,
					telegram_file_unique_id: candidate.file_unique_id,
					dedupe_kind: stored.dedupe_kind,
				},
			});
			audit.push({ kind: "stored", file_id: candidate.file_id, attachment_id: stored.record.attachment_id });
		}
		return { descriptors, audit };
	}

	public async ingest(req: Request): Promise<AdapterIngressResult> {
		if (req.method !== "POST") {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "method_not_allowed",
				response: textResponse("method not allowed", { status: 405 }),
			});
		}

		if (this.#stopped || !this.#acceptIngress) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "telegram_generation_draining",
				response: textResponse("telegram_generation_draining", { status: 503 }),
			});
		}

		const verified = this.#verifyRequest(req);
		if (!verified.ok) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: verified.reason,
				response: textResponse(verified.reason, { status: verified.status }),
			});
		}

		let payload: Record<string, unknown>;
		try {
			payload = (await req.json()) as Record<string, unknown>;
		} catch {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_json",
				response: textResponse("invalid_json", { status: 400 }),
			});
		}

		const updateId = stringId(payload.update_id);
		if (!updateId) {
			return rejectedIngressResult({
				channel: this.spec.channel,
				reason: "invalid_update_id",
				response: textResponse("invalid_update_id", { status: 400 }),
			});
		}

		const callbackQuery = payload.callback_query as Record<string, unknown> | undefined;
		const message = payload.message as Record<string, unknown> | undefined;

		let actorId = "unknown-user";
		let conversationId = "unknown-chat";
		let commandText = "";
		let sourceKind: "update" | "callback" = "update";
		let sourceId = updateId;
		const metadata: Record<string, unknown> = {
			adapter: this.spec.channel,
			update_id: updateId,
			delivery_semantics: "at_least_once",
			duplicate_safe: true,
			idempotency_scope: "telegram:update_or_callback_id",
		};

		if (callbackQuery) {
			sourceKind = "callback";
			sourceId = stringId(callbackQuery.id) ?? updateId;
			const callbackData = typeof callbackQuery.data === "string" ? callbackQuery.data : "";
			const normalized = normalizeTelegramCallbackData(callbackData);
			if (!normalized) {
				return rejectedIngressResult({
					channel: this.spec.channel,
					reason: "unsupported_telegram_callback",
					response: telegramWebhookMethodResponse({
						method: "answerCallbackQuery",
						callback_query_id: sourceId,
						text: "Interactive actions are no longer supported.",
						show_alert: false,
					}),
				});
			}
			commandText = normalized;
			actorId = stringId((callbackQuery.from as Record<string, unknown> | undefined)?.id) ?? actorId;
			conversationId =
				stringId(
					(
						(callbackQuery.message as Record<string, unknown> | undefined)?.chat as
							| Record<string, unknown>
							| undefined
					)?.id,
				) ?? conversationId;
			metadata.callback_query_id = sourceId;
			metadata.callback_data = callbackData;
			metadata.message_id = stringId((callbackQuery.message as Record<string, unknown> | undefined)?.message_id);
		} else if (message) {
			actorId = stringId((message.from as Record<string, unknown> | undefined)?.id) ?? actorId;
			conversationId = stringId((message.chat as Record<string, unknown> | undefined)?.id) ?? conversationId;
			const rawText = typeof message.text === "string" ? message.text : "";
			const rawCaption = typeof message.caption === "string" ? message.caption : "";
			const attachmentCandidates = extractTelegramMessageAttachments(message);
			const rawCommand = rawText.trim().length > 0 ? rawText : rawCaption;
			commandText = normalizeTelegramMessageCommand(rawCommand, this.#botUsername);
			metadata.message_id = stringId(message.message_id);
			const chatType = (message.chat as Record<string, unknown> | undefined)?.type ?? null;
			metadata.chat_type = chatType;
			metadata.telegram_attachment_count = attachmentCandidates.length;
			if (rawCommand.trim().length === 0 && attachmentCandidates.length === 0) {
				return acceptedIngressResult({
					channel: this.spec.channel,
					reason: "unsupported_update",
					response: jsonResponse({ ok: true, result: "ignored_unsupported_update" }, { status: 200 }),
					inbound: null,
					pipelineResult: { kind: "noop", reason: "not_command" },
					outboxRecord: null,
				});
			}
			if (attachmentCandidates.length > 0) {
				const source = `telegram:update:${updateId}`;
				const stableId = sha256Hex(source).slice(0, 32);
				const requestId = `telegram-req-${stableId}`;
				const attachmentResult = await this.#buildInboundAttachments({
					requestId,
					attachments: attachmentCandidates,
					nowMs: Math.trunc(this.#nowMs()),
				});
				metadata.inbound_attachment_audit = attachmentResult.audit;
				if (attachmentResult.descriptors.length > 0) {
					metadata.inbound_attachments = attachmentResult.descriptors;
				}
				if (commandText.trim().length === 0) {
					commandText =
						buildTelegramAttachmentFailurePrompt({
							attachments: attachmentCandidates,
							audit: attachmentResult.audit,
						}) ?? syntheticTelegramAttachmentPrompt(attachmentCandidates);
				}
			}
		} else {
			return acceptedIngressResult({
				channel: this.spec.channel,
				reason: "unsupported_update",
				response: jsonResponse({ ok: true, result: "ignored_unsupported_update" }, { status: 200 }),
				inbound: null,
				pipelineResult: { kind: "noop", reason: "not_command" },
				outboxRecord: null,
			});
		}

		const source = `telegram:${sourceKind}:${sourceId}`;
		const stableId = sha256Hex(source).slice(0, 32);
		const requestId = `telegram-req-${stableId}`;
		const deliveryId = `telegram-delivery-${stableId}`;
		const bindingHint = resolveBindingHint(this.#pipeline, this.spec.channel, this.#tenantId, actorId);
		const nowMs = Math.trunc(this.#nowMs());
		const normalizedCommandText = commandText.trim();
		const inboundAttachments = Array.isArray(metadata.inbound_attachments)
			? (metadata.inbound_attachments as NonNullable<InboundEnvelope["attachments"]>)
			: undefined;
		delete metadata.inbound_attachments;

		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: nowMs,
			request_id: requestId,
			delivery_id: deliveryId,
			channel: this.spec.channel,
			channel_tenant_id: this.#tenantId,
			channel_conversation_id: conversationId,
			actor_id: actorId,
			actor_binding_id: bindingHint.actorBindingId,
			assurance_tier: bindingHint.assuranceTier,
			repo_root: this.#pipeline.runtime.paths.repoRoot,
			command_text: normalizedCommandText,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: conversationId,
			idempotency_key: `telegram-idem-${sourceKind}-${sourceId}`,
			fingerprint: `telegram-fp-${sha256Hex(normalizedCommandText.toLowerCase())}`,
			...(inboundAttachments && inboundAttachments.length > 0 ? { attachments: inboundAttachments } : {}),
			metadata,
		});

		if (this.#deferredIngress) {
			const ingressQueue = this.#ingressQueue;
			if (!ingressQueue) {
				throw new Error("telegram_ingress_queue_unavailable");
			}
			const enqueue = await ingressQueue.enqueue({
				dedupeKey: `telegram:ingress:${sourceKind}:${sourceId}`,
				inbound,
				nowMs,
				maxAttempts: this.#ingressMaxAttempts,
			});
			if (enqueue.record.state === "pending") {
				this.#scheduleIngressDrainAt(enqueue.record.next_attempt_at_ms);
			}
			await this.#appendAudit(inbound, "telegram.ingress.ack", null, {
				ingress_id: enqueue.record.ingress_id,
				source,
				source_kind: sourceKind,
				source_id: sourceId,
				queue_decision: enqueue.kind,
				ack_mode: sourceKind === "callback" ? "answerCallbackQuery" : "sendChatAction",
				deferred_ingress: true,
				at_least_once_safe: true,
			});
			const response =
				sourceKind === "callback"
					? telegramWebhookMethodResponse({
							method: "answerCallbackQuery",
							callback_query_id: sourceId,
							text: "Processing…",
							show_alert: false,
						})
					: telegramWebhookMethodResponse({
							method: "sendChatAction",
							chat_id: conversationId,
							action: "typing",
						});
			return acceptedIngressResult({
				channel: this.spec.channel,
				response,
				inbound,
				pipelineResult: null,
				outboxRecord: null,
			});
		}

		const dispatched = await runPipelineForInbound({
			pipeline: this.#pipeline,
			outbox: this.#outbox,
			inbound,
			nowMs,
			metadata: {
				adapter: this.spec.channel,
				source,
				delivery_id: deliveryId,
				at_least_once_safe: true,
			},
		});

		const hasDeferredUpdate = dispatched.outboxRecord != null;
		const callbackAckText = summarizeTelegramCallbackAck(dispatched.ackText);
		const replyToMessageId = maybeParseIntegerId(metadata.message_id);

		const response =
			sourceKind === "callback"
				? telegramWebhookMethodResponse({
						method: "answerCallbackQuery",
						callback_query_id: sourceId,
						text: hasDeferredUpdate ? "Processing…" : callbackAckText,
						show_alert: false,
					})
				: hasDeferredUpdate
					? telegramWebhookMethodResponse({
							method: "sendChatAction",
							chat_id: conversationId,
							action: "typing",
						})
					: telegramWebhookMethodResponse({
							method: "sendMessage",
							chat_id: conversationId,
							text: truncateTelegramWebhookText(dispatched.ackText),
							disable_notification: true,
							...(replyToMessageId != null
								? {
										reply_to_message_id: replyToMessageId,
										allow_sending_without_reply: true,
									}
								: {}),
						});

		return acceptedIngressResult({
			channel: this.spec.channel,
			response,
			inbound,
			pipelineResult: dispatched.pipelineResult,
			outboxRecord: dispatched.outboxRecord,
		});
	}
}
