import { z } from "zod";

export const HUD_CONTRACT_VERSION = 1;

const NonEmptyTextSchema = z.string().trim().min(1);

export const HudToneSchema = z.enum(["info", "success", "warning", "error", "muted", "accent", "dim"]);
export type HudTone = z.infer<typeof HudToneSchema>;

export const HudActionKindSchema = z.enum(["primary", "secondary", "danger"]);
export type HudActionKind = z.infer<typeof HudActionKindSchema>;

export const HudTextWeightSchema = z.enum(["normal", "strong"]);
export type HudTextWeight = z.infer<typeof HudTextWeightSchema>;

export const HudTextStyleSchema = z
	.object({
		weight: HudTextWeightSchema.optional(),
		italic: z.boolean().optional(),
		code: z.boolean().optional(),
	})
	.strict();
export type HudTextStyle = z.infer<typeof HudTextStyleSchema>;

export const HudChipSchema = z
	.object({
		key: NonEmptyTextSchema,
		label: NonEmptyTextSchema,
		tone: HudToneSchema.optional(),
		style: HudTextStyleSchema.optional(),
	})
	.strict();
export type HudChip = z.infer<typeof HudChipSchema>;

export const HudKvItemSchema = z
	.object({
		key: NonEmptyTextSchema,
		label: NonEmptyTextSchema,
		value: NonEmptyTextSchema,
		tone: HudToneSchema.optional(),
		value_style: HudTextStyleSchema.optional(),
	})
	.strict();
export type HudKvItem = z.infer<typeof HudKvItemSchema>;

export const HudChecklistItemSchema = z
	.object({
		id: NonEmptyTextSchema,
		label: NonEmptyTextSchema,
		done: z.boolean(),
		style: HudTextStyleSchema.optional(),
	})
	.strict();
export type HudChecklistItem = z.infer<typeof HudChecklistItemSchema>;

export const HudSectionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("kv"),
			title: NonEmptyTextSchema.optional(),
			title_style: HudTextStyleSchema.optional(),
			items: z.array(HudKvItemSchema).default([]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("checklist"),
			title: NonEmptyTextSchema.optional(),
			title_style: HudTextStyleSchema.optional(),
			items: z.array(HudChecklistItemSchema).default([]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("activity"),
			title: NonEmptyTextSchema.optional(),
			title_style: HudTextStyleSchema.optional(),
			lines: z.array(NonEmptyTextSchema).default([]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("text"),
			title: NonEmptyTextSchema.optional(),
			title_style: HudTextStyleSchema.optional(),
			text: NonEmptyTextSchema,
			tone: HudToneSchema.optional(),
			style: HudTextStyleSchema.optional(),
		})
		.strict(),
]);
export type HudSection = z.infer<typeof HudSectionSchema>;

export const HudActionSchema = z
	.object({
		id: NonEmptyTextSchema,
		label: NonEmptyTextSchema,
		command_text: NonEmptyTextSchema,
		kind: HudActionKindSchema.optional(),
		style: HudTextStyleSchema.optional(),
	})
	.strict();
export type HudAction = z.infer<typeof HudActionSchema>;

