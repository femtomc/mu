import {
	applyHudStylePreset,
	hudStylePresetWarnings,
	HudDocSchema,
	type HudActionKind,
	type HudDoc,
	type HudTextStyle,
	type HudTone,
	normalizeHudDocs,
	serializeHudDocsTextFallback,
} from "@femtomc/mu-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

type HudToolAction =
	| "status"
	| "snapshot"
	| "on"
	| "off"
	| "toggle"
	| "set"
	| "update"
	| "replace"
	| "remove"
	| "clear";

type HudToolParams = {
	action: HudToolAction;
	doc?: unknown;
	docs?: unknown;
	hud_id?: string;
	snapshot_format?: string;
};

type HudState = {
	enabled: boolean;
	docsById: Map<string, HudDoc>;
};

const HUD_DISPLAY_DOCS_MAX = 16;
const HUD_STORE_DOCS_MAX = 64;
const HUD_LINE_MAX = 120;
const HUD_CHIPS_MAX = 8;
const HUD_SECTION_ITEMS_MAX = 6;
const HUD_ACTIONS_MAX = 4;
const HUD_LABEL_MAX = 28;
const HUD_VALUE_MAX = 84;

type ThemeColor = Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0];
type ThemeShape = ExtensionContext["ui"]["theme"];

function themeBold(theme: ThemeShape, text: string): string {
	if (typeof theme.bold === "function") {
		return theme.bold(text);
	}
	return text;
}

function themeItalic(theme: ThemeShape, text: string): string {
	if (typeof theme.italic === "function") {
		return theme.italic(text);
	}
	return text;
}

function themeInverse(theme: ThemeShape, text: string): string {
	if (typeof theme.inverse === "function") {
		return theme.inverse(text);
	}
	return text;
}

function applyHudTextStyle(
	theme: ThemeShape,
	text: string,
	style: HudTextStyle | undefined,
	opts: {
		defaultWeight?: HudTextStyle["weight"];
		defaultItalic?: boolean;
		defaultCode?: boolean;
	} = {},
): string {
	let out = text;
	const weight = style?.weight ?? opts.defaultWeight;
	const italic = style?.italic ?? opts.defaultItalic ?? false;
	const code = style?.code ?? opts.defaultCode ?? false;
	if (code) {
		out = themeInverse(theme, out);
	}
	if (italic) {
		out = themeItalic(theme, out);
	}
	if (weight === "strong") {
		out = themeBold(theme, out);
	}
	return out;
}

function toneColor(tone: HudTone | undefined): ThemeColor {
	switch (tone) {
		case "success":
			return "success";
		case "warning":
			return "warning";
		case "error":
			return "error";
		case "muted":
			return "muted";
		case "dim":
			return "dim";
		case "accent":
			return "accent";
		case "info":
		default:
			return "text";
	}
}

function actionKindColor(kind: HudActionKind | undefined): ThemeColor {
	switch (kind) {
		case "primary":
			return "accent";
		case "danger":
			return "error";
		case "secondary":
		default:
			return "dim";
	}
}

function sectionFallbackTitle(kind: HudDoc["sections"][number]["kind"]): string {
	switch (kind) {
		case "kv":
			return "Details";
		case "checklist":
			return "Checklist";
		case "activity":
			return "Activity";
		case "text":
			return "Notes";
	}
}

function createDefaultState(): HudState {
	return {
		enabled: false,
		docsById: new Map(),
	};
}

function parseSnapshotFormat(raw: string | undefined): "compact" | "multiline" {
	const value = (raw ?? "compact").trim().toLowerCase();
	return value === "multiline" ? "multiline" : "compact";
}

function short(text: string, max = HUD_LINE_MAX): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) {
		return normalized;
	}
	if (max <= 1) {
		return "…";
	}
	return `${normalized.slice(0, max - 1)}…`;
}

function sectionHeading(theme: ThemeShape, section: HudDoc["sections"][number]): string {
	const title = short(section.title ?? sectionFallbackTitle(section.kind), 48);
	const styledTitle = applyHudTextStyle(theme, title, section.title_style, { defaultWeight: "strong" });
	return [theme.fg("accent", styledTitle), theme.fg("dim", `(${section.kind})`)].join(" ");
}

