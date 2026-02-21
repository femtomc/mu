import type { MessagingOperatorBackend, MessagingOperatorRuntime } from "@femtomc/mu-agent";
import {
	type AdapterIngressResult,
	type AttachmentDescriptor,
	type CommandPipelineResult,
	type ControlPlaneAdapter,
	type Channel,
	ControlPlaneCommandPipeline,
	ControlPlaneOutbox,
	ControlPlaneRuntime,
	type ControlPlaneSignalObserver,
	type GenerationTelemetryRecorder,
	getControlPlanePaths,
	type MutationCommandExecutionResult,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
	TelegramControlPlaneAdapterSpec,
} from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG } from "./config.js";
import {
	type ActiveAdapter,
	type ControlPlaneConfig,
	type ControlPlaneGenerationContext,
	type ControlPlaneHandle,
	type ControlPlaneSessionLifecycle,
	type NotifyOperatorsOpts,
	type NotifyOperatorsResult,
	type TelegramGenerationReloadResult,
	type TelegramGenerationSwapHooks,
	type WakeDeliveryObserver,
} from "./control_plane_contract.js";
import { buildMessagingOperatorRuntime, createOutboxDrainLoop } from "./control_plane_bootstrap_helpers.js";
import {
	buildWakeOutboundEnvelope,
	resolveWakeFanoutCapability,
	wakeDeliveryMetadataFromOutboxRecord,
	wakeDispatchReasonCode,
	wakeFanoutDedupeKey,
} from "./control_plane_wake_delivery.js";
import {
	createStaticAdaptersFromDetected,
	detectAdapters,
} from "./control_plane_adapter_registry.js";
import { OutboundDeliveryRouter } from "./outbound_delivery_router.js";
import { TelegramAdapterGenerationManager } from "./control_plane_telegram_generation.js";

export type {
	ActiveAdapter,
	ControlPlaneConfig,
	ControlPlaneGenerationContext,
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
	ControlPlaneSessionMutationAction,
	ControlPlaneSessionMutationResult,
	NotifyOperatorsOpts,
	NotifyOperatorsResult,
	TelegramGenerationReloadResult,
	TelegramGenerationRollbackTrigger,
	TelegramGenerationSwapHooks,
	WakeDeliveryEvent,
	WakeDeliveryObserver,
	WakeNotifyContext,
	WakeNotifyDecision,
} from "./control_plane_contract.js";

function generationTags(
	generation: ControlPlaneGenerationContext,
	component: string,
): {
	generation_id: string;
	generation_seq: number;
	supervisor: string;
	component: string;
} {
	return {
		generation_id: generation.generation_id,
		generation_seq: generation.generation_seq,
		supervisor: "control_plane",
		component,
	};
}

const WAKE_OUTBOX_MAX_ATTEMPTS = 6;

function emptyNotifyOperatorsResult(): NotifyOperatorsResult {
	return {
		queued: 0,
		duplicate: 0,
		skipped: 0,
		decisions: [],
	};
}

export { detectAdapters };

export type TelegramSendMessagePayload = {
	chat_id: string;
	text: string;
	parse_mode?: "Markdown";
	disable_web_page_preview?: boolean;
};

type SlackApiOkResponse = {
	ok: boolean;
	error?: string;
};

type SlackChatPostMessageResponse = SlackApiOkResponse;
type SlackFileUploadResponse = SlackApiOkResponse;

export type TelegramSendPhotoPayload = {
	chat_id: string;
	photo: string;
	caption?: string;
};

export type TelegramSendDocumentPayload = {
	chat_id: string;
	document: string;
	caption?: string;
};

type TelegramMediaMethod = "sendPhoto" | "sendDocument";

const TELEGRAM_CAPTION_MAX_LEN = 1_024;

/**
 * Telegram supports a markdown dialect that uses single markers for emphasis.
 * Normalize the most common LLM/GitHub-style markers (`**bold**`, `__italic__`, headings)
 * while preserving fenced code blocks verbatim.
 */