export const HudDocSchema = z
	.object({
		v: z.literal(HUD_CONTRACT_VERSION).default(HUD_CONTRACT_VERSION),
		hud_id: NonEmptyTextSchema,
		title: NonEmptyTextSchema,
		title_style: HudTextStyleSchema.optional(),
		scope: NonEmptyTextSchema.nullable().default(null),
		chips: z.array(HudChipSchema).default([]),
		sections: z.array(HudSectionSchema).default([]),
		actions: z.array(HudActionSchema).default([]),
		snapshot_compact: NonEmptyTextSchema,
		snapshot_style: HudTextStyleSchema.optional(),
		snapshot_multiline: NonEmptyTextSchema.optional(),
		updated_at_ms: z.number().int().nonnegative(),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type HudDoc = z.infer<typeof HudDocSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHudDocCandidate(value: unknown): HudDoc | null {
	const parsed = HudDocSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

export const HUD_STYLE_PRESET_NAMES = ["planning", "subagents"] as const;
export type HudStylePresetName = (typeof HUD_STYLE_PRESET_NAMES)[number];

function isHudStylePresetName(value: string): value is HudStylePresetName {
	return (HUD_STYLE_PRESET_NAMES as readonly string[]).includes(value);
}

function hudStylePresetNameFromMetadata(metadata: Record<string, unknown>): HudStylePresetName | null {
	const raw = metadata.style_preset;
	if (typeof raw !== "string") {
		return null;
	}
	const normalized = raw.trim().toLowerCase();
	if (!normalized || !isHudStylePresetName(normalized)) {
		return null;
	}
	return normalized;
}

function mergeHudTextStyle(preferred: HudTextStyle | undefined, fallback: HudTextStyle | undefined): HudTextStyle | undefined {
	if (!preferred && !fallback) {
		return undefined;
	}
	const merged = {
		...(fallback ?? {}),
		...(preferred ?? {}),
	};
	if (merged.weight === undefined && merged.italic === undefined && merged.code === undefined) {
		return undefined;
	}
	return merged;
}

function defaultChipStyle(chip: HudChip): HudTextStyle {
	if (chip.tone === "dim" || chip.tone === "muted") {
		return { weight: "normal" };
	}
	return { weight: "strong" };
}

function planningKvValueStyle(item: HudKvItem): HudTextStyle | undefined {
	switch (item.key) {
		case "root":
		case "next":
		case "next_action":
			return { code: true };
		default:
			return undefined;
	}
}

function applyPlanningPreset(doc: HudDoc): HudDoc {
	return {
		...doc,
		title_style: mergeHudTextStyle(doc.title_style, { weight: "strong" }),
		snapshot_style: mergeHudTextStyle(doc.snapshot_style, { italic: true }),
		chips: doc.chips.map((chip) => ({
			...chip,
			style: mergeHudTextStyle(chip.style, defaultChipStyle(chip)),
		})),
		sections: doc.sections.map((section) => {
			switch (section.kind) {
				case "kv":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
						items: section.items.map((item) => ({
							...item,
							value_style: mergeHudTextStyle(item.value_style, planningKvValueStyle(item)),
						})),
					};
				case "checklist":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
					};
				case "activity":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
					};
				case "text":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
					};
			}
		}),
		actions: doc.actions.map((action) => ({
			...action,
			style: mergeHudTextStyle(action.style, { italic: true }),
		})),
	};
}

function applySubagentsPreset(doc: HudDoc): HudDoc {
	return {
		...doc,
		title_style: mergeHudTextStyle(doc.title_style, { weight: "strong" }),
		snapshot_style: mergeHudTextStyle(doc.snapshot_style, { italic: true }),
		chips: doc.chips.map((chip) => ({
			...chip,
			style: mergeHudTextStyle(chip.style, defaultChipStyle(chip)),
		})),
		sections: doc.sections.map((section) => {
			switch (section.kind) {
				case "kv":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
					};
				case "checklist":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
					};
				case "activity":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
					};
				case "text":
					return {
						...section,
						title_style: mergeHudTextStyle(section.title_style, { weight: "strong" }),
					};
			}
		}),
		actions: doc.actions.map((action) => ({
			...action,
			style: mergeHudTextStyle(action.style, { weight: "strong" }),
		})),
	};
}

function hasChipKey(doc: HudDoc, key: string): boolean {
	return doc.chips.some((chip) => chip.key === key);
}

function hasSectionKind(doc: HudDoc, kind: HudSection["kind"]): boolean {
	return doc.sections.some((section) => section.kind === kind);
}

