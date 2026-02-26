import { z } from "zod";

export const UiToneSchema = z.enum(["info", "success", "warning", "error", "muted", "accent", "dim"]);
export type UiTone = z.infer<typeof UiToneSchema>;

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
		tone: UiToneSchema.optional(),
	})
	.strict();
export type UiListItem = z.infer<typeof UiListItemSchema>;

export const UiKeyValueRowSchema = z
	.object({
		key: NonEmptyText(UI_KEY_MAX_LENGTH),
		value: NonEmptyText(UI_VALUE_MAX_LENGTH),
		tone: UiToneSchema.optional(),
	})
	.strict();
export type UiKeyValueRow = z.infer<typeof UiKeyValueRowSchema>;

export const UiComponentTextSchema = z
	.object({
		kind: z.literal("text"),
		id: NonEmptyId,
		text: NonEmptyText(UI_TEXT_COMPONENT_MAX_LENGTH),
		tone: UiToneSchema.optional(),
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

export const UI_STATUS_PROFILE_NAMES = ["planning", "subagents", "control-flow", "model-routing"] as const;
export type UiStatusProfileName = (typeof UI_STATUS_PROFILE_NAMES)[number];

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

const UI_PROFILE_VARIANTS = ["status", "interactive"] as const;
type UiProfileVariant = (typeof UI_PROFILE_VARIANTS)[number];

const UI_STATUS_PROFILE_UI_IDS: Record<UiStatusProfileName, string> = {
	planning: "ui:planning",
	subagents: "ui:subagents",
	"control-flow": "ui:control-flow",
	"model-routing": "ui:model-routing",
};

const UI_STATUS_PROFILE_COMPONENT_RECOMMENDATIONS: Record<UiStatusProfileName, readonly UiComponent["kind"][]> = {
	planning: ["key_value", "list"],
	subagents: ["key_value", "list"],
	"control-flow": ["key_value"],
	"model-routing": ["key_value", "list"],
};

const UI_PLANNING_STATUS_ROW_KEY_ALIASES = {
	phase: ["phase"],
	waiting: ["waiting", "waiting_on_user"],
	confidence: ["confidence", "conf"],
	next: ["next", "next_action"],
	blocker: ["blocker"],
} as const;

const UI_PLANNING_CHECKLIST_MIN_ITEMS = 3;

function isUiStatusProfileName(value: string): value is UiStatusProfileName {
	return (UI_STATUS_PROFILE_NAMES as readonly string[]).includes(value);
}

function isUiProfileVariant(value: string): value is UiProfileVariant {
	return (UI_PROFILE_VARIANTS as readonly string[]).includes(value);
}

function uiProfileMetadata(doc: UiDoc): Record<string, unknown> | null {
	const raw = doc.metadata.profile;
	if (!isPlainObject(raw)) {
		return null;
	}
	return raw;
}

function uiStatusProfileNameFromDoc(doc: UiDoc): UiStatusProfileName | null {
	const profile = uiProfileMetadata(doc);
	if (!profile) {
		return null;
	}
	const raw = profile.id;
	if (typeof raw !== "string") {
		return null;
	}
	const normalized = raw.trim().toLowerCase();
	if (!normalized || !isUiStatusProfileName(normalized)) {
		return null;
	}
	return normalized;
}

function hasUiComponentKind(doc: UiDoc, kind: UiComponent["kind"]): boolean {
	return doc.components.some((component) => component.kind === kind);
}

function hasProfileSnapshotCompact(profile: Record<string, unknown>): boolean {
	const snapshot = profile.snapshot;
	if (!isPlainObject(snapshot)) {
		return false;
	}
	const compact = snapshot.compact;
	return typeof compact === "string" && compact.trim().length > 0;
}

function normalizeStatusRowKey(key: string): string {
	return key
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_");
}

function keyValueStatusRows(doc: UiDoc): Set<string> {
	const rows = new Set<string>();
	for (const component of doc.components) {
		if (component.kind !== "key_value") {
			continue;
		}
		for (const row of component.rows) {
			rows.add(normalizeStatusRowKey(row.key));
		}
	}
	return rows;
}

function firstChecklistComponent(doc: UiDoc): Extract<UiComponent, { kind: "list" }> | null {
	for (const component of doc.components) {
		if (component.kind === "list") {
			return component;
		}
	}
	return null;
}

function hasPlanningMetadataField(doc: UiDoc, key: "phase" | "waiting_on_user" | "confidence"): boolean {
	const value = doc.metadata[key];
	if (key === "waiting_on_user") {
		return typeof value === "boolean";
	}
	return typeof value === "string" && value.trim().length > 0;
}

function planningStatusProfileWarnings(doc: UiDoc): string[] {
	const warnings: string[] = [];
	const statusRows = keyValueStatusRows(doc);
	for (const [field, aliases] of Object.entries(UI_PLANNING_STATUS_ROW_KEY_ALIASES)) {
		const hasField = aliases.some((alias) => statusRows.has(alias));
		if (!hasField) {
			warnings.push(`profile.id=planning recommends key_value row key=${field}`);
		}
	}

	const checklist = firstChecklistComponent(doc);
	if (checklist) {
		if (checklist.items.length < UI_PLANNING_CHECKLIST_MIN_ITEMS) {
			warnings.push(
				`profile.id=planning recommends checklist lists with at least ${UI_PLANNING_CHECKLIST_MIN_ITEMS} items`,
			);
		}
		const detailedItems = checklist.items.filter(
			(item) => typeof item.detail === "string" && item.detail.trim().length > 0,
		).length;
		if (detailedItems === 0) {
			warnings.push("profile.id=planning recommends checklist item detail values (for example done/pending)");
		}
	}

	if (!hasPlanningMetadataField(doc, "phase")) {
		warnings.push("profile.id=planning recommends metadata.phase");
	}
	if (!hasPlanningMetadataField(doc, "waiting_on_user")) {
		warnings.push("profile.id=planning recommends metadata.waiting_on_user");
	}
	if (!hasPlanningMetadataField(doc, "confidence")) {
		warnings.push("profile.id=planning recommends metadata.confidence");
	}
	return warnings;
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

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeJson(entry));
	}
	if (!isPlainObject(value)) {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const nextValue = value[key];
		if (nextValue === undefined) {
			continue;
		}
		out[key] = canonicalizeJson(nextValue);
	}
	return out;
}