export function renderTelegramMarkdown(text: string): string {
	const normalized = text.replaceAll("\r\n", "\n");
	const lines = normalized.split("\n");
	const out: string[] = [];
	let inFence = false;

	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		let next = line;
		next = next.replace(/^#{1,6}\s+(.+)$/, "*$1*");
		next = next.replace(/\*\*(.+?)\*\*/g, "*$1*");
		next = next.replace(/__(.+?)__/g, "_$1_");
		out.push(next);
	}

	return out.join("\n");
}

const TELEGRAM_MATH_PATTERNS: readonly RegExp[] = [
	/\$\$[\s\S]+?\$\$/m,
	/(^|[^\\])\$[^$\n]+\$/m,
	/\\\([\s\S]+?\\\)/m,
	/\\\[[\s\S]+?\\\]/m,
];

export function containsTelegramMathNotation(text: string): boolean {
	if (text.trim().length === 0) {
		return false;
	}
	return TELEGRAM_MATH_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildTelegramSendMessagePayload(opts: {
	chatId: string;
	text: string;
	richFormatting: boolean;
}): TelegramSendMessagePayload {
	if (!opts.richFormatting || containsTelegramMathNotation(opts.text)) {
		return {
			chat_id: opts.chatId,
			text: opts.text,
		};
	}

	return {
		chat_id: opts.chatId,
		text: renderTelegramMarkdown(opts.text),
		parse_mode: "Markdown",
		disable_web_page_preview: true,
	};
}

async function postTelegramMessage(botToken: string, payload: TelegramSendMessagePayload): Promise<Response> {
	return await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

async function postTelegramApiJson(
	botToken: string,
	method: "sendPhoto" | "sendDocument",
	payload: TelegramSendPhotoPayload | TelegramSendDocumentPayload,
): Promise<Response> {
	return await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

async function postTelegramApiMultipart(botToken: string, method: TelegramMediaMethod, form: FormData): Promise<Response> {
	return await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
		method: "POST",
		body: form,
	});
}

function truncateTelegramCaption(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= TELEGRAM_CAPTION_MAX_LEN) {
		return normalized;
	}
	if (TELEGRAM_CAPTION_MAX_LEN <= 16) {
		return normalized.slice(0, TELEGRAM_CAPTION_MAX_LEN);
	}
	const suffix = "…(truncated)";
	const headLen = Math.max(0, TELEGRAM_CAPTION_MAX_LEN - suffix.length);
	return `${normalized.slice(0, headLen)}${suffix}`;
}

function chooseTelegramMediaMethod(attachment: AttachmentDescriptor): TelegramMediaMethod {
	const mime = attachment.mime_type?.toLowerCase() ?? "";
	const filename = attachment.filename?.toLowerCase() ?? "";
	const declaredType = attachment.type.toLowerCase();
	const isSvg = mime === "image/svg+xml" || filename.endsWith(".svg");
	const isImageMime = mime.startsWith("image/");
	if ((declaredType === "image" || isImageMime) && !isSvg) {
		return "sendPhoto";
	}
	return "sendDocument";
}

function parseRetryDelayMs(res: Response): number | undefined {
	const retryAfter = res.headers.get("retry-after");
	if (!retryAfter) {
		return undefined;
	}
	const parsed = Number.parseInt(retryAfter, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return undefined;
	}
	return parsed * 1000;
}