function hudStylePresetWarningsForDoc(doc: HudDoc, preset: HudStylePresetName): string[] {
	const warnings: string[] = [];
	switch (preset) {
		case "planning":
			if (doc.hud_id !== "planning") {
				warnings.push(`style_preset=planning expects hud_id=planning (got ${doc.hud_id})`);
			}
			if (!hasChipKey(doc, "phase")) {
				warnings.push("style_preset=planning recommends chip key 'phase'");
			}
			if (!hasSectionKind(doc, "kv")) {
				warnings.push("style_preset=planning recommends a kv section");
			}
			if (!hasSectionKind(doc, "checklist")) {
				warnings.push("style_preset=planning recommends a checklist section");
			}
			break;
		case "subagents":
			if (doc.hud_id !== "subagents") {
				warnings.push(`style_preset=subagents expects hud_id=subagents (got ${doc.hud_id})`);
			}
			if (!hasChipKey(doc, "health")) {
				warnings.push("style_preset=subagents recommends chip key 'health'");
			}
			if (!hasSectionKind(doc, "kv")) {
				warnings.push("style_preset=subagents recommends a kv section");
			}
			if (!hasSectionKind(doc, "activity")) {
				warnings.push("style_preset=subagents recommends an activity section");
			}
			break;
	}
	return warnings;
}

export function hudStylePresetWarnings(input: unknown): string[] {
	const doc = parseHudDocCandidate(input);
	if (!doc) {
		return [];
	}
	const preset = hudStylePresetNameFromMetadata(doc.metadata);
	if (!preset) {
		return [];
	}
	return hudStylePresetWarningsForDoc(doc, preset);
}

export function resolveHudStylePresetName(input: unknown): HudStylePresetName | null {
	const doc = parseHudDocCandidate(input);
	if (!doc) {
		return null;
	}
	return hudStylePresetNameFromMetadata(doc.metadata);
}

export function applyHudStylePreset(input: unknown): HudDoc | null {
	const doc = parseHudDocCandidate(input);
	if (!doc) {
		return null;
	}
	const preset = hudStylePresetNameFromMetadata(doc.metadata);
	if (!preset) {
		return doc;
	}
	switch (preset) {
		case "planning":
			return applyPlanningPreset(doc);
		case "subagents":
			return applySubagentsPreset(doc);
	}
}

function deterministicHudDocChoice(a: HudDoc, b: HudDoc): HudDoc {
	if (a.updated_at_ms !== b.updated_at_ms) {
		return a.updated_at_ms > b.updated_at_ms ? a : b;
	}
	const left = stableSerializeJson(a);
	const right = stableSerializeJson(b);
	return left <= right ? a : b;
}

function hudDocCandidates(input: unknown): unknown[] {
	if (Array.isArray(input)) {
		return input;
	}
	if (isPlainObject(input)) {
		return [input];
	}
	return [];
}