function renderHudWidgetLines(theme: ThemeShape, docs: HudDoc[]): string[] {
	const lines: string[] = [];
	for (const [docIndex, doc] of docs.entries()) {
		if (docIndex > 0) {
			lines.push(theme.fg("muted", "─".repeat(26)));
		}

		const title = short(doc.title, 64);
		const hudId = short(doc.hud_id, 32);
		const styledTitle = applyHudTextStyle(theme, title, doc.title_style, { defaultWeight: "strong" });
		lines.push(`${theme.fg("accent", styledTitle)} ${theme.fg("dim", `[${hudId}]`)}`);

		if (doc.scope) {
			lines.push(`${theme.fg("dim", "scope:")} ${theme.fg("muted", short(doc.scope, HUD_LINE_MAX - 7))}`);
		}

		if (doc.chips.length > 0) {
			const visible = doc.chips.slice(0, HUD_CHIPS_MAX);
			const chips = visible.map((chip) => {
				const color = toneColor(chip.tone);
				const label = short(chip.label, 28);
				const chipLabel = applyHudTextStyle(theme, label, chip.style, {
					defaultWeight: color === "muted" || color === "dim" ? "normal" : "strong",
				});
				return theme.fg(color, chipLabel);
			});
			const hiddenCount = doc.chips.length - visible.length;
			if (hiddenCount > 0) {
				chips.push(theme.fg("dim", `+${hiddenCount}`));
			}
			lines.push(chips.join(theme.fg("muted", " · ")));
		}

		for (const section of doc.sections) {
			lines.push(sectionHeading(theme, section));
			switch (section.kind) {
				case "kv": {
					const visible = section.items.slice(0, HUD_SECTION_ITEMS_MAX);
					for (const item of visible) {
						const keyLabel = short(item.label, HUD_LABEL_MAX);
						const valueMax = Math.max(16, HUD_LINE_MAX - keyLabel.length - 8);
						const valueLabel = short(item.value, Math.min(HUD_VALUE_MAX, valueMax));
						const styledValue = applyHudTextStyle(theme, valueLabel, item.value_style);
						lines.push(
							`  ${theme.fg("muted", "-")} ${theme.fg("dim", `${keyLabel}:`)} ${theme.fg(toneColor(item.tone), styledValue)}`,
						);
					}
					const hiddenCount = section.items.length - visible.length;
					if (hiddenCount > 0) {
						lines.push(theme.fg("dim", `  … (+${hiddenCount} more)`));
					}
					break;
				}
				case "checklist": {
					const visible = section.items.slice(0, HUD_SECTION_ITEMS_MAX);
					for (const item of visible) {
						const marker = item.done ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
						const textColor: ThemeColor = item.done ? "dim" : "text";
						const label = short(item.label, HUD_LINE_MAX - 8);
						const styledLabel = applyHudTextStyle(theme, label, item.style);
						lines.push(`  ${marker} ${theme.fg(textColor, styledLabel)}`);
					}
					const hiddenCount = section.items.length - visible.length;
					if (hiddenCount > 0) {
						lines.push(theme.fg("dim", `  … (+${hiddenCount} more)`));
					}
					break;
				}
				case "activity": {
					const visible = section.lines.slice(0, HUD_SECTION_ITEMS_MAX);
					for (const line of visible) {
						lines.push(`  ${theme.fg("muted", "-")} ${theme.fg("dim", short(line, HUD_LINE_MAX - 6))}`);
					}
					const hiddenCount = section.lines.length - visible.length;
					if (hiddenCount > 0) {
						lines.push(theme.fg("dim", `  … (+${hiddenCount} more)`));
					}
					break;
				}
				case "text": {
					const text = short(section.text, HUD_LINE_MAX - 4);
					const styledText = applyHudTextStyle(theme, text, section.style);
					lines.push(`  ${theme.fg(toneColor(section.tone), styledText)}`);
					break;
				}
			}
		}

		if (doc.actions.length > 0) {
			lines.push(theme.fg("accent", applyHudTextStyle(theme, "Actions", undefined, { defaultWeight: "strong" })));
			const visible = doc.actions.slice(0, HUD_ACTIONS_MAX);
			for (const action of visible) {
				const color = actionKindColor(action.kind);
				const label = short(action.label, HUD_LABEL_MAX);
				const styledLabel = applyHudTextStyle(theme, label, action.style, { defaultWeight: "strong" });
				const commandText = short(action.command_text, HUD_VALUE_MAX);
				lines.push(`  ${theme.fg(color, styledLabel)} ${theme.fg("dim", commandText)}`);
			}
			const hiddenCount = doc.actions.length - visible.length;
			if (hiddenCount > 0) {
				lines.push(theme.fg("dim", `  … (+${hiddenCount} more)`));
			}
		}

		const snapshotText = short(doc.snapshot_compact, HUD_LINE_MAX - 10);
		const styledSnapshot = applyHudTextStyle(theme, snapshotText, doc.snapshot_style, { defaultItalic: true });
		lines.push(`${theme.fg("dim", "snapshot:")} ${theme.fg("muted", styledSnapshot)}`);
	}
	return lines;
}

