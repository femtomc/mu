import type { MessagingOperatorBackend, MessagingOperatorRuntime } from "@femtomc/mu-agent";
import {
	normalizeUiDocs,
	resolveUiStatusProfileName,
	type UiAction,
	type UiComponent,
	type UiDoc,
	type UiEvent,
} from "@femtomc/mu-core";
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
	buildSanitizedUiEventForAction,
	buildSlackUiActionId,
	getControlPlanePaths,
	issueUiDocActionPayloads,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
	TelegramControlPlaneAdapterSpec,
	uiActionPayloadContextFromOutboxRecord,
	uiDocActionPayloadKey,
	UiCallbackTokenStore,
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

type TelegramInlineKeyboardButton = {
	text: string;
	callback_data: string;
};

type TelegramInlineKeyboardMarkup = {
	inline_keyboard: TelegramInlineKeyboardButton[][];
};

export type TelegramSendMessagePayload = {
	chat_id: string;
	text: string;
	parse_mode?: "Markdown";
	disable_web_page_preview?: boolean;
	reply_markup?: TelegramInlineKeyboardMarkup;
	reply_to_message_id?: number;
	allow_sending_without_reply?: boolean;
};

type SlackApiOkResponse = {
	ok: boolean;
	error?: string;
	ts?: string;
};

type SlackChatPostMessageResponse = SlackApiOkResponse;
type SlackChatUpdateResponse = SlackApiOkResponse;
type SlackFileUploadResponse = SlackApiOkResponse;

export type TelegramSendPhotoPayload = {
	chat_id: string;
	photo: string;
	caption?: string;
	reply_to_message_id?: number;
	allow_sending_without_reply?: boolean;
};