export async function deliverTelegramOutboxRecord(opts: {
	botToken: string;
	record: OutboxRecord;
}): Promise<OutboxDeliveryHandlerResult> {
	const { botToken, record } = opts;
	const fallbackMessagePayload = buildTelegramSendMessagePayload({
		chatId: record.envelope.channel_conversation_id,
		text: record.envelope.body,
		richFormatting: true,
	});

	const firstAttachment = record.envelope.attachments?.[0] ?? null;
	if (!firstAttachment) {
		let res = await postTelegramMessage(botToken, fallbackMessagePayload);
		if (!res.ok && res.status === 400 && fallbackMessagePayload.parse_mode) {
			res = await postTelegramMessage(
				botToken,
				buildTelegramSendMessagePayload({
					chatId: record.envelope.channel_conversation_id,
					text: record.envelope.body,
					richFormatting: false,
				}),
			);
		}
		if (res.ok) {
			return { kind: "delivered" };
		}
		const responseBody = await res.text().catch(() => "");
		if (res.status === 429 || res.status >= 500) {
			return {
				kind: "retry",
				error: `telegram sendMessage ${res.status}: ${responseBody}`,
				retryDelayMs: parseRetryDelayMs(res),
			};
		}
		return {
			kind: "retry",
			error: `telegram sendMessage ${res.status}: ${responseBody}`,
		};
	}

	const mediaMethod = chooseTelegramMediaMethod(firstAttachment);
	const mediaField = mediaMethod === "sendPhoto" ? "photo" : "document";
	const mediaReference = firstAttachment.reference.file_id ?? firstAttachment.reference.url ?? null;
	if (!mediaReference) {
		return { kind: "retry", error: "telegram media attachment missing reference" };
	}

	const mediaCaption = truncateTelegramCaption(record.envelope.body);
	let mediaResponse: Response;
	if (firstAttachment.reference.file_id) {
		mediaResponse = await postTelegramApiJson(
			botToken,
			mediaMethod,
			mediaMethod === "sendPhoto"
				? {
					chat_id: record.envelope.channel_conversation_id,
					photo: firstAttachment.reference.file_id,
					caption: mediaCaption,
				}
				: {
					chat_id: record.envelope.channel_conversation_id,
					document: firstAttachment.reference.file_id,
					caption: mediaCaption,
				},
		);
	} else {
		const sourceUrl = firstAttachment.reference.url as string;
		const sourceRes = await fetch(sourceUrl);
		if (!sourceRes.ok) {
			const sourceErr = await sourceRes.text().catch(() => "");
			return {
				kind: "retry",
				error: `telegram attachment fetch ${sourceRes.status}: ${sourceErr}`,
				retryDelayMs: sourceRes.status === 429 || sourceRes.status >= 500 ? parseRetryDelayMs(sourceRes) : undefined,
			};
		}
		const body = await sourceRes.arrayBuffer();
		const contentType = firstAttachment.mime_type ?? sourceRes.headers.get("content-type") ?? "application/octet-stream";
		const filename = firstAttachment.filename ?? `${firstAttachment.type || "attachment"}.bin`;
		const form = new FormData();
		form.append("chat_id", record.envelope.channel_conversation_id);
		if (mediaCaption.length > 0) {
			form.append("caption", mediaCaption);
		}
		form.append(mediaField, new Blob([body], { type: contentType }), filename);
		mediaResponse = await postTelegramApiMultipart(botToken, mediaMethod, form);
	}

	if (mediaResponse.ok) {
		return { kind: "delivered" };
	}

	const mediaBody = await mediaResponse.text().catch(() => "");
	if (mediaResponse.status === 429 || mediaResponse.status >= 500) {
		return {
			kind: "retry",
			error: `telegram ${mediaMethod} ${mediaResponse.status}: ${mediaBody}`,
			retryDelayMs: parseRetryDelayMs(mediaResponse),
		};
	}

	const fallbackPlainPayload = buildTelegramSendMessagePayload({
		chatId: record.envelope.channel_conversation_id,
		text: record.envelope.body,
		richFormatting: false,
	});
	const fallbackRes = await postTelegramMessage(botToken, fallbackPlainPayload);
	if (fallbackRes.ok) {
		return { kind: "delivered" };
	}
	const fallbackBody = await fallbackRes.text().catch(() => "");
	if (fallbackRes.status === 429 || fallbackRes.status >= 500) {
		return {
			kind: "retry",
			error: `telegram media fallback sendMessage ${fallbackRes.status}: ${fallbackBody}`,
			retryDelayMs: parseRetryDelayMs(fallbackRes),
		};
	}
	return {
		kind: "retry",
		error: `telegram media fallback sendMessage ${fallbackRes.status}: ${fallbackBody} (media_error=${mediaMethod} ${mediaResponse.status}: ${mediaBody})`,
	};
}

