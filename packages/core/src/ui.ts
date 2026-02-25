import { z } from "zod";
import { HudToneSchema, stableSerializeJson } from "./hud.js";

export const UI_CONTRACT_VERSION = 1 as const;

const UI_DOC_TITLE_MAX_LENGTH = 256;
const UI_DOC_SUBTITLE_MAX_LENGTH = 512;
const UI_DOC_SUMMARY_MAX_LENGTH = 1024;
const UI_COMPONENT_LIMIT = 64;
const UI_TEXT_COMPONENT_MAX_LENGTH = 2048;
const UI_LIST_ITEM_LIMIT = 32;
const UI_LIST_ITEM_DETAIL_MAX_LENGTH = 1024;
const UI_KEY_VALUE_ROW_LIMIT = 32;
const UI_KEY_MAX_LENGTH = 64;
const UI_VALUE_MAX_LENGTH = 256;
const UI_ACTION_LIMIT = 32;
const UI_ACTION_LABEL_MAX_LENGTH = 128;
const UI_ACTION_DESCRIPTION_MAX_LENGTH = 512;
const UI_CALLBACK_TOKEN_MAX_LENGTH = 128;
const UI_REVISION_ID_MAX_LENGTH = 64;

const NonEmptyText = (max: number) => z.string().trim().min(1).max(max);
const NonEmptyId = z.string().trim().min(1).max(64);
const CallbackTokenSchema = z.string().trim().min(1).max(UI_CALLBACK_TOKEN_MAX_LENGTH);

export const UiListItemSchema = z
	.object({
		id: NonEmptyId,
		label: NonEmptyText(UI_ACTION_LABEL_MAX_LENGTH),
		detail: NonEmptyText(UI_LIST_ITEM_DETAIL_MAX_LENGTH).optional(),
		tone: HudToneSchema.optional(),
	})
	.strict();
export type UiListItem = z.infer<typeof UiListItemSchema>;

export const UiKeyValueRowSchema = z
	.object({
		key: NonEmptyText(UI_KEY_MAX_LENGTH),
		value: NonEmptyText(UI_VALUE_MAX_LENGTH),
		tone: HudToneSchema.optional(),
	})
	.strict();
export type UiKeyValueRow = z.infer<typeof UiKeyValueRowSchema>;