export type TelegramSendDocumentPayload = {
	chat_id: string;
	document: string;
	caption?: string;
	reply_to_message_id?: number;
	allow_sending_without_reply?: boolean;
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

/**
 * Slack mrkdwn does not support Markdown headings.
 * Normalize common heading markers while preserving fenced blocks.
 */
export function renderSlackMarkdown(text: string): string {
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

const TELEGRAM_MESSAGE_MAX_LEN = 4_096;

function maybeParseTelegramMessageId(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

export function splitTelegramMessageText(text: string, maxLen: number = TELEGRAM_MESSAGE_MAX_LEN): string[] {
	if (text.length <= maxLen) {
		return [text];
	}
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const end = Math.min(text.length, cursor + maxLen);
		if (end === text.length) {
			chunks.push(text.slice(cursor));
			break;
		}
		const window = text.slice(cursor, end);
		const splitAtNewline = window.lastIndexOf("\n");
		const splitPoint = splitAtNewline >= Math.floor(maxLen * 0.5) ? cursor + splitAtNewline + 1 : end;
		chunks.push(text.slice(cursor, splitPoint));
		cursor = splitPoint;
	}
	return chunks;
}

const SLACK_MESSAGE_MAX_LEN = 3_500;

type SlackMessageButtonElement = {
	type: "button";
	text: { type: "plain_text"; text: string };
	value: string;
	action_id: string;
};

type SlackLayoutBlock =
	| { type: "section"; text: { type: "mrkdwn"; text: string } }
	| { type: "actions"; elements: SlackMessageButtonElement[] }
	| { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

const SLACK_BLOCK_TEXT_MAX_LEN = 3_000;
const SLACK_BLOCKS_MAX = 50;
const SLACK_ACTIONS_MAX_PER_BLOCK = 5;
const SLACK_ACTIONS_MAX_TOTAL = 20;
const SLACK_ACTION_VALUE_MAX_CHARS = 2_000;
const SLACK_UI_EVENT_ACTION_ID = buildSlackUiActionId("ui_event");
const UI_DOCS_MAX = 3;
const UI_CALLBACK_TOKEN_TTL_MS = 15 * 60_000;
export const UI_COMPONENT_SUPPORT = {
	text: true,
	list: true,
	key_value: true,
	divider: true,
} as const;
export const UI_ACTIONS_UNSUPPORTED_REASON = "ui_actions_not_implemented";

function truncateSlackText(text: string, maxLen: number = SLACK_BLOCK_TEXT_MAX_LEN): string {
	if (text.length <= maxLen) {
		return text;
	}
	if (maxLen <= 1) {
		return text.slice(0, maxLen);
	}
	return `${text.slice(0, maxLen - 1)}…`;
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

export function uiDocTextLines(doc: UiDoc, opts: { includeActions?: boolean } = {}): string[] {
	const lines = [`UI · ${doc.title}`];
	if (doc.summary) {
		lines.push(doc.summary);
	}
	const componentLines = uiDocComponentLines(doc);
	if (componentLines.length > 0) {
		lines.push(...componentLines);
	}
	if (opts.includeActions !== false) {
		const actionLines = uiDocActionLines(doc);
		if (actionLines.length > 0) {
			lines.push("Actions:");
			lines.push(...actionLines);
		}
	}
	return lines;
}

export function uiDocsTextFallback(uiDocs: readonly UiDoc[]): string {
	if (uiDocs.length === 0) {
		return "";
	}
	const sections = uiDocs.map((doc) => uiDocTextLines(doc).join("\n"));
	return sections.join("\n\n");
}

function appendUiDocText(body: string, uiDocs: readonly UiDoc[]): string {
	const fallback = uiDocsTextFallback(uiDocs);
	if (!fallback) {
		return body;
	}
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return fallback;
	}
	return `${trimmed}\n\n${fallback}`;
}

function uiDocActionTextLine(action: UiAction, opts: { suffix?: string } = {}): string {
	const parts = [`• ${action.label}`];
	if (action.description) {
		parts.push(action.description);
	}
	parts.push(`(id=${action.id}${opts.suffix ? `; ${opts.suffix}` : ""})`);
	return parts.join(" ");
}

function statusProfileVariant(doc: UiDoc): string {
	const profile = doc.metadata.profile;
	if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
		return "status";
	}
	const rawVariant =
		typeof (profile as Record<string, unknown>).variant === "string"
			? ((profile as Record<string, unknown>).variant as string).trim().toLowerCase()
			: "";
	return rawVariant.length > 0 ? rawVariant : "status";
}

function isStatusProfileStatusVariant(doc: UiDoc): boolean {
	return resolveUiStatusProfileName(doc) !== null && statusProfileVariant(doc) === "status";
}

function uiDocDeterministicActionFallbackLine(action: UiAction): string {
	const commandText = commandTextForUiDocAction(action);
	if (commandText) {
		return `• ${action.label}: ${commandText}`;
	}
	return `• ${action.label}: interactive unavailable (missing command_text)`;
}

function uiDocActionButtons(
	doc: UiDoc,
	actionPayloadsByKey: ReadonlyMap<string, string>,
): {
	buttons: SlackMessageButtonElement[];
	fallbackLines: string[];
} {
	const buttons: SlackMessageButtonElement[] = [];
	const fallbackLines: string[] = [];
	const statusProfile = isStatusProfileStatusVariant(doc);
	const actions = [...doc.actions].sort((a, b) => a.id.localeCompare(b.id)).slice(0, SLACK_ACTIONS_MAX_TOTAL);
	for (const action of actions) {
		if (statusProfile) {
			fallbackLines.push(uiDocDeterministicActionFallbackLine(action));
			continue;
		}
		const payload = actionPayloadsByKey.get(uiDocActionPayloadKey(doc.ui_id, action.id));
		if (!payload) {
			fallbackLines.push(uiDocActionTextLine(action, { suffix: "interactive unavailable" }));
			continue;
		}
		if (payload.length > SLACK_ACTION_VALUE_MAX_CHARS) {
			fallbackLines.push(uiDocActionTextLine(action, { suffix: "interactive payload too large" }));
			continue;
		}
		buttons.push({
			type: "button",
			text: {
				type: "plain_text",
				text: truncateSlackText(action.label, 75),
			},
			value: payload,
			action_id: SLACK_UI_EVENT_ACTION_ID,
		});
	}
	return { buttons, fallbackLines };
}

export function splitSlackMessageText(text: string, maxLen: number = SLACK_MESSAGE_MAX_LEN): string[] {
	if (text.length <= maxLen) {
		return [text];
	}
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const end = Math.min(text.length, cursor + maxLen);
		if (end === text.length) {
			chunks.push(text.slice(cursor));
			break;
		}
		const window = text.slice(cursor, end);
		const splitAtNewline = window.lastIndexOf("\n");
		const splitPoint = splitAtNewline >= Math.floor(maxLen * 0.5) ? cursor + splitAtNewline + 1 : end;
		chunks.push(text.slice(cursor, splitPoint));
		cursor = splitPoint;
	}
	return chunks;
}

function slackBlocksForOutboxRecord(
	body: string,
	uiDocs: readonly UiDoc[],
	opts: {
		uiDocActionPayloadsByKey?: ReadonlyMap<string, string>;
	} = {},
): SlackLayoutBlock[] | undefined {
	if (uiDocs.length === 0) {
		return undefined;
	}
	const uiDocActionPayloadsByKey = opts.uiDocActionPayloadsByKey ?? new Map<string, string>();
	const blocks: SlackLayoutBlock[] = [];
	const headerText = body.trim().length > 0 ? body : "Update";
	blocks.push({
		type: "section",
		text: { type: "mrkdwn", text: truncateSlackText(headerText) },
	});

	for (const doc of uiDocs) {
		if (blocks.length >= SLACK_BLOCKS_MAX) {
			break;
		}
		const lines = uiDocTextLines(doc, { includeActions: false });
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: truncateSlackText(lines[0]) }],
		});
		for (const line of lines.slice(1)) {
			if (blocks.length >= SLACK_BLOCKS_MAX) {
				break;
			}
			blocks.push({
				type: "section",
				text: { type: "mrkdwn", text: truncateSlackText(line) },
			});
		}

		const actionRender = uiDocActionButtons(doc, uiDocActionPayloadsByKey);
		for (let idx = 0; idx < actionRender.buttons.length; idx += SLACK_ACTIONS_MAX_PER_BLOCK) {
			if (blocks.length >= SLACK_BLOCKS_MAX) {
				break;
			}
			blocks.push({
				type: "actions",
				elements: actionRender.buttons.slice(idx, idx + SLACK_ACTIONS_MAX_PER_BLOCK),
			});
		}
		if (actionRender.fallbackLines.length > 0 && blocks.length < SLACK_BLOCKS_MAX) {
			blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: truncateSlackText(`Actions:\n${actionRender.fallbackLines.join("\n")}`),
				},
			});
		}
	}

	return blocks.slice(0, SLACK_BLOCKS_MAX);
}

function slackThreadTsFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
	const value = metadata?.slack_thread_ts;
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function slackStatusMessageTsFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
	const value = metadata?.slack_status_message_ts;
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const TELEGRAM_ACTIONS_MAX_TOTAL = 20;
const TELEGRAM_ACTIONS_PER_ROW = 3;

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function telegramTextForOutboxRecord(body: string, uiDocs: readonly UiDoc[]): string {
	const lines: string[] = [body.trim()];
	const uiFallback = uiDocsTextFallback(uiDocs);
	if (uiFallback) {
		lines.push("", uiFallback);
	}
	return lines.join("\n").trim();
}

type TelegramCallbackDataEncoder = (commandText: string, opts: { record: OutboxRecord; uiEvent?: UiEvent }) => Promise<string>;

type TelegramActionRender = {
	buttonEntries: Array<{ button: TelegramInlineKeyboardButton; fallbackLine: string }>;
	overflowLines: string[];
};

function telegramReplyMarkupFromButtons(buttons: readonly TelegramInlineKeyboardButton[]): TelegramInlineKeyboardMarkup | undefined {
	if (buttons.length === 0) {
		return undefined;
	}
	const inline_keyboard: TelegramInlineKeyboardButton[][] = [];
	for (let idx = 0; idx < buttons.length; idx += TELEGRAM_ACTIONS_PER_ROW) {
		inline_keyboard.push(buttons.slice(idx, idx + TELEGRAM_ACTIONS_PER_ROW));
	}
	return { inline_keyboard };
}