async function postSlackJson<T extends SlackApiOkResponse>(opts: {
	botToken: string;
	method: "chat.postMessage";
	payload: Record<string, unknown>;
}): Promise<{ response: Response; payload: T | null }> {
	const response = await fetch(`https://slack.com/api/${opts.method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${opts.botToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(opts.payload),
	});
	const payload = (await response.json().catch(() => null)) as T | null;
	return { response, payload };
}

export async function deliverSlackOutboxRecord(opts: {
	botToken: string;
	record: OutboxRecord;
}): Promise<OutboxDeliveryHandlerResult> {
	const { botToken, record } = opts;
	const attachments = record.envelope.attachments ?? [];
	if (attachments.length === 0) {
		const delivered = await postSlackJson<SlackChatPostMessageResponse>({
			botToken,
			method: "chat.postMessage",
			payload: {
				channel: record.envelope.channel_conversation_id,
				text: record.envelope.body,
				unfurl_links: false,
				unfurl_media: false,
			},
		});
		if (delivered.response.ok && delivered.payload?.ok) {
			return { kind: "delivered" };
		}
		const status = delivered.response.status;
		const err = delivered.payload?.error ?? "unknown_error";
		if (status === 429 || status >= 500) {
			return {
				kind: "retry",
				error: `slack chat.postMessage ${status}: ${err}`,
				retryDelayMs: parseRetryDelayMs(delivered.response),
			};
		}
		return { kind: "retry", error: `slack chat.postMessage ${status}: ${err}` };
	}

	let firstError: string | null = null;
	for (const [index, attachment] of attachments.entries()) {
		const referenceUrl = attachment.reference.url;
		if (!referenceUrl) {
			return {
				kind: "retry",
				error: `slack attachment ${index + 1} missing reference.url`,
			};
		}
		const source = await fetch(referenceUrl);
		if (!source.ok) {
			const sourceErr = await source.text().catch(() => "");
			if (source.status === 429 || source.status >= 500) {
				return {
					kind: "retry",
					error: `slack attachment fetch ${source.status}: ${sourceErr}`,
					retryDelayMs: parseRetryDelayMs(source),
				};
			}
			return { kind: "retry", error: `slack attachment fetch ${source.status}: ${sourceErr}` };
		}
		const bytes = await source.arrayBuffer();
		const contentType = attachment.mime_type ?? source.headers.get("content-type") ?? "application/octet-stream";
		const filename = attachment.filename ?? `attachment-${index + 1}`;
		const form = new FormData();
		form.set("channels", record.envelope.channel_conversation_id);
		form.set("filename", filename);
		form.set("title", filename);
		if (index === 0 && record.envelope.body.trim().length > 0) {
			form.set("initial_comment", record.envelope.body);
		}
		form.set("file", new Blob([bytes], { type: contentType }), filename);

		const uploaded = await fetch("https://slack.com/api/files.upload", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${botToken}`,
			},
			body: form,
		});
		const uploadPayload = (await uploaded.json().catch(() => null)) as SlackFileUploadResponse | null;
		if (!(uploaded.ok && uploadPayload?.ok)) {
			const status = uploaded.status;
			const err = uploadPayload?.error ?? "unknown_error";
			if (status === 429 || status >= 500) {
				return {
					kind: "retry",
					error: `slack files.upload ${status}: ${err}`,
					retryDelayMs: parseRetryDelayMs(uploaded),
				};
			}
			if (!firstError) {
				firstError = `slack files.upload ${status}: ${err}`;
			}
		}
	}

	if (firstError) {
		const fallback = await postSlackJson<SlackChatPostMessageResponse>({
			botToken,
			method: "chat.postMessage",
			payload: {
				channel: record.envelope.channel_conversation_id,
				text: record.envelope.body,
				unfurl_links: false,
				unfurl_media: false,
			},
		});
		if (fallback.response.ok && fallback.payload?.ok) {
			return { kind: "delivered" };
		}
		const status = fallback.response.status;
		const err = fallback.payload?.error ?? "unknown_error";
		if (status === 429 || status >= 500) {
			return {
				kind: "retry",
				error: `slack chat.postMessage fallback ${status}: ${err} (upload_error=${firstError})`,
				retryDelayMs: parseRetryDelayMs(fallback.response),
			};
		}
		return {
			kind: "retry",
			error: `slack chat.postMessage fallback ${status}: ${err} (upload_error=${firstError})`,
		};
	}

	return { kind: "delivered" };
}