function activeDocs(state: HudState, maxDocs = HUD_DISPLAY_DOCS_MAX): HudDoc[] {
	return normalizeHudDocs([...state.docsById.values()], { maxDocs });
}

function statusSummary(state: HudState): string {
	const docs = activeDocs(state, HUD_STORE_DOCS_MAX);
	const ids = docs.map((doc) => doc.hud_id).join(", ") || "(none)";
	return [
		`HUD: ${state.enabled ? "enabled" : "disabled"}`,
		`docs: ${docs.length}`,
		`ids: ${ids}`,
	].join("\n");
}

function renderHud(ctx: ExtensionContext, state: HudState): void {
	if (!ctx.hasUI) {
		return;
	}
	const docs = activeDocs(state);
	if (!state.enabled || docs.length === 0) {
		ctx.ui.setStatus("mu-hud", undefined);
		ctx.ui.setWidget("mu-hud", undefined);
		return;
	}

	const idLabel = short(docs.map((doc) => doc.hud_id).join(", "), 64);
	ctx.ui.setStatus(
		"mu-hud",
		[
			ctx.ui.theme.fg("dim", "hud"),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("accent", `${docs.length}`),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("dim", idLabel),
		].join(" "),
	);

	const docsForRender = docs.map((doc) => applyHudStylePreset(doc) ?? doc);
	const lines = renderHudWidgetLines(ctx.ui.theme, docsForRender);
	ctx.ui.setWidget(
		"mu-hud",
		lines.length > 0 ? lines : [ctx.ui.theme.fg("dim", "(hud enabled, no docs)")],
		{ placement: "belowEditor" },
	);
}

function parseHudDoc(input: unknown): { ok: true; doc: HudDoc } | { ok: false; error: string } {
	const parsed = HudDocSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid HUD doc." };
	}
	return { ok: true, doc: parsed.data };
}

function parseHudDocList(input: unknown): { ok: true; docs: HudDoc[] } | { ok: false; error: string } {
	if (!Array.isArray(input)) {
		return { ok: false, error: "docs must be an array." };
	}
	const docs: HudDoc[] = [];
	for (let idx = 0; idx < input.length; idx += 1) {
		const parsed = parseHudDoc(input[idx]);
		if (!parsed.ok) {
			return { ok: false, error: `docs[${idx}]: ${parsed.error}` };
		}
		docs.push(parsed.doc);
	}
	return { ok: true, docs: normalizeHudDocs(docs, { maxDocs: HUD_STORE_DOCS_MAX }) };
}

function presetWarningsExtraForDoc(doc: HudDoc): Record<string, unknown> {
	const warnings = hudStylePresetWarnings(doc);
	if (warnings.length === 0) {
		return {};
	}
	return { preset_warnings: warnings };
}

function presetWarningsExtraForDocs(docs: HudDoc[]): Record<string, unknown> {
	const byHudId: Record<string, string[]> = {};
	for (const doc of docs) {
		const warnings = hudStylePresetWarnings(doc);
		if (warnings.length > 0) {
			byHudId[doc.hud_id] = warnings;
		}
	}
	return Object.keys(byHudId).length > 0 ? { preset_warnings: byHudId } : {};
}

function hudToolResult(opts: {
	state: HudState;
	ok: boolean;
	action: HudToolAction;
	message: string;
	extra?: Record<string, unknown>;
}) {
	const docs = activeDocs(opts.state, HUD_STORE_DOCS_MAX);
	return {
		content: [{ type: "text" as const, text: opts.message }],
		hud_docs: docs,
		details: {
			ok: opts.ok,
			action: opts.action,
			enabled: opts.state.enabled,
			doc_count: docs.length,
			hud_ids: docs.map((doc) => doc.hud_id),
			...(opts.ok ? {} : { error: opts.message }),
			...(opts.extra ?? {}),
		},
	};
}