function telegramOverflowText(lines: readonly string[]): string {
	if (lines.length === 0) {
		return "";
	}
	return `\n\nActions:\n${lines.join("\n")}`;
}

function commandTextForUiDocAction(action: UiAction): string | null {
	const fromMetadata = typeof action.metadata.command_text === "string" ? action.metadata.command_text.trim() : "";
	if (fromMetadata.length === 0) {
		return null;
	}
	return fromMetadata;
}

async function compileTelegramUiDocActions(opts: {
	record: OutboxRecord;
	uiDocs: readonly UiDoc[];
	nowMs: number;
	encodeCallbackData?: TelegramCallbackDataEncoder;
}): Promise<TelegramActionRender> {
	if (opts.uiDocs.length === 0) {
		return { buttonEntries: [], overflowLines: [] };
	}

	const buttonEntries: TelegramActionRender["buttonEntries"] = [];
	const overflowLines: string[] = [];
	for (const doc of opts.uiDocs) {
		const statusProfile = isStatusProfileStatusVariant(doc);
		const actions = [...doc.actions].sort((a, b) => a.id.localeCompare(b.id));
		for (const action of actions) {
			const commandText = commandTextForUiDocAction(action);
			const fallbackLine = commandText
				? `• ${action.label}: ${commandText}`
				: `• ${action.label}: interactive unavailable (missing command_text)`;
			if (statusProfile) {
				overflowLines.push(fallbackLine);
				continue;
			}
			const uiEvent = buildSanitizedUiEventForAction({
				doc,
				action,
				createdAtMs: opts.nowMs,
			});
			if (!commandText || !uiEvent) {
				overflowLines.push(fallbackLine);
				continue;
			}
			if (!opts.encodeCallbackData) {
				overflowLines.push(fallbackLine);
				continue;
			}

			let callbackData: string;
			try {
				callbackData = await opts.encodeCallbackData(commandText, {
					record: opts.record,
					uiEvent,
				});
			} catch {
				overflowLines.push(fallbackLine);
				continue;
			}
			if (utf8ByteLength(callbackData) > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
				overflowLines.push(fallbackLine);
				continue;
			}
			buttonEntries.push({
				button: {
					text: action.label.slice(0, 64),
					callback_data: callbackData,
				},
				fallbackLine,
			});
		}
	}

	return { buttonEntries, overflowLines };
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

async function sendTelegramTextChunks(opts: {
	botToken: string;
	basePayload: TelegramSendMessagePayload;
	fallbackToPlainOnMarkdownError: boolean;
}): Promise<{ ok: true } | { ok: false; response: Response; body: string }> {
	const chunks = splitTelegramMessageText(opts.basePayload.text);
	for (const [index, chunk] of chunks.entries()) {
		const payload: TelegramSendMessagePayload = {
			...opts.basePayload,
			text: chunk,
			...(index === 0 ? {} : { reply_markup: undefined, reply_to_message_id: undefined, allow_sending_without_reply: undefined }),
		};
		let res = await postTelegramMessage(opts.botToken, payload);
		if (!res.ok && res.status === 400 && payload.parse_mode && opts.fallbackToPlainOnMarkdownError) {
			const plainPayload = buildTelegramSendMessagePayload({
				chatId: payload.chat_id,
				text: payload.text,
				richFormatting: false,
			});
			res = await postTelegramMessage(opts.botToken, {
				...plainPayload,
				...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
				...(payload.reply_to_message_id != null
					? {
							reply_to_message_id: payload.reply_to_message_id,
							allow_sending_without_reply: payload.allow_sending_without_reply,
						}
					: {}),
			});
		}
		if (!res.ok) {
			return { ok: false, response: res, body: await res.text().catch(() => "") };
		}
	}
	return { ok: true };
}

export async function deliverTelegramOutboxRecord(opts: {
	botToken: string;
	record: OutboxRecord;
	encodeCallbackData?: TelegramCallbackDataEncoder;
}): Promise<OutboxDeliveryHandlerResult> {
	const { botToken, record } = opts;
	const uiDocs = normalizeUiDocs(record.envelope.metadata?.ui_docs, { maxDocs: UI_DOCS_MAX });
	const nowMs = Math.trunc(Date.now());
	const uiActions = await compileTelegramUiDocActions({
		record,
		uiDocs,
		nowMs,
		encodeCallbackData: opts.encodeCallbackData,
	});
	const visibleEntries = uiActions.buttonEntries.slice(0, TELEGRAM_ACTIONS_MAX_TOTAL);
	const overflowLines = [
		...uiActions.overflowLines,
		...uiActions.buttonEntries.slice(TELEGRAM_ACTIONS_MAX_TOTAL).map((entry) => entry.fallbackLine),
	];
	const replyMarkup = telegramReplyMarkupFromButtons(visibleEntries.map((entry) => entry.button));
	const replyToMessageId = maybeParseTelegramMessageId(record.envelope.metadata?.telegram_reply_to_message_id);
	const telegramText = `${telegramTextForOutboxRecord(record.envelope.body, uiDocs)}${telegramOverflowText(overflowLines)}`.trim();
	const fallbackMessagePayload = {
		...buildTelegramSendMessagePayload({
			chatId: record.envelope.channel_conversation_id,
			text: telegramText,
			richFormatting: true,
		}),
		...(replyMarkup ? { reply_markup: replyMarkup } : {}),
		...(replyToMessageId != null
			? {
					reply_to_message_id: replyToMessageId,
					allow_sending_without_reply: true,
				}
			: {}),
	};

	const firstAttachment = record.envelope.attachments?.[0] ?? null;
	if (!firstAttachment) {
		const sent = await sendTelegramTextChunks({
			botToken,
			basePayload: fallbackMessagePayload,
			fallbackToPlainOnMarkdownError: true,
		});
		if (sent.ok) {
			return { kind: "delivered" };
		}
		if (sent.response.status === 429 || sent.response.status >= 500) {
			return {
				kind: "retry",
				error: `telegram sendMessage ${sent.response.status}: ${sent.body}`,
				retryDelayMs: parseRetryDelayMs(sent.response),
			};
		}
		return {
			kind: "retry",
			error: `telegram sendMessage ${sent.response.status}: ${sent.body}`,
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
					...(replyToMessageId != null
						? {
								reply_to_message_id: replyToMessageId,
								allow_sending_without_reply: true,
							}
						: {}),
				}
				: {
					chat_id: record.envelope.channel_conversation_id,
					document: firstAttachment.reference.file_id,
					caption: mediaCaption,
					...(replyToMessageId != null
						? {
								reply_to_message_id: replyToMessageId,
								allow_sending_without_reply: true,
							}
						: {}),
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
		if (replyToMessageId != null) {
			form.append("reply_to_message_id", String(replyToMessageId));
			form.append("allow_sending_without_reply", "true");
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

	const fallbackPlainPayload = {
		...buildTelegramSendMessagePayload({
			chatId: record.envelope.channel_conversation_id,
			text: record.envelope.body,
			richFormatting: false,
		}),
		...(replyMarkup ? { reply_markup: replyMarkup } : {}),
		...(replyToMessageId != null
			? {
					reply_to_message_id: replyToMessageId,
					allow_sending_without_reply: true,
				}
			: {}),
	};
	const fallbackSent = await sendTelegramTextChunks({
		botToken,
		basePayload: fallbackPlainPayload,
		fallbackToPlainOnMarkdownError: false,
	});
	if (fallbackSent.ok) {
		return { kind: "delivered" };
	}
	if (fallbackSent.response.status === 429 || fallbackSent.response.status >= 500) {
		return {
			kind: "retry",
			error: `telegram media fallback sendMessage ${fallbackSent.response.status}: ${fallbackSent.body}`,
			retryDelayMs: parseRetryDelayMs(fallbackSent.response),
		};
	}
	return {
		kind: "retry",
		error: `telegram media fallback sendMessage ${fallbackSent.response.status}: ${fallbackSent.body} (media_error=${mediaMethod} ${mediaResponse.status}: ${mediaBody})`,
	};
}

async function postSlackJson<T extends SlackApiOkResponse>(opts: {
	botToken: string;
	method: "chat.postMessage" | "chat.update";
	payload: Record<string, unknown>;
	fetchImpl?: typeof fetch;
}): Promise<{ response: Response; payload: T | null }> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const response = await fetchImpl(`https://slack.com/api/${opts.method}`, {
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
	uiCallbackTokenStore?: UiCallbackTokenStore;
	nowMs?: () => number;
	fetchImpl?: typeof fetch;
}): Promise<OutboxDeliveryHandlerResult> {
	const { botToken, record } = opts;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const attachments = record.envelope.attachments ?? [];
	const uiDocs = normalizeUiDocs(record.envelope.metadata?.ui_docs, { maxDocs: UI_DOCS_MAX });
	const interactiveUiDocs = uiDocs.filter((doc) => !isStatusProfileStatusVariant(doc));
	let uiDocActionPayloadsByKey = new Map<string, string>();
	if (opts.uiCallbackTokenStore && interactiveUiDocs.some((doc) => doc.actions.length > 0)) {
		const issued = await issueUiDocActionPayloads({
			uiDocs: interactiveUiDocs,
			tokenStore: opts.uiCallbackTokenStore,
			context: uiActionPayloadContextFromOutboxRecord(record),
			ttlMs: UI_CALLBACK_TOKEN_TTL_MS,
			nowMs: Math.trunc((opts.nowMs ?? Date.now)()),
		});
		uiDocActionPayloadsByKey = new Map(issued.map((entry) => [entry.key, entry.payload_json]));
	}
	const renderedBodyForBlocks = renderSlackMarkdown(record.envelope.body);
	const blocks = slackBlocksForOutboxRecord(renderedBodyForBlocks, uiDocs, {
		uiDocActionPayloadsByKey,
	});
	const bodyForText = blocks
		? record.envelope.body.trim().length > 0
			? record.envelope.body
			: "Update"
		: appendUiDocText(record.envelope.body, uiDocs);
	const renderedBody = renderSlackMarkdown(bodyForText);
	const textChunks = splitSlackMessageText(renderedBody);
	const threadTs = slackThreadTsFromMetadata(record.envelope.metadata);
	const statusMessageTs = slackStatusMessageTsFromMetadata(record.envelope.metadata);
	if (attachments.length === 0) {
		let chunkStartIndex = 0;
		if (statusMessageTs && textChunks.length > 0) {
			const updated = await postSlackJson<SlackChatUpdateResponse>({
				botToken,
				method: "chat.update",
				payload: {
					channel: record.envelope.channel_conversation_id,
					ts: statusMessageTs,
					text: textChunks[0],
					unfurl_links: false,
					unfurl_media: false,
					...(blocks ? { blocks } : {}),
				},
				fetchImpl,
			});
			if (updated.response.ok && updated.payload?.ok) {
				chunkStartIndex = 1;
			} else {
				const status = updated.response.status;
				const err = updated.payload?.error ?? "unknown_error";
				if (status === 429 || status >= 500) {
					return {
						kind: "retry",
						error: `slack chat.update ${status}: ${err}`,
						retryDelayMs: parseRetryDelayMs(updated.response),
					};
				}
				if (err !== "message_not_found" && err !== "cant_update_message") {
					return { kind: "retry", error: `slack chat.update ${status}: ${err}` };
				}
			}
		}
		for (const [index, chunk] of textChunks.entries()) {
			if (index < chunkStartIndex) {
				continue;
			}
			const delivered = await postSlackJson<SlackChatPostMessageResponse>({
				botToken,
				method: "chat.postMessage",
				payload: {
					channel: record.envelope.channel_conversation_id,
					text: chunk,
					unfurl_links: false,
					unfurl_media: false,
					...(index === 0 && blocks ? { blocks } : {}),
					...(threadTs ? { thread_ts: threadTs } : {}),
				},
				fetchImpl,
			});
			if (delivered.response.ok && delivered.payload?.ok) {
				continue;
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
		return { kind: "delivered" };
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
		const source = await fetchImpl(referenceUrl);
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
			form.set("initial_comment", textChunks[0] ?? record.envelope.body);
		}
		if (threadTs) {
			form.set("thread_ts", threadTs);
		}
		form.set("file", new Blob([bytes], { type: contentType }), filename);

		const uploaded = await fetchImpl("https://slack.com/api/files.upload", {
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

	if (firstError || textChunks.length > 1) {
		for (const [index, chunk] of textChunks.entries()) {
			if (index === 0 && !firstError) {
				continue;
			}
			const fallback = await postSlackJson<SlackChatPostMessageResponse>({
				botToken,
				method: "chat.postMessage",
				payload: {
					channel: record.envelope.channel_conversation_id,
					text: chunk,
					unfurl_links: false,
					unfurl_media: false,
					...(threadTs ? { thread_ts: threadTs } : {}),
				},
				fetchImpl,
			});
			if (fallback.response.ok && fallback.payload?.ok) {
				continue;
			}
			const status = fallback.response.status;
			const err = fallback.payload?.error ?? "unknown_error";
			if (status === 429 || status >= 500) {
				return {
					kind: "retry",
					error: `slack chat.postMessage fallback ${status}: ${err}${firstError ? ` (upload_error=${firstError})` : ""}`,
					retryDelayMs: parseRetryDelayMs(fallback.response),
				};
			}
			return {
				kind: "retry",
				error: `slack chat.postMessage fallback ${status}: ${err}${firstError ? ` (upload_error=${firstError})` : ""}`,
			};
		}
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
	const uiCallbackTokenStore = new UiCallbackTokenStore(paths.uiCallbackTokenPath);

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
		await uiCallbackTokenStore.load();
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
		});
		await pipeline.start();

		const telegramManager = new TelegramAdapterGenerationManager({
			pipeline,
			outbox,
			uiCallbackTokenStore,
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
			uiCallbackTokenStore,
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
						uiCallbackTokenStore,
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
						encodeCallbackData: async (commandText: string, encodeOpts: { record: OutboxRecord; uiEvent?: UiEvent }) => {
							const active = telegramManager.activeAdapter();
							if (!active) {
								return commandText;
							}
							return await active.issueCallbackToken({
								commandText,
								actorId: encodeOpts.record.envelope.correlation.actor_id,
								actorBindingId: encodeOpts.record.envelope.correlation.actor_binding_id,
								conversationId: encodeOpts.record.envelope.channel_conversation_id,
								uiEvent: encodeOpts.uiEvent,
							});
						},
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


			async submitAutonomousIngress(autonomousOpts: {
				text: string;
				repoRoot: string;
				requestId?: string;
				metadata?: Record<string, unknown>;
			}): Promise<CommandPipelineResult> {
				if (!pipeline) {
					throw new Error("control_plane_pipeline_unavailable");
				}
				return await pipeline.handleAutonomousIngress(autonomousOpts);
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