export type BootstrapControlPlaneOpts = {
	repoRoot: string;
	config?: ControlPlaneConfig;
	operatorRuntime?: MessagingOperatorRuntime | null;
	operatorBackend?: MessagingOperatorBackend;
	sessionLifecycle: ControlPlaneSessionLifecycle;
	generation?: ControlPlaneGenerationContext;
	telemetry?: GenerationTelemetryRecorder | null;
	telegramGenerationHooks?: TelegramGenerationSwapHooks;
	wakeDeliveryObserver?: WakeDeliveryObserver | null;
	terminalEnabled?: boolean;
};

export async function bootstrapControlPlane(opts: BootstrapControlPlaneOpts): Promise<ControlPlaneHandle | null> {
	const controlPlaneConfig = opts.config ?? DEFAULT_MU_CONFIG.control_plane;
	const detected = detectAdapters(controlPlaneConfig);
	const generation: ControlPlaneGenerationContext = opts.generation ?? {
		generation_id: "control-plane-gen-0",
		generation_seq: 0,
	};
	const telemetry = opts.telemetry ?? null;
	const signalObserver: ControlPlaneSignalObserver | undefined = telemetry
		? {
				onDuplicateSignal: (signal) => {
					telemetry.recordDuplicateSignal(generationTags(generation, `control_plane.${signal.source}`), signal);
				},
				onDropSignal: (signal) => {
					telemetry.recordDropSignal(generationTags(generation, `control_plane.${signal.source}`), signal);
				},
			}
		: undefined;

	if (detected.length === 0 && !opts.terminalEnabled) {
		return null;
	}

	const paths = getControlPlanePaths(opts.repoRoot);

	const runtime = new ControlPlaneRuntime({ repoRoot: opts.repoRoot });
	let pipeline: ControlPlaneCommandPipeline | null = null;
	let outboxDrainLoop: ReturnType<typeof createOutboxDrainLoop> | null = null;
	let wakeDeliveryObserver: WakeDeliveryObserver | null = opts.wakeDeliveryObserver ?? null;
	const outboundDeliveryChannels = new Set<Channel>();
	const adapterMap = new Map<
		string,
		{
			adapter: ControlPlaneAdapter;
			info: ActiveAdapter;
			isActive: () => boolean;
		}
	>();

	try {
		await runtime.start();

		const operator =
			opts.operatorRuntime !== undefined
				? opts.operatorRuntime
				: buildMessagingOperatorRuntime({
						repoRoot: opts.repoRoot,
						config: controlPlaneConfig,
						backend: opts.operatorBackend,
					});

		const outbox = new ControlPlaneOutbox(paths.outboxPath, {
			signalObserver,
		});
		await outbox.load();

		let scheduleOutboxDrainRef: (() => void) | null = null;

		pipeline = new ControlPlaneCommandPipeline({
			runtime,
			operator,
			mutationExecutor: async (record): Promise<MutationCommandExecutionResult | null> => {
				if (record.target_type === "reload" || record.target_type === "update") {
					if (record.command_args.length > 0) {
						return {
							terminalState: "failed",
							errorCode: "cli_validation_failed",
							trace: {
								cliCommandKind: record.target_type,
							},
							mutatingEvents: [
								{
									eventType: "session.lifecycle.command.failed",
									payload: {
										action: record.target_type,
										reason: "unexpected_args",
										args: record.command_args,
									},
								},
							],
						};
					}

					const action = record.target_type;
					const executeLifecycleAction =
						action === "reload" ? opts.sessionLifecycle.reload : opts.sessionLifecycle.update;

					try {
						const lifecycle = await executeLifecycleAction();
						if (!lifecycle.ok) {
							return {
								terminalState: "failed",
								errorCode: "session_lifecycle_failed",
								trace: {
									cliCommandKind: action,
								},
								mutatingEvents: [
									{
										eventType: "session.lifecycle.command.failed",
										payload: {
											action,
											reason: lifecycle.message,
											details: lifecycle.details ?? null,
										},
									},
								],
							};
						}
						return {
							terminalState: "completed",
							result: {
								ok: true,
								action,
								message: lifecycle.message,
								details: lifecycle.details ?? null,
							},
							trace: {
								cliCommandKind: action,
							},
							mutatingEvents: [
								{
									eventType: `session.lifecycle.command.${action}`,
									payload: {
										action,
										message: lifecycle.message,
										details: lifecycle.details ?? null,
									},
								},
							],
						};
					} catch (err) {
						return {
							terminalState: "failed",
							errorCode: err instanceof Error && err.message ? err.message : "session_lifecycle_failed",
							trace: {
								cliCommandKind: action,
							},
							mutatingEvents: [
								{
									eventType: "session.lifecycle.command.failed",
									payload: {
										action,
										reason: err instanceof Error && err.message ? err.message : "session_lifecycle_failed",
									},
								},
							],
						};
					}
				}


				return null;
			},
		});
		await pipeline.start();

		const telegramManager = new TelegramAdapterGenerationManager({
			pipeline,
			outbox,
			initialConfig: controlPlaneConfig,
			onOutboxEnqueued: () => {
				scheduleOutboxDrainRef?.();
			},
			signalObserver,
			hooks: opts.telegramGenerationHooks,
		});
		await telegramManager.initialize();

		for (const adapter of createStaticAdaptersFromDetected({
			detected,
			config: controlPlaneConfig,
			pipeline,
			outbox,
		})) {
			const route = adapter.spec.route;
			if (adapterMap.has(route)) {
				throw new Error(`duplicate control-plane webhook route: ${route}`);
			}
			adapterMap.set(route, {
				adapter,
				info: {
					name: adapter.spec.channel,
					route,
				},
				isActive: () => true,
			});
		}

		const telegramProxy: ControlPlaneAdapter = {
			spec: TelegramControlPlaneAdapterSpec,
			async ingest(req: Request): Promise<AdapterIngressResult> {
				const active = telegramManager.activeAdapter();
				if (!active) {
					return {
						channel: "telegram",
						accepted: false,
						reason: "telegram_not_configured",
						response: new Response("telegram_not_configured", { status: 404 }),
						inbound: null,
						pipelineResult: null,
						outboxRecord: null,
						auditEntry: null,
					};
				}
				return await active.ingest(req);
			},
			async stop(): Promise<void> {
				await telegramManager.stop();
			},
		};

		if (adapterMap.has(TelegramControlPlaneAdapterSpec.route)) {
			throw new Error(`duplicate control-plane webhook route: ${TelegramControlPlaneAdapterSpec.route}`);
		}
		adapterMap.set(TelegramControlPlaneAdapterSpec.route, {
			adapter: telegramProxy,
			info: {
				name: "telegram",
				route: TelegramControlPlaneAdapterSpec.route,
			},
			isActive: () => telegramManager.hasActiveGeneration(),
		});

		const deliveryRouter = new OutboundDeliveryRouter([
			{
				channel: "slack",
				deliver: async (record: OutboxRecord): Promise<OutboxDeliveryHandlerResult> => {
					const slackBotToken = controlPlaneConfig.adapters.slack.bot_token;
					if (!slackBotToken) {
						return { kind: "retry", error: "slack bot token not configured in mu workspace config" };
					}
					return await deliverSlackOutboxRecord({
						botToken: slackBotToken,
						record,
					});
				},
			},
			{
				channel: "telegram",
				deliver: async (record: OutboxRecord): Promise<OutboxDeliveryHandlerResult> => {
					const telegramBotToken = telegramManager.activeBotToken();
					if (!telegramBotToken) {
						return { kind: "retry", error: "telegram bot token not configured in mu workspace config" };
					}
					return await deliverTelegramOutboxRecord({
						botToken: telegramBotToken,
						record,
					});
				},
			},
		]);
		outboundDeliveryChannels.add("slack");
		outboundDeliveryChannels.add("telegram");

		const notifyOperators = async (notifyOpts: NotifyOperatorsOpts): Promise<NotifyOperatorsResult> => {
			if (!pipeline) {
				return emptyNotifyOperatorsResult();
			}
			const message = notifyOpts.message.trim();
			const dedupeKey = notifyOpts.dedupeKey.trim();
			if (!message || !dedupeKey) {
				return emptyNotifyOperatorsResult();
			}

			const wakeSource = typeof notifyOpts.wake?.wakeSource === "string" ? notifyOpts.wake.wakeSource.trim() : "";
			const wakeProgramId = typeof notifyOpts.wake?.programId === "string" ? notifyOpts.wake.programId.trim() : "";
			const wakeSourceTsMsRaw = notifyOpts.wake?.sourceTsMs;
			const wakeSourceTsMs =
				typeof wakeSourceTsMsRaw === "number" && Number.isFinite(wakeSourceTsMsRaw)
					? Math.trunc(wakeSourceTsMsRaw)
					: null;
			const wakeId =
				typeof notifyOpts.wake?.wakeId === "string" && notifyOpts.wake.wakeId.trim().length > 0
					? notifyOpts.wake.wakeId.trim()
					: `wake-${(() => {
							const hasher = new Bun.CryptoHasher("sha256");
							hasher.update(`${dedupeKey}:${message}`);
							return hasher.digest("hex").slice(0, 16);
						})()}`;

			const context = {
				wakeId,
				dedupeKey,
				wakeSource: wakeSource || null,
				programId: wakeProgramId || null,
				sourceTsMs: wakeSourceTsMs,
			};

			const nowMs = Math.trunc(Date.now());
			const slackBotToken = controlPlaneConfig.adapters.slack.bot_token;
			const telegramBotToken = telegramManager.activeBotToken();
			const bindings = pipeline.identities
				.listBindings({ includeInactive: false })
				.filter((binding) => binding.scopes.includes("cp.ops.admin"));

			const result = emptyNotifyOperatorsResult();
			for (const binding of bindings) {
				const bindingDedupeKey = wakeFanoutDedupeKey({
					dedupeKey,
					wakeId,
					binding,
				});
				const capability = resolveWakeFanoutCapability({
					binding,
					isChannelDeliverySupported: (channel) => outboundDeliveryChannels.has(channel),
					slackBotToken,
					telegramBotToken,
				});
				if (!capability.ok) {
					result.skipped += 1;
					result.decisions.push({
						state: "skipped",
						reason_code: capability.reasonCode,
						binding_id: binding.binding_id,
						channel: binding.channel,
						dedupe_key: bindingDedupeKey,
						outbox_id: null,
					});
					continue;
				}

				const envelope = buildWakeOutboundEnvelope({
					repoRoot: opts.repoRoot,
					nowMs,
					message,
					binding,
					context,
					metadata: notifyOpts.metadata,
				});
				const enqueueDecision = await outbox.enqueue({
					dedupeKey: bindingDedupeKey,
					envelope,
					nowMs,
					maxAttempts: WAKE_OUTBOX_MAX_ATTEMPTS,
				});
				if (enqueueDecision.kind === "enqueued") {
					result.queued += 1;
					scheduleOutboxDrainRef?.();
					result.decisions.push({
						state: "queued",
						reason_code: "outbox_enqueued",
						binding_id: binding.binding_id,
						channel: binding.channel,
						dedupe_key: bindingDedupeKey,
						outbox_id: enqueueDecision.record.outbox_id,
					});
				} else {
					result.duplicate += 1;
					result.decisions.push({
						state: "duplicate",
						reason_code: "outbox_duplicate",
						binding_id: binding.binding_id,
						channel: binding.channel,
						dedupe_key: bindingDedupeKey,
						outbox_id: enqueueDecision.record.outbox_id,
					});
				}
			}

			return result;
		};

		const deliver = async (record: OutboxRecord): Promise<undefined | OutboxDeliveryHandlerResult> => {
			return await deliveryRouter.deliver(record);
		};

		const outboxDrain = createOutboxDrainLoop({
			outbox,
			deliver,
			onOutcome: async (outcome) => {
				if (!wakeDeliveryObserver) {
					return;
				}
				const metadata = wakeDeliveryMetadataFromOutboxRecord(outcome.record);
				if (!metadata) {
					return;
				}
				const state =
					outcome.kind === "delivered" ? "delivered" : outcome.kind === "retried" ? "retried" : "dead_letter";
				await wakeDeliveryObserver({
					state,
					reason_code: wakeDispatchReasonCode({
						state,
						lastError: outcome.record.last_error,
						deadLetterReason: outcome.record.dead_letter_reason,
					}),
					wake_id: metadata.wakeId,
					dedupe_key: metadata.wakeDedupeKey,
					binding_id: metadata.bindingId,
					channel: metadata.channel,
					outbox_id: metadata.outboxId,
					outbox_dedupe_key: metadata.outboxDedupeKey,
					attempt_count: outcome.record.attempt_count,
				});
			},
		});
		const scheduleOutboxDrain = outboxDrain.scheduleOutboxDrain;
		scheduleOutboxDrainRef = scheduleOutboxDrain;
		outboxDrainLoop = outboxDrain;

		return {
			get activeAdapters(): ActiveAdapter[] {
				return [...adapterMap.values()].filter((entry) => entry.isActive()).map((v) => v.info);
			},

			async handleWebhook(path: string, req: Request): Promise<Response | null> {
				const entry = adapterMap.get(path);
				if (!entry || !entry.isActive()) return null;
				const result = await entry.adapter.ingest(req);
				if (result.outboxRecord) {
					scheduleOutboxDrain();
				}
				return result.response;
			},

			async notifyOperators(notifyOpts: NotifyOperatorsOpts): Promise<NotifyOperatorsResult> {
				return await notifyOperators(notifyOpts);
			},

			setWakeDeliveryObserver(observer: WakeDeliveryObserver | null): void {
				wakeDeliveryObserver = observer;
			},

			async reloadTelegramGeneration(reloadOpts: {
				config: ControlPlaneConfig;
				reason: string;
			}): Promise<TelegramGenerationReloadResult> {
				const result = await telegramManager.reload({
					config: reloadOpts.config,
					reason: reloadOpts.reason,
				});
				if (result.handled && result.ok) {
					scheduleOutboxDrain();
				}
				return result;
			},


			async submitTerminalCommand(terminalOpts: {
				commandText: string;
				repoRoot: string;
				requestId?: string;
			}): Promise<CommandPipelineResult> {
				if (!pipeline) {
					throw new Error("control_plane_pipeline_unavailable");
				}
				return await pipeline.handleTerminalInbound(terminalOpts);
			},

			async stop(): Promise<void> {
				wakeDeliveryObserver = null;
				if (outboxDrainLoop) {
					outboxDrainLoop.stop();
					outboxDrainLoop = null;
				}
				for (const { adapter } of adapterMap.values()) {
					try {
						await adapter.stop?.();
					} catch {
						// Best effort adapter cleanup.
					}
				}
				try {
					await pipeline?.stop();
				} finally {
					await runtime.stop();
				}
			},
		};
	} catch (err) {
		wakeDeliveryObserver = null;
		if (outboxDrainLoop) {
			outboxDrainLoop.stop();
			outboxDrainLoop = null;
		}
		for (const { adapter } of adapterMap.values()) {
			try {
				await adapter.stop?.();
			} catch {
				// Best effort cleanup.
			}
		}
		try {
			await pipeline?.stop();
		} catch {
			// Best effort cleanup.
		}
		try {
			await runtime.stop();
		} catch {
			// Best effort cleanup.
		}
		throw err;
	}
}