function normalizedHudDocLimit(limit: unknown): number {
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

export type HudTextFallbackMode = "compact" | "multiline";

function truncateText(value: string, maxChars: number): string {
	if (maxChars <= 0) {
		return "";
	}
	if (value.length <= maxChars) {
		return value;
	}
	if (maxChars <= 1) {
		return "…";
	}
	return `${value.slice(0, maxChars - 1)}…`;
}

function appendOverflowLine(lines: string[], hiddenCount: number): void {
	if (hiddenCount > 0) {
		lines.push(`… (+${hiddenCount} more)`);
	}
}

export function serializeHudDocTextFallback(
	input: unknown,
	opts: {
		mode?: HudTextFallbackMode;
		maxChars?: number;
		maxSectionItems?: number;
		maxActions?: number;
	} = {},
): string {
	const doc = parseHudDocCandidate(input);
	if (!doc) {
		return "";
	}
	const mode = opts.mode ?? "multiline";
	const maxChars = typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars) ? Math.max(32, Math.trunc(opts.maxChars)) : 8_192;
	if (mode === "compact") {
		const compact = `${doc.title} · ${doc.snapshot_compact}`;
		return truncateText(compact, maxChars);
	}

	const maxSectionItems =
		typeof opts.maxSectionItems === "number" && Number.isFinite(opts.maxSectionItems)
			? Math.max(1, Math.trunc(opts.maxSectionItems))
			: 8;
	const maxActions =
		typeof opts.maxActions === "number" && Number.isFinite(opts.maxActions) ? Math.max(1, Math.trunc(opts.maxActions)) : 4;

	const lines: string[] = [];
	lines.push(`${doc.title} [${doc.hud_id}]`);
	if (doc.scope) {
		lines.push(`scope: ${doc.scope}`);
	}
	if (doc.chips.length > 0) {
		lines.push(`chips: ${doc.chips.map((chip) => chip.label).join(" · ")}`);
	}
	for (const section of doc.sections) {
		const title = section.title ? ` (${section.title})` : "";
		switch (section.kind) {
			case "kv": {
				lines.push(`section: kv${title}`);
				const visible = section.items.slice(0, maxSectionItems);
				for (const item of visible) {
					lines.push(`- ${item.label}: ${item.value}`);
				}
				appendOverflowLine(lines, section.items.length - visible.length);
				break;
			}
			case "checklist": {
				lines.push(`section: checklist${title}`);
				const visible = section.items.slice(0, maxSectionItems);
				for (const item of visible) {
					lines.push(`- [${item.done ? "x" : " "}] ${item.label}`);
				}
				appendOverflowLine(lines, section.items.length - visible.length);
				break;
			}
			case "activity": {
				lines.push(`section: activity${title}`);
				const visible = section.lines.slice(0, maxSectionItems);
				for (const line of visible) {
					lines.push(`- ${line}`);
				}
				appendOverflowLine(lines, section.lines.length - visible.length);
				break;
			}
			case "text":
				lines.push(`section: text${title}`);
				lines.push(`- ${section.text}`);
				break;
		}
	}
	if (doc.actions.length > 0) {
		lines.push("actions:");
		const visible = doc.actions.slice(0, maxActions);
		for (const action of visible) {
			lines.push(`- ${action.label}: ${action.command_text}`);
		}
		appendOverflowLine(lines, doc.actions.length - visible.length);
	}
	return truncateText(lines.join("\n"), maxChars);
}

export function serializeHudDocsTextFallback(
	input: unknown,
	opts: {
		mode?: HudTextFallbackMode;
		maxChars?: number;
		maxDocs?: number;
		maxSectionItems?: number;
		maxActions?: number;
	} = {},
): string {
	const docs = normalizeHudDocs(input, { maxDocs: opts.maxDocs });
	if (docs.length === 0) {
		return "";
	}
	const mode = opts.mode ?? "multiline";
	const rendered = docs
		.map((doc) =>
			serializeHudDocTextFallback(doc, {
				mode,
				maxChars: opts.maxChars,
				maxSectionItems: opts.maxSectionItems,
				maxActions: opts.maxActions,
			}),
		)
		.filter((value) => value.length > 0);
	return rendered.join(mode === "compact" ? " | " : "\n\n");
}

export function parseHudDoc(input: unknown): HudDoc | null {
	return parseHudDocCandidate(input);
}

export function normalizeHudDocs(input: unknown, opts: { maxDocs?: number } = {}): HudDoc[] {
	const maxDocs = normalizedHudDocLimit(opts.maxDocs);
	const byId = new Map<string, HudDoc>();
	for (const candidate of hudDocCandidates(input)) {
		const parsed = parseHudDocCandidate(candidate);
		if (!parsed) {
			continue;
		}
		const current = byId.get(parsed.hud_id);
		if (!current) {
			byId.set(parsed.hud_id, parsed);
			continue;
		}
		byId.set(parsed.hud_id, deterministicHudDocChoice(current, parsed));
	}
	const docs = [...byId.values()].sort((left, right) => left.hud_id.localeCompare(right.hud_id));
	if (docs.length <= maxDocs) {
		return docs;
	}
	return docs.slice(0, maxDocs);
}