export function stableSerializeJson(value: unknown, opts: { pretty?: boolean } = {}): string {
	const normalized = canonicalizeJson(value);
	const text = JSON.stringify(normalized, null, opts.pretty ? 2 : undefined);
	return text ?? "null";
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

export function resolveUiStatusProfileName(input: unknown): UiStatusProfileName | null {
	const doc = parseUiDocCandidate(input);
	if (!doc) {
		return null;
	}
	return uiStatusProfileNameFromDoc(doc);
}

export function uiStatusProfileWarnings(input: unknown): string[] {
	const doc = parseUiDocCandidate(input);
	if (!doc) {
		return [];
	}
	const profileName = uiStatusProfileNameFromDoc(doc);
	if (!profileName) {
		return [];
	}

	const warnings: string[] = [];
	const profile = uiProfileMetadata(doc);
	if (!profile) {
		return warnings;
	}

	const rawVariant = typeof profile.variant === "string" ? profile.variant.trim().toLowerCase() : "";
	let variant: UiProfileVariant = "status";
	if (rawVariant.length > 0) {
		if (isUiProfileVariant(rawVariant)) {
			variant = rawVariant;
		} else {
			warnings.push(`profile.id=${profileName} has unsupported metadata.profile.variant=${rawVariant}`);
		}
	}

	if (variant !== "status") {
		warnings.push(
			`profile.id=${profileName} status validation expects metadata.profile.variant=status (got ${variant})`,
		);
	}

	const expectedUiId = UI_STATUS_PROFILE_UI_IDS[profileName];
	if (doc.ui_id !== expectedUiId) {
		warnings.push(`profile.id=${profileName} expects ui_id=${expectedUiId} (got ${doc.ui_id})`);
	}
	if (!doc.summary) {
		warnings.push(`profile.id=${profileName} recommends summary for deterministic status fallback`);
	}
	if (!hasProfileSnapshotCompact(profile)) {
		warnings.push(`profile.id=${profileName} recommends metadata.profile.snapshot.compact`);
	}
	if (doc.actions.length > 0) {
		warnings.push(`profile.id=${profileName} status docs should omit actions (got ${doc.actions.length})`);
	}

	for (const kind of UI_STATUS_PROFILE_COMPONENT_RECOMMENDATIONS[profileName]) {
		if (!hasUiComponentKind(doc, kind)) {
			warnings.push(`profile.id=${profileName} recommends a ${kind} component`);
		}
	}
	if (profileName === "planning") {
		warnings.push(...planningStatusProfileWarnings(doc));
	}
	return warnings;
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