function applyHudAction(params: HudToolParams, state: HudState): {
	ok: boolean;
	message: string;
	action: HudToolAction;
	extra?: Record<string, unknown>;
} {
	switch (params.action) {
		case "status": {
			return {
				ok: true,
				action: "status",
				message: statusSummary(state),
			};
		}
		case "snapshot": {
			const mode = parseSnapshotFormat(params.snapshot_format);
			const docs = activeDocs(state, HUD_STORE_DOCS_MAX);
			const message = docs.length
				? serializeHudDocsTextFallback(docs, { mode, maxDocs: HUD_STORE_DOCS_MAX, maxSectionItems: 8, maxActions: 6 })
				: "(no HUD docs)";
			return {
				ok: true,
				action: "snapshot",
				message,
				extra: { snapshot_format: mode },
			};
		}
		case "on":
			state.enabled = true;
			return { ok: true, action: "on", message: "HUD enabled." };
		case "off":
			state.enabled = false;
			return { ok: true, action: "off", message: "HUD disabled." };
		case "toggle":
			state.enabled = !state.enabled;
			return { ok: true, action: "toggle", message: `HUD ${state.enabled ? "enabled" : "disabled"}.` };
		case "set":
		case "update": {
			const parsed = parseHudDoc(params.doc);
			if (!parsed.ok) {
				return { ok: false, action: params.action, message: parsed.error };
			}
			state.enabled = true;
			state.docsById.set(parsed.doc.hud_id, parsed.doc);
			return {
				ok: true,
				action: params.action,
				message: `HUD doc set: ${parsed.doc.hud_id}`,
				extra: { hud_id: parsed.doc.hud_id, ...presetWarningsExtraForDoc(parsed.doc) },
			};
		}
		case "replace": {
			const parsed = parseHudDocList(params.docs);
			if (!parsed.ok) {
				return { ok: false, action: "replace", message: parsed.error };
			}
			state.docsById.clear();
			for (const doc of parsed.docs) {
				state.docsById.set(doc.hud_id, doc);
			}
			state.enabled = true;
			return {
				ok: true,
				action: "replace",
				message: `HUD docs replaced (${parsed.docs.length}).`,
				extra: presetWarningsExtraForDocs(parsed.docs),
			};
		}
		case "remove": {
			const hudId = (params.hud_id ?? "").trim();
			if (!hudId) {
				return { ok: false, action: "remove", message: "Missing hud_id." };
			}
			const removed = state.docsById.delete(hudId);
			if (!removed) {
				return { ok: false, action: "remove", message: `HUD doc not found: ${hudId}` };
			}
			return { ok: true, action: "remove", message: `HUD doc removed: ${hudId}` };
		}
		case "clear":
			state.docsById.clear();
			return { ok: true, action: "clear", message: "HUD docs cleared." };
	}
}

function usageText(): string {
	return [
		"Usage:",
		"  /mu hud status|snapshot",
		"  /mu hud on|off|toggle",
		"  /mu hud clear",
		"  /mu hud remove <hud-id>",
		"",
		"For setting/updating docs, use the mu_hud tool with action=set|update|replace.",
	].join("\n");
}

function parseCommandAction(args: string): HudToolParams | null {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	const command = tokens[0] ?? "status";
	switch (command) {
		case "status":
			return { action: "status" };
		case "snapshot":
			return { action: "snapshot", snapshot_format: tokens[1] };
		case "on":
			return { action: "on" };
		case "off":
			return { action: "off" };
		case "toggle":
			return { action: "toggle" };
		case "clear":
			return { action: "clear" };
		case "remove":
			return { action: "remove", hud_id: tokens[1] };
		default:
			return null;
	}
}

export function hudExtension(pi: ExtensionAPI) {
	const state = createDefaultState();

	const refresh = (ctx: ExtensionContext) => {
		renderHud(ctx, state);
	};

	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setStatus("mu-hud", undefined);
		ctx.ui.setWidget("mu-hud", undefined);
	});

	registerMuSubcommand(pi, {
		subcommand: "hud",
		summary: "HUD status and rendering controls",
		usage: "/mu hud status|snapshot|on|off|toggle|clear|remove <hud-id>",
		handler: async (args, ctx) => {
			const parsed = parseCommandAction(args);
			if (!parsed) {
				ctx.ui.notify(usageText(), "error");
				return;
			}
			const result = applyHudAction(parsed, state);
			refresh(ctx);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	pi.registerTool({
		name: "mu_hud",
		label: "mu HUD",
		description: "Control or inspect HUD docs rendered in the TUI and shared across channel renderers.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["status", "snapshot", "on", "off", "toggle", "set", "update", "replace", "remove", "clear"],
				},
				doc: { type: "object", additionalProperties: true },
				docs: { type: "array", items: { type: "object", additionalProperties: true } },
				hud_id: { type: "string" },
				snapshot_format: { type: "string", enum: ["compact", "multiline"] },
			},
			required: ["action"],
			additionalProperties: false,
		} as unknown as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
		execute: async (_toolCallId, paramsRaw, _signal, _onUpdate, ctx) => {
			const params = paramsRaw as HudToolParams;
			const result = applyHudAction(params, state);
			refresh(ctx);
			return hudToolResult({
				state,
				ok: result.ok,
				action: result.action,
				message: result.message,
				extra: result.extra,
			});
		},
	});
}

export default hudExtension;