export const UiComponentTextSchema = z
	.object({
		kind: z.literal("text"),
		id: NonEmptyId,
		text: NonEmptyText(UI_TEXT_COMPONENT_MAX_LENGTH),
		tone: HudToneSchema.optional(),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type UiComponentText = z.infer<typeof UiComponentTextSchema>;

export const UiComponentListSchema = z
	.object({
		kind: z.literal("list"),
		id: NonEmptyId,
		title: NonEmptyText(UI_DOC_SUBTITLE_MAX_LENGTH).optional(),
		items: z.array(UiListItemSchema).min(1).max(UI_LIST_ITEM_LIMIT),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();

export const UiComponentKeyValueSchema = z
	.object({
		kind: z.literal("key_value"),
		id: NonEmptyId,
		title: NonEmptyText(UI_DOC_SUBTITLE_MAX_LENGTH).optional(),
		rows: z.array(UiKeyValueRowSchema).min(1).max(UI_KEY_VALUE_ROW_LIMIT),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();

export const UiComponentDividerSchema = z
	.object({
		kind: z.literal("divider"),
		id: NonEmptyId,
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();

export const UiComponentSchema = z.discriminatedUnion("kind", [
	UiComponentTextSchema,
	UiComponentListSchema,
	UiComponentKeyValueSchema,
	UiComponentDividerSchema,
]);
export type UiComponent = z.infer<typeof UiComponentSchema>;

export const UiActionKindSchema = z.enum(["primary", "secondary", "danger", "link"]);
export type UiActionKind = z.infer<typeof UiActionKindSchema>;

export const UiActionSchema = z
	.object({
		id: NonEmptyId,
		label: NonEmptyText(UI_ACTION_LABEL_MAX_LENGTH),
		kind: UiActionKindSchema.optional(),
		description: NonEmptyText(UI_ACTION_DESCRIPTION_MAX_LENGTH).optional(),
		component_id: NonEmptyId.optional(),
		callback_token: CallbackTokenSchema.optional(),
		payload: z.record(z.string(), z.unknown()).default({}),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type UiAction = z.infer<typeof UiActionSchema>;

export const UiRevisionSchema = z
	.object({
		id: NonEmptyText(UI_REVISION_ID_MAX_LENGTH),
		version: z.number().int().nonnegative(),
	})
	.strict();
export type UiRevision = z.infer<typeof UiRevisionSchema>;

export const UiDocSchema = z
	.object({
		v: z.literal(UI_CONTRACT_VERSION).default(UI_CONTRACT_VERSION),
		ui_id: NonEmptyId,
		title: NonEmptyText(UI_DOC_TITLE_MAX_LENGTH),
		summary: NonEmptyText(UI_DOC_SUMMARY_MAX_LENGTH).optional(),
		components: z.array(UiComponentSchema).min(1).max(UI_COMPONENT_LIMIT),
		actions: z.array(UiActionSchema).max(UI_ACTION_LIMIT).default([]),
		revision: UiRevisionSchema,
		updated_at_ms: z.number().int().nonnegative(),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type UiDoc = z.infer<typeof UiDocSchema>;

export const UiEventSchema = z
	.object({
		ui_id: NonEmptyId,
		action_id: NonEmptyId,
		component_id: NonEmptyId.optional().nullable(),
		revision: UiRevisionSchema,
		callback_token: CallbackTokenSchema.optional(),
		payload: z.record(z.string(), z.unknown()).default({}),
		created_at_ms: z.number().int().nonnegative(),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type UiEvent = z.infer<typeof UiEventSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUiDocCandidate(value: unknown): UiDoc | null {
	const parsed = UiDocSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

function uiDocCandidates(input: unknown): unknown[] {
	if (Array.isArray(input)) {
		return input;
	}
	if (isPlainObject(input)) {
		return [input];
	}
	return [];
}

function normalizedUiDocLimit(limit: unknown): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		return 12;
	}
	const parsed = Math.trunc(limit);
	if (parsed < 1) {
		return 1;
	}
	if (parsed > 64) {
		return 64;
	}
	return parsed;
}

function deterministicUiDocChoice(left: UiDoc, right: UiDoc): UiDoc {
	if (left.revision.version !== right.revision.version) {
		return left.revision.version > right.revision.version ? left : right;
	}
	if (left.updated_at_ms !== right.updated_at_ms) {
		return left.updated_at_ms > right.updated_at_ms ? left : right;
	}
	const leftText = stableSerializeJson(left);
	const rightText = stableSerializeJson(right);
	return leftText <= rightText ? left : right;
}

export function parseUiDoc(input: unknown): UiDoc | null {
	return parseUiDocCandidate(input);
}

export function normalizeUiDocs(input: unknown, opts: { maxDocs?: number } = {}): UiDoc[] {
	const maxDocs = normalizedUiDocLimit(opts.maxDocs);
	const byId = new Map<string, UiDoc>();
	for (const candidate of uiDocCandidates(input)) {
		const parsed = parseUiDocCandidate(candidate);
		if (!parsed) {
			continue;
		}
		const current = byId.get(parsed.ui_id);
		if (!current) {
			byId.set(parsed.ui_id, parsed);
			continue;
		}
		byId.set(parsed.ui_id, deterministicUiDocChoice(current, parsed));
	}
	const docs = [...byId.values()].sort((a, b) => a.ui_id.localeCompare(b.ui_id));
	if (docs.length <= maxDocs) {
		return docs;
	}
	return docs.slice(0, maxDocs);
}

export function uiDocRevisionConflict(left: UiDoc, right: UiDoc): boolean {
	if (left.ui_id !== right.ui_id) {
		return false;
	}
	if (left.revision.version !== right.revision.version) {
		return false;
	}
	return stableSerializeJson(left) !== stableSerializeJson(right);
}

export function parseUiEvent(input: unknown): UiEvent | null {
	const parsed = UiEventSchema.safeParse(input);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}
