import {
	normalizeUiDocs,
	parseUiDoc,
	resolveUiStatusProfileName,
	type UiAction,
	type UiComponent,
	type UiDoc,
	uiStatusProfileWarnings,
} from "@femtomc/mu-core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

const UI_DISPLAY_DOCS_MAX = 16;
const UI_PICKER_COMPONENTS_MAX = 8;
const UI_PICKER_LIST_ITEMS_MAX = 4;
const UI_PICKER_KEYVALUE_ROWS_MAX = 4;
const UI_SESSION_KEY_FALLBACK = "__mu_ui_active_session__";
const UI_PROMPT_PREVIEW_MAX = 160;
const UI_INTERACT_SHORTCUT = "ctrl+shift+u";
const UI_PICKER_PANEL_MIN_WIDTH = 56;
const UI_PICKER_PANEL_MAX_WIDTH = 118;
const UI_PICKER_PANEL_WIDTH_RATIO = 0.9;
const UI_PICKER_PANEL_TOP_MARGIN = 1;
const UI_PICKER_PANEL_BOTTOM_MARGIN = 1;
const UI_PICKER_PANEL_INNER_PADDING_X = 2;
const UI_PICKER_PANEL_INNER_PADDING_Y = 1;
const UI_PICKER_TWO_PANE_MIN_WIDTH = 92;
const UI_PICKER_TWO_PANE_LEFT_MIN = 24;
const UI_PICKER_TWO_PANE_RIGHT_MIN = 32;
const UI_PICKER_TWO_PANE_SEPARATOR_WIDTH = 3;
const UI_PICKER_INTERACTION_HINT =
	"↑/↓ move · tab switch pane · enter select/submit · esc cancel · click rows";
const UI_ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
const UI_DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";
const UI_INTERACT_OVERLAY_OPTIONS = {
	anchor: "top-left",
	row: 0,
	col: 0,
	width: "100%",
	maxHeight: "100%",
	margin: 0,
} as const;

type UiToolAction = "status" | "snapshot" | "set" | "update" | "replace" | "remove" | "clear";

type UiToolParams = {
	action: UiToolAction;
	doc?: unknown;
	docs?: unknown;
	ui_id?: string;
	snapshot_format?: "compact" | "multiline";
};

type UiAutoPromptRequest = {
	kind: "action" | "review";
	uiId: string;
	actionId?: string;
};

type UiState = {
	docsById: Map<string, UiDoc>;
	pendingPrompts: UiAutoPromptRequest[];
	promptedRevisionKeys: Set<string>;
	awaitingUiIds: Set<string>;
	interactionDepth: number;
};

type SessionStateEntry = {
	state: UiState;
	lastAccessMs: number;
};

const STATE_BY_SESSION = new Map<string, SessionStateEntry>();
const UI_STATE_TTL_MS = 30 * 60 * 1000; // keep session state for 30 minutes after last access

function createState(): UiState {
	return {
		docsById: new Map(),
		pendingPrompts: [],
		promptedRevisionKeys: new Set(),
		awaitingUiIds: new Set(),
		interactionDepth: 0,
	};
}

function pruneStaleStates(nowMs: number): void {
	for (const [key, entry] of STATE_BY_SESSION.entries()) {
		if (nowMs - entry.lastAccessMs > UI_STATE_TTL_MS) {
			STATE_BY_SESSION.delete(key);
		}
	}
}

function sessionKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
	const manager = ctx.sessionManager;
	if (!manager) {
		return UI_SESSION_KEY_FALLBACK;
	}
	const sessionId = manager.getSessionId();
	return sessionId ?? UI_SESSION_KEY_FALLBACK;
}

function ensureState(key: string): UiState {
	const nowMs = Date.now();
	pruneStaleStates(nowMs);
	const existing = STATE_BY_SESSION.get(key);
	if (existing) {
		existing.lastAccessMs = nowMs;
		return existing.state;
	}
	const fresh = createState();
	STATE_BY_SESSION.set(key, { state: fresh, lastAccessMs: nowMs });
	return fresh;
}

function touchState(key: string): void {
	const entry = STATE_BY_SESSION.get(key);
	if (entry) {
		entry.lastAccessMs = Date.now();
	}
}

function activeDocs(state: UiState, maxDocs = UI_DISPLAY_DOCS_MAX): UiDoc[] {
	return normalizeUiDocs([...state.docsById.values()], { maxDocs });
}

function docRevisionKey(doc: UiDoc): string {
	return `${doc.ui_id}:${doc.revision.id}:${doc.revision.version}`;
}

function retainPromptedRevisionKeysForActiveDocs(state: UiState): void {
	const activeRevisionKeys = new Set<string>();
	for (const doc of state.docsById.values()) {
		activeRevisionKeys.add(docRevisionKey(doc));
	}
	for (const key of [...state.promptedRevisionKeys]) {
		if (!activeRevisionKeys.has(key)) {
			state.promptedRevisionKeys.delete(key);
		}
	}
}

function retainAwaitingUiIdsForActiveDocs(state: UiState): void {
	for (const uiId of [...state.awaitingUiIds]) {
		const doc = state.docsById.get(uiId);
		if (!doc || runnableActions(doc).length === 0) {
			state.awaitingUiIds.delete(uiId);
		}
	}
}

function retainPendingPromptsForActiveDocs(state: UiState): void {
	state.pendingPrompts = state.pendingPrompts.filter((pending) => {
		const doc = state.docsById.get(pending.uiId);
		if (!doc) {
			return false;
		}
		if (pending.kind === "review") {
			return isStatusProfileStatusVariant(doc);
		}
		const actions = runnableActions(doc);
		if (actions.length === 0) {
			return false;
		}
		if (!pending.actionId) {
			return true;
		}
		return actions.some((action) => action.id === pending.actionId);
	});
}

function removePendingPromptsForUiId(state: UiState, uiId: string): void {
	state.pendingPrompts = state.pendingPrompts.filter((pending) => pending.uiId !== uiId);
}

function enqueuePendingPrompt(state: UiState, pending: UiAutoPromptRequest): void {
	const duplicate = state.pendingPrompts.some((existing) => {
		return (
			existing.kind === pending.kind &&
			existing.uiId === pending.uiId &&
			existing.actionId === pending.actionId
		);
	});
	if (!duplicate) {
		state.pendingPrompts.push(pending);
	}
}

function armAutoPromptForUiDocs(state: UiState, changedUiIds: readonly string[]): void {
	if (changedUiIds.length === 0) {
		return;
	}
	const changedDocs: UiDoc[] = [];
	for (const uiId of changedUiIds) {
		const doc = state.docsById.get(uiId);
		if (doc) {
			changedDocs.push(doc);
		}
	}
	const unpromptedDocs = changedDocs.filter((doc) => !state.promptedRevisionKeys.has(docRevisionKey(doc)));
	if (unpromptedDocs.length === 0) {
		return;
	}
	const byMostRecentRevision = (left: UiDoc, right: UiDoc): number => {
		if (left.updated_at_ms !== right.updated_at_ms) {
			return right.updated_at_ms - left.updated_at_ms;
		}
		return left.ui_id.localeCompare(right.ui_id);
	};

	const runnableCandidates = unpromptedDocs.filter((doc) => runnableActions(doc).length > 0).sort(byMostRecentRevision);
	if (runnableCandidates.length > 0) {
		const doc = runnableCandidates[0]!;
		const actions = runnableActions(doc);
		const actionId = actions.length === 1 ? actions[0]!.id : undefined;
		enqueuePendingPrompt(state, { kind: "action", uiId: doc.ui_id, actionId });
		state.promptedRevisionKeys.add(docRevisionKey(doc));
	}

	const statusCandidates = unpromptedDocs.filter((doc) => isStatusProfileStatusVariant(doc)).sort(byMostRecentRevision);
	if (statusCandidates.length > 0) {
		const doc = statusCandidates[0]!;
		enqueuePendingPrompt(state, { kind: "review", uiId: doc.ui_id });
		state.promptedRevisionKeys.add(docRevisionKey(doc));
	}
}

function preferredDocForState(state: UiState, candidate: UiDoc): UiDoc {
	const existing = state.docsById.get(candidate.ui_id);
	if (!existing) {
		return candidate;
	}
	const merged = normalizeUiDocs([existing, candidate], { maxDocs: 2 });
	const chosen = merged.find((doc) => doc.ui_id === candidate.ui_id);
	return chosen ?? candidate;
}

function awaitingDocs(state: UiState, docs: readonly UiDoc[]): UiDoc[] {
	return docs.filter((doc) => state.awaitingUiIds.has(doc.ui_id) && runnableActions(doc).length > 0);
}

function beginUiInteraction(ctx: ExtensionContext, state: UiState): void {
	state.interactionDepth += 1;
	refreshUi(ctx);
}

function endUiInteraction(ctx: ExtensionContext, state: UiState): void {
	state.interactionDepth = Math.max(0, state.interactionDepth - 1);
	refreshUi(ctx);
}

async function withUiInteraction<T>(ctx: ExtensionContext, state: UiState, run: () => Promise<T>): Promise<T> {
	beginUiInteraction(ctx, state);
	try {
		return await run();
	} finally {
		endUiInteraction(ctx, state);
	}
}

function short(text: string, max = 64): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) {
		return normalized;
	}
	if (max <= 1) {
		return "…";
	}
	return `${normalized.slice(0, max - 1)}…`;
}

function statusProfileId(doc: UiDoc): string | null {
	return resolveUiStatusProfileName(doc);
}

function statusProfileMetadata(doc: UiDoc): Record<string, unknown> | null {
	const profile = doc.metadata.profile;
	if (!isPlainObject(profile)) {
		return null;
	}
	return profile;
}

function statusProfileVariant(doc: UiDoc): string {
	const profile = statusProfileMetadata(doc);
	const rawVariant = typeof profile?.variant === "string" ? profile.variant.trim().toLowerCase() : "";
	return rawVariant.length > 0 ? rawVariant : "status";
}

function isStatusProfileStatusVariant(doc: UiDoc): boolean {
	return statusProfileId(doc) !== null && statusProfileVariant(doc) === "status";
}

function statusProfileSnapshot(doc: UiDoc, format: "compact" | "multiline"): string | null {
	if (!isStatusProfileStatusVariant(doc)) {
		return null;
	}
	const profile = statusProfileMetadata(doc);
	if (!profile) {
		return null;
	}
	const snapshot = profile.snapshot;
	if (!isPlainObject(snapshot)) {
		return null;
	}
	const raw = snapshot[format];
	if (typeof raw !== "string") {
		return null;
	}
	const normalized = raw.trim();
	return normalized.length > 0 ? normalized : null;
}

function compactSnapshotValue(doc: UiDoc): string {
	const profileCompact = statusProfileSnapshot(doc, "compact");
	if (profileCompact) {
		return short(profileCompact, 96);
	}
	if (doc.summary) {
		return short(doc.summary, 64);
	}
	return `${short(doc.title, 32)} (${doc.revision.version})`;
}

function statusProfileDocCount(docs: readonly UiDoc[]): number {
	return docs.reduce((count, doc) => count + (isStatusProfileStatusVariant(doc) ? 1 : 0), 0);
}

function statusProfileWarningCount(docs: readonly UiDoc[]): number {
	return docs.reduce((count, doc) => count + uiStatusProfileWarnings(doc).length, 0);
}

function statusSummary(docs: UiDoc[], awaitingCount = 0): string {
	const ids = docs.map((doc) => doc.ui_id).join(", ") || "(none)";
	const parts = [`UI docs: ${docs.length}`, `ids: ${ids}`];
	const statusProfiles = statusProfileDocCount(docs);
	if (statusProfiles > 0) {
		parts.push(`status_profiles: ${statusProfiles}`);
	}
	const warningCount = statusProfileWarningCount(docs);
	if (warningCount > 0) {
		parts.push(`profile_warnings: ${warningCount}`);
	}
	if (awaitingCount > 0) {
		parts.push(`awaiting: ${awaitingCount}`);
	}
	return parts.join(" · ");
}

function snapshotText(docs: UiDoc[], format: "compact" | "multiline"): string {
	if (docs.length === 0) {
		return "(no UI docs)";
	}
	if (format === "compact") {
		return docs.map((doc) => `${doc.ui_id}: ${compactSnapshotValue(doc)}`).join(" | ");
	}
	const lines: string[] = [];
	docs.slice(0, 8).forEach((doc, idx) => {
		const profileId = statusProfileId(doc);
		lines.push(`${idx + 1}. ${doc.title} [${doc.ui_id}]${profileId ? ` profile=${profileId}` : ""}`);
		const profileMultiline = statusProfileSnapshot(doc, "multiline");
		if (profileMultiline) {
			const snapshotLines = profileMultiline
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			if (snapshotLines.length > 0) {
				for (const line of snapshotLines) {
					lines.push(`   ${short(line, 120)}`);
				}
			} else {
				lines.push(`   snapshot: ${compactSnapshotValue(doc)}`);
			}
		} else if (isStatusProfileStatusVariant(doc)) {
			lines.push(`   snapshot: ${compactSnapshotValue(doc)}`);
		} else if (doc.summary) {
			lines.push(`   summary: ${short(doc.summary, 120)}`);
		}
		if (isStatusProfileStatusVariant(doc)) {
			if (doc.actions.length > 0) {
				lines.push(`   actions omitted for status profile (${doc.actions.length})`);
			}
			return;
		}
		if (doc.actions.length > 0) {
			const labels = [...doc.actions]
				.sort((left, right) => left.id.localeCompare(right.id))
				.map((action) => action.label)
				.join(", ");
			lines.push(`   actions: ${labels}`);
		}
	});
	if (docs.length > 8) {
		lines.push(`... (+${docs.length - 8} more docs)`);
	}
	return lines.join("\n");
}

function parseDocInput(value: unknown): { ok: true; doc: UiDoc } | { ok: false; error: string } {
	if (value === undefined) {
		return { ok: false, error: "doc is required" };
	}
	const parsed = parseUiDoc(value);
	if (!parsed) {
		return { ok: false, error: "Invalid UiDoc." };
	}
	return { ok: true, doc: parsed };
}

function parseDocListInput(value: unknown): { ok: true; docs: UiDoc[] } | { ok: false; error: string } {
	if (!Array.isArray(value)) {
		return { ok: false, error: "docs must be an array" };
	}
	const docs: UiDoc[] = [];
	for (let idx = 0; idx < value.length; idx += 1) {
		const parsed = parseUiDoc(value[idx]);
		if (!parsed) {
			return { ok: false, error: `docs[${idx}]: invalid UiDoc` };
		}
		docs.push(parsed);
	}
	return { ok: true, docs: normalizeUiDocs(docs, { maxDocs: UI_DISPLAY_DOCS_MAX }) };
}

function statusProfileWarningsExtraForDoc(doc: UiDoc): Record<string, unknown> {
	const warnings = uiStatusProfileWarnings(doc);
	if (warnings.length === 0) {
		return {};
	}
	return { profile_warnings: warnings };
}

function statusProfileWarningsExtraForDocs(docs: readonly UiDoc[]): Record<string, unknown> {
	const byUiId: Record<string, string[]> = {};
	for (const doc of docs) {
		const warnings = uiStatusProfileWarnings(doc);
		if (warnings.length > 0) {
			byUiId[doc.ui_id] = warnings;
		}
	}
	return Object.keys(byUiId).length > 0 ? { profile_warnings: byUiId } : {};
}

function parseSnapshotFormat(raw?: string): "compact" | "multiline" {
	const normalized = (raw ?? "compact").trim().toLowerCase();
	return normalized === "multiline" ? "multiline" : "compact";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionCommandText(action: UiAction): string | null {
	const raw = typeof action.metadata.command_text === "string" ? action.metadata.command_text.trim() : "";
	return raw.length > 0 ? raw : null;
}

function extractTemplateKeys(text: string): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const key = (match[1] ?? "").trim();
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		keys.push(key);
	}
	return keys;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceTemplateValues(template: string, values: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(values)) {
		const keyRe = new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, "g");
		out = out.replace(keyRe, value);
	}
	return out;
}

function primitiveTemplateDefault(value: unknown): string | null {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "boolean":
			return String(value);
		default:
			return value === null ? "" : null;
	}
}

function valueAtTemplatePath(root: unknown, key: string): unknown {
	if (!key) {
		return undefined;
	}
	const segments = key.split(".").filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return undefined;
	}
	let current: unknown = root;
	for (const segment of segments) {
		if (Array.isArray(current)) {
			const index = Number.parseInt(segment, 10);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				return undefined;
			}
			current = current[index];
			continue;
		}
		if (!isPlainObject(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function templateDefaultsForAction(action: UiAction, keys: readonly string[]): Record<string, string> {
	if (!isPlainObject(action.payload) || keys.length === 0) {
		return {};
	}
	const payload = action.payload;
	const out: Record<string, string> = {};
	for (const key of keys) {
		const fallback = primitiveTemplateDefault(valueAtTemplatePath(payload, key));
		if (fallback !== null) {
			out[key] = fallback;
		}
	}
	return out;
}

async function collectTemplateValues(opts: {
	ctx: ExtensionContext;
	action: UiAction;
	templateKeys: readonly string[];
}): Promise<Record<string, string> | null> {
	if (opts.templateKeys.length === 0) {
		return {};
	}
	const defaults = templateDefaultsForAction(opts.action, opts.templateKeys);
	const out: Record<string, string> = { ...defaults };
	for (const key of opts.templateKeys) {
		const defaultValue = defaults[key];
		if (typeof defaultValue === "string" && defaultValue.trim().length > 0) {
			continue;
		}
		const placeholder = typeof defaultValue === "string" ? defaultValue : `value for ${key}`;
		const entered = await opts.ctx.ui.input(`UI field: ${key}`, placeholder);
		if (entered === undefined) {
			return null;
		}
		out[key] = entered;
	}
	return out;
}

function composePromptFromAction(opts: { commandText: string; templateValues: Record<string, string> }): string {
	const rendered = replaceTemplateValues(opts.commandText, opts.templateValues).trim();
	const unresolvedKeys = extractTemplateKeys(rendered);
	if (unresolvedKeys.length === 0) {
		return rendered;
	}
	const unresolvedLines = unresolvedKeys.map((key) => `- ${key}: (missing)`);
	return [rendered, "", "Missing template values:", ...unresolvedLines].join("\n");
}

function runnableActions(doc: UiDoc): UiAction[] {
	if (isStatusProfileStatusVariant(doc)) {
		return [];
	}
	return doc.actions.filter((action) => actionCommandText(action) !== null);
}

type UiActionSelection = {
	doc: UiDoc;
	action: UiAction;
};

type UiActionPickerEntry = {
	doc: UiDoc;
	actions: UiAction[];
};

type ThemeShape = ExtensionContext["ui"]["theme"];

function boundedIndex(index: number, length: number): number {
	if (length <= 0) {
		return 0;
	}
	if (index < 0) {
		return 0;
	}
	if (index >= length) {
		return length - 1;
	}
	return index;
}

type ParsedMouseEvent = {
	buttonCode: number;
	col: number;
	row: number;
	release: boolean;
};

function parseSgrMouseEvent(data: string): ParsedMouseEvent | null {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) {
		return null;
	}
	const buttonCode = Number.parseInt(match[1] ?? "", 10);
	const col = Number.parseInt(match[2] ?? "", 10);
	const row = Number.parseInt(match[3] ?? "", 10);
	if (!Number.isInteger(buttonCode) || !Number.isInteger(col) || !Number.isInteger(row)) {
		return null;
	}
	return {
		buttonCode,
		col,
		row,
		release: match[4] === "m",
	};
}

function isPrimaryMouseRelease(event: ParsedMouseEvent): boolean {
	if (!event.release) {
		return false;
	}
	if (event.buttonCode >= 64) {
		return false;
	}
	const primaryButton = event.buttonCode & 0b11;
	return primaryButton === 0;
}

type PickerLine = {
	text: string;
	selected?: boolean;
	docIndex?: number;
	actionIndex?: number;
};

type PickerRenderLine = {
	text: string;
	docTarget?: {
		index: number;
		colStart: number;
		colEnd: number;
	};
	actionTarget?: {
		index: number;
		colStart: number;
		colEnd: number;
	};
};

type PickerMouseTarget = {
	kind: "doc" | "action";
	index: number;
	row: number;
	colStart: number;
	colEnd: number;
};

function fitStyledLine(text: string, width: number): string {
	const trimmed = truncateToWidth(text, width, "…", true);
	const missing = width - visibleWidth(trimmed);
	if (missing <= 0) {
		return trimmed;
	}
	return `${trimmed}${" ".repeat(missing)}`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function pickerComponentLines(component: UiComponent): string[] {
	switch (component.kind) {
		case "text":
			return [component.text];
		case "list": {
			const title = component.title?.trim();
			const prefix = title && title.length > 0 ? `${title} · ` : "";
			const lines = [`${prefix}${component.items.length} item(s)`];
			const visible = component.items.slice(0, UI_PICKER_LIST_ITEMS_MAX);
			for (const item of visible) {
				const detail = item.detail ? ` — ${item.detail}` : "";
				lines.push(`• ${item.label}${detail}`);
			}
			if (component.items.length > visible.length) {
				lines.push(`... (+${component.items.length - visible.length} more items)`);
			}
			return lines;
		}
		case "key_value": {
			const title = component.title?.trim();
			const prefix = title && title.length > 0 ? `${title} · ` : "";
			const lines = [`${prefix}${component.rows.length} row(s)`];
			const visible = component.rows.slice(0, UI_PICKER_KEYVALUE_ROWS_MAX);
			for (const row of visible) {
				lines.push(`${row.key}: ${row.value}`);
			}
			if (component.rows.length > visible.length) {
				lines.push(`... (+${component.rows.length - visible.length} more rows)`);
			}
			return lines;
		}
		case "divider":
			return ["—"];
		default:
			return ["component"];
	}
}

class UiActionPickerComponent implements Component {
	readonly #tui: TUI;
	readonly #entries: UiActionPickerEntry[];
	readonly #theme: ThemeShape;
	readonly #done: (result: UiActionSelection | null) => void;
	#mode: "doc" | "action" = "doc";
	#docIndex = 0;
	#actionIndex = 0;
	#mouseEnabled = false;
	#panelRowStart = 1;
	#panelRowEnd = 1;
	#panelColStart = 1;
	#panelColEnd = 1;
	#mouseTargets: PickerMouseTarget[] = [];

	constructor(opts: {
		tui: TUI;
		entries: UiActionPickerEntry[];
		theme: ThemeShape;
		done: (result: UiActionSelection | null) => void;
		initialUiId?: string;
		initialActionId?: string;
	}) {
		this.#tui = opts.tui;
		this.#entries = opts.entries;
		this.#theme = opts.theme;
		this.#done = opts.done;
		if (opts.initialUiId && opts.initialUiId.trim().length > 0) {
			const initialDocIndex = this.#entries.findIndex((entry) => entry.doc.ui_id === opts.initialUiId);
			if (initialDocIndex >= 0) {
				this.#docIndex = initialDocIndex;
			}
		}
		const actions = this.#currentActions();
		if (opts.initialActionId && opts.initialActionId.trim().length > 0) {
			const initialActionIndex = actions.findIndex((action) => action.id === opts.initialActionId);
			if (initialActionIndex >= 0) {
				this.#actionIndex = initialActionIndex;
				this.#mode = "action";
			}
		}
		this.#enableMouseTracking();
	}

	#enableMouseTracking(): void {
		if (this.#mouseEnabled) {
			return;
		}
		this.#tui.terminal.write(UI_ENABLE_MOUSE_TRACKING);
		this.#mouseEnabled = true;
	}

	#disableMouseTracking(): void {
		if (!this.#mouseEnabled) {
			return;
		}
		this.#tui.terminal.write(UI_DISABLE_MOUSE_TRACKING);
		this.#mouseEnabled = false;
	}

	#currentEntry(): UiActionPickerEntry {
		return this.#entries[this.#docIndex]!;
	}

	#currentActions(): UiAction[] {
		return this.#currentEntry().actions;
	}

	#currentAction(): UiAction | null {
		const actions = this.#currentActions();
		return actions.length > 0 ? actions[boundedIndex(this.#actionIndex, actions.length)]! : null;
	}

	#moveDoc(delta: number): void {
		this.#docIndex = boundedIndex(this.#docIndex + delta, this.#entries.length);
		this.#actionIndex = boundedIndex(this.#actionIndex, this.#currentActions().length);
	}

	#moveAction(delta: number): void {
		const actions = this.#currentActions();
		if (actions.length === 0) {
			this.#actionIndex = 0;
			return;
		}
		this.#actionIndex = boundedIndex(this.#actionIndex + delta, actions.length);
	}

	#submit(): void {
		const action = this.#currentAction();
		if (!action) {
			this.#done(null);
			return;
		}
		this.#done({
			doc: this.#currentEntry().doc,
			action,
		});
	}

	#kindChip(action: UiAction): string {
		switch (action.kind) {
			case "primary":
				return this.#theme.fg("success", "[primary]");
			case "danger":
				return this.#theme.fg("error", "[danger]");
			case "link":
				return this.#theme.fg("accent", "[link]");
			case "secondary":
			default:
				return this.#theme.fg("muted", "[secondary]");
		}
	}

	#buildDocsLines(): PickerLine[] {
		const lines: PickerLine[] = [];
		lines.push({
			text: this.#theme.fg(
				this.#mode === "doc" ? "accent" : "dim",
				`Documents (${this.#entries.length})`,
			),
		});
		for (let idx = 0; idx < this.#entries.length; idx += 1) {
			const entry = this.#entries[idx]!;
			const active = idx === this.#docIndex;
			const marker = active ? (this.#mode === "doc" ? "▶" : "▸") : " ";
			const actionCount = entry.actions.length;
			const actionLabel =
				actionCount > 0
					? `${actionCount} ${pluralize(actionCount, "action")}`
					: "status";
			const title = this.#theme.fg(active ? "text" : "muted", `${marker} ${entry.doc.title}`);
			const meta = this.#theme.fg("dim", `${entry.doc.ui_id} · ${actionLabel}`);
			lines.push({
				text: `${title} ${meta}`,
				selected: active,
				docIndex: idx,
			});
		}
		return lines;
	}

	#buildDetailLines(): PickerLine[] {
		const lines: PickerLine[] = [];
		const selectedDoc = this.#currentEntry().doc;
		const selectedActions = this.#currentActions();
		lines.push({ text: this.#theme.fg("accent", selectedDoc.title) });
		lines.push({
			text: this.#theme.fg(
				"dim",
				`${selectedDoc.ui_id} · revision ${selectedDoc.revision.version}`,
			),
		});
		if (selectedDoc.summary) {
			lines.push({ text: this.#theme.fg("dim", `Summary: ${selectedDoc.summary}`) });
		}
		lines.push({ text: "" });
		lines.push({
			text: this.#theme.fg(
				"dim",
				`Components (${selectedDoc.components.length})`,
			),
		});
		const visibleComponents = selectedDoc.components.slice(0, UI_PICKER_COMPONENTS_MAX);
		for (const component of visibleComponents) {
			const componentLines = pickerComponentLines(component);
			for (let idx = 0; idx < componentLines.length; idx += 1) {
				const line = componentLines[idx]!;
				const prefix = idx === 0 ? "  " : "    ";
				lines.push({ text: this.#theme.fg("text", `${prefix}${line}`) });
			}
		}
		if (selectedDoc.components.length > visibleComponents.length) {
			lines.push({
				text: this.#theme.fg(
					"muted",
					`  ... (+${selectedDoc.components.length - visibleComponents.length} more components)`,
				),
			});
		}
		lines.push({ text: "" });
		lines.push({
			text: this.#theme.fg(
				this.#mode === "action" ? "accent" : "dim",
				`Actions (${selectedActions.length})`,
			),
		});
		for (let idx = 0; idx < selectedActions.length; idx += 1) {
			const action = selectedActions[idx]!;
			const active = idx === this.#actionIndex;
			const marker = active ? (this.#mode === "action" ? "▶" : "▸") : " ";
			const label = this.#theme.fg(active ? "text" : "muted", `${marker} ${action.label}`);
			const chip = this.#kindChip(action);
			const idLabel = this.#theme.fg("dim", `#${action.id}`);
			lines.push({
				text: `${label} ${chip} ${idLabel}`,
				selected: active,
				actionIndex: idx,
			});
		}
		const action = this.#currentAction();
		if (action?.description) {
			lines.push({ text: "" });
			lines.push({ text: this.#theme.fg("dim", `Ask: ${action.description}`) });
		}
		if (action?.component_id) {
			lines.push({
				text: this.#theme.fg("dim", `Targets component: ${action.component_id}`),
			});
		}
		const commandText = action ? actionCommandText(action) : null;
		if (commandText) {
			lines.push({ text: "" });
			lines.push({ text: this.#theme.fg("dim", `Prompt template: ${commandText}`) });
		}
		return lines;
	}

	#singleColumnLines(): PickerLine[] {
		const lines: PickerLine[] = [];
		const docs = this.#buildDocsLines();
		const detail = this.#buildDetailLines();
		for (const line of docs) {
			lines.push(line);
		}
		lines.push({ text: "" });
		for (const line of detail) {
			lines.push(line);
		}
		return lines;
	}

	#handleMouseEvent(event: ParsedMouseEvent): void {
		if (!isPrimaryMouseRelease(event)) {
			return;
		}
		if (
			event.row < this.#panelRowStart ||
			event.row > this.#panelRowEnd ||
			event.col < this.#panelColStart ||
			event.col > this.#panelColEnd
		) {
			return;
		}
		const target = this.#mouseTargets.find((candidate) => {
			return (
				candidate.row === event.row &&
				event.col >= candidate.colStart &&
				event.col <= candidate.colEnd
			);
		});
		if (!target) {
			return;
		}
		if (target.kind === "doc") {
			this.#docIndex = boundedIndex(target.index, this.#entries.length);
			this.#actionIndex = boundedIndex(this.#actionIndex, this.#currentActions().length);
			this.#mode = "doc";
			return;
		}
		this.#mode = "action";
		this.#actionIndex = boundedIndex(target.index, this.#currentActions().length);
		this.#submit();
	}

	handleInput(data: string): void {
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			this.#handleMouseEvent(mouse);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#done(null);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.#mode = "action";
			this.#actionIndex = boundedIndex(this.#actionIndex, this.#currentActions().length);
			return;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			this.#mode = "doc";
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.#mode === "doc") {
				this.#moveDoc(-1);
			} else {
				this.#moveAction(-1);
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.#mode === "doc") {
				this.#moveDoc(1);
			} else {
				this.#moveAction(1);
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.#mode === "doc") {
				const actions = this.#currentActions();
				if (actions.length <= 1) {
					this.#submit();
				} else {
					this.#mode = "action";
				}
				return;
			}
			this.#submit();
		}
	}

	invalidate(): void {
		// No cached state.
	}

	dispose(): void {
		this.#disableMouseTracking();
	}

	render(width: number): string[] {
		const panelTargetWidth = Math.max(
			UI_PICKER_PANEL_MIN_WIDTH,
			Math.min(UI_PICKER_PANEL_MAX_WIDTH, Math.floor(width * UI_PICKER_PANEL_WIDTH_RATIO)),
		);
		const panelWidth = Math.max(4, Math.min(width, panelTargetWidth));
		const innerWidth = Math.max(1, panelWidth - 2);
		const horizontalPadding = Math.min(
			UI_PICKER_PANEL_INNER_PADDING_X,
			Math.max(0, Math.floor((innerWidth - 1) / 2)),
		);
		const contentWidth = Math.max(1, innerWidth - horizontalPadding * 2);
		const selectedDoc = this.#currentEntry().doc;
		const selectedActions = this.#currentActions();
		const renderLines: PickerRenderLine[] = [];
		const innerPadSegment =
			horizontalPadding > 0 ? this.#theme.bg("customMessageBg", " ".repeat(horizontalPadding)) : "";
		const contentRowText = (line: string, bg: "customMessageBg" | "selectedBg"): string => {
			const core = this.#theme.bg(bg, fitStyledLine(line, contentWidth));
			return `${innerPadSegment}${core}${innerPadSegment}`;
		};
		const pushFullLine = (line: string) => {
			renderLines.push({
				text: contentRowText(line, "customMessageBg"),
			});
		};

		const modeLabel = this.#mode === "action" ? "action focus" : "document focus";
		pushFullLine(
			`${this.#theme.fg("accent", "mu_ui")}${this.#theme.fg("dim", ` · ${this.#entries.length} ${pluralize(this.#entries.length, "doc")} · ${modeLabel}`)}`,
		);
		pushFullLine(this.#theme.fg("dim", short(UI_PICKER_INTERACTION_HINT, Math.max(8, contentWidth))));
		pushFullLine(this.#theme.fg("borderMuted", "─".repeat(contentWidth)));

		const minTwoPaneWidth =
			UI_PICKER_TWO_PANE_LEFT_MIN + UI_PICKER_TWO_PANE_RIGHT_MIN + UI_PICKER_TWO_PANE_SEPARATOR_WIDTH;
		const useTwoPane = contentWidth >= UI_PICKER_TWO_PANE_MIN_WIDTH && contentWidth >= minTwoPaneWidth;
		if (useTwoPane) {
			let leftWidth = Math.max(UI_PICKER_TWO_PANE_LEFT_MIN, Math.floor(contentWidth * 0.34));
			let rightWidth = contentWidth - leftWidth - UI_PICKER_TWO_PANE_SEPARATOR_WIDTH;
			if (rightWidth < UI_PICKER_TWO_PANE_RIGHT_MIN) {
				leftWidth = Math.max(
					UI_PICKER_TWO_PANE_LEFT_MIN,
					contentWidth - UI_PICKER_TWO_PANE_RIGHT_MIN - UI_PICKER_TWO_PANE_SEPARATOR_WIDTH,
				);
				rightWidth = contentWidth - leftWidth - UI_PICKER_TWO_PANE_SEPARATOR_WIDTH;
			}
			const leftLines = this.#buildDocsLines();
			const rightLines = this.#buildDetailLines();
			const rowCount = Math.max(leftLines.length, rightLines.length);
			for (let idx = 0; idx < rowCount; idx += 1) {
				const left = leftLines[idx];
				const right = rightLines[idx];
				const leftCell = this.#theme.bg(
					left?.selected ? "selectedBg" : "customMessageBg",
					fitStyledLine(left?.text ?? "", leftWidth),
				);
				const separator = this.#theme.bg("customMessageBg", this.#theme.fg("borderMuted", " │ "));
				const rightCell = this.#theme.bg(
					right?.selected ? "selectedBg" : "customMessageBg",
					fitStyledLine(right?.text ?? "", rightWidth),
				);
				const row: PickerRenderLine = {
					text: `${innerPadSegment}${leftCell}${separator}${rightCell}${innerPadSegment}`,
				};
				if (left?.docIndex !== undefined) {
					row.docTarget = {
						index: left.docIndex,
						colStart: 1,
						colEnd: leftWidth,
					};
				}
				if (right?.actionIndex !== undefined) {
					row.actionTarget = {
						index: right.actionIndex,
						colStart: leftWidth + UI_PICKER_TWO_PANE_SEPARATOR_WIDTH + 1,
						colEnd: leftWidth + UI_PICKER_TWO_PANE_SEPARATOR_WIDTH + rightWidth,
					};
				}
				renderLines.push(row);
			}
		} else {
			const singleColumn = this.#singleColumnLines();
			for (const line of singleColumn) {
				const row: PickerRenderLine = {
					text: contentRowText(line.text, line.selected ? "selectedBg" : "customMessageBg"),
				};
				if (line.docIndex !== undefined) {
					row.docTarget = {
						index: line.docIndex,
						colStart: 1,
						colEnd: contentWidth,
					};
				}
				if (line.actionIndex !== undefined) {
					row.actionTarget = {
						index: line.actionIndex,
						colStart: 1,
						colEnd: contentWidth,
					};
				}
				renderLines.push(row);
			}
		}

		pushFullLine(this.#theme.fg("borderMuted", "─".repeat(contentWidth)));
		pushFullLine(
			this.#theme.fg(
				"dim",
				short(
					`selected ${selectedDoc.ui_id} · revision ${selectedDoc.revision.version} · ${selectedActions.length} ${pluralize(selectedActions.length, "action")}`,
					Math.max(8, contentWidth),
				),
			),
		);

		const topMarginRows = Math.max(0, UI_PICKER_PANEL_TOP_MARGIN);
		const bottomMarginRows = Math.max(0, UI_PICKER_PANEL_BOTTOM_MARGIN);
		const verticalPadding = Math.max(0, UI_PICKER_PANEL_INNER_PADDING_Y);
		const leftPadWidth = Math.max(0, Math.floor((width - panelWidth) / 2));
		const leftPad = " ".repeat(leftPadWidth);
		const panelColStart = leftPadWidth + 1;
		const frame: string[] = [];
		for (let row = 0; row < topMarginRows; row += 1) {
			frame.push("");
		}

		const title = " mu_ui ";
		const titleWidth = Math.min(innerWidth, visibleWidth(title));
		const leftRule = "─".repeat(Math.max(0, Math.floor((innerWidth - titleWidth) / 2)));
		const rightRule = "─".repeat(Math.max(0, innerWidth - titleWidth - leftRule.length));
		frame.push(
			`${leftPad}${this.#theme.fg("borderAccent", `╭${leftRule}`)}${this.#theme.fg("accent", title)}${this.#theme.fg("borderAccent", `${rightRule}╮`)}`,
		);

		this.#mouseTargets = [];
		const blankInnerRow = `${leftPad}${this.#theme.fg("border", "│")}${this.#theme.bg("customMessageBg", " ".repeat(innerWidth))}${this.#theme.fg("border", "│")}`;
		for (let row = 0; row < verticalPadding; row += 1) {
			frame.push(blankInnerRow);
		}

		const contentStartRow = frame.length + 1;
		for (let idx = 0; idx < renderLines.length; idx += 1) {
			const line = renderLines[idx]!;
			frame.push(`${leftPad}${this.#theme.fg("border", "│")}${line.text}${this.#theme.fg("border", "│")}`);
			const row = contentStartRow + idx;
			if (line.docTarget) {
				this.#mouseTargets.push({
					kind: "doc",
					index: line.docTarget.index,
					row,
					colStart: panelColStart + horizontalPadding + line.docTarget.colStart,
					colEnd: panelColStart + horizontalPadding + line.docTarget.colEnd,
				});
			}
			if (line.actionTarget) {
				this.#mouseTargets.push({
					kind: "action",
					index: line.actionTarget.index,
					row,
					colStart: panelColStart + horizontalPadding + line.actionTarget.colStart,
					colEnd: panelColStart + horizontalPadding + line.actionTarget.colEnd,
				});
			}
		}
		for (let row = 0; row < verticalPadding; row += 1) {
			frame.push(blankInnerRow);
		}

		frame.push(`${leftPad}${this.#theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`)}`);
		for (let row = 0; row < bottomMarginRows; row += 1) {
			frame.push("");
		}

		this.#panelRowStart = topMarginRows + 1;
		const panelRows = 1 + verticalPadding + renderLines.length + verticalPadding + 1;
		this.#panelRowEnd = this.#panelRowStart + panelRows - 1;
		this.#panelColStart = panelColStart;
		this.#panelColEnd = leftPadWidth + panelWidth;

		return frame;
	}
}

async function pickUiActionInteractively(opts: {
	ctx: ExtensionContext;
	entries: UiActionPickerEntry[];
	uiId?: string;
	actionId?: string;
}): Promise<UiActionSelection | null> {
	const selected = await opts.ctx.ui.custom<UiActionSelection | null>(
		(tui, theme, _keybindings, done) =>
			new UiActionPickerComponent({
				tui,
				entries: opts.entries,
				theme: theme as ThemeShape,
				done,
				initialUiId: opts.uiId,
				initialActionId: opts.actionId,
			}),
		{
			overlay: true,
			overlayOptions: UI_INTERACT_OVERLAY_OPTIONS,
		},
	);
	return selected ?? null;
}

function applyUiAction(
	params: UiToolParams,
	state: UiState,
): {
	ok: boolean;
	action: UiToolAction;
	message: string;
	extra?: Record<string, unknown>;
	changedUiIds?: string[];
} {
	retainPromptedRevisionKeysForActiveDocs(state);
	retainAwaitingUiIdsForActiveDocs(state);
	retainPendingPromptsForActiveDocs(state);
	const docs = activeDocs(state);
	const awaitingCount = awaitingDocs(state, docs).length;
	switch (params.action) {
		case "status":
			return {
				ok: true,
				action: "status",
				message: statusSummary(docs, awaitingCount),
				extra: {
					status_profile_count: statusProfileDocCount(docs),
					...statusProfileWarningsExtraForDocs(docs),
				},
			};
		case "snapshot": {
			const format = parseSnapshotFormat(params.snapshot_format);
			return {
				ok: true,
				action: "snapshot",
				message: snapshotText(docs, format),
				extra: {
					snapshot_format: format,
					status_profile_count: statusProfileDocCount(docs),
					...statusProfileWarningsExtraForDocs(docs),
				},
			};
		}
		case "set":
		case "update": {
			const parsed = parseDocInput(params.doc);
			if (!parsed.ok) {
				return { ok: false, action: params.action, message: parsed.error };
			}
			const preferred = preferredDocForState(state, parsed.doc);
			state.docsById.set(parsed.doc.ui_id, preferred);
			if (runnableActions(preferred).length > 0) {
				state.awaitingUiIds.add(parsed.doc.ui_id);
			} else {
				state.awaitingUiIds.delete(parsed.doc.ui_id);
			}
			retainPromptedRevisionKeysForActiveDocs(state);
			retainAwaitingUiIdsForActiveDocs(state);
			retainPendingPromptsForActiveDocs(state);
			return {
				ok: true,
				action: params.action,
				message: `UI doc set: ${parsed.doc.ui_id}`,
				extra: { ui_id: parsed.doc.ui_id, ...statusProfileWarningsExtraForDoc(preferred) },
				changedUiIds: [parsed.doc.ui_id],
			};
		}
		case "replace": {
			const parsed = parseDocListInput(params.docs);
			if (!parsed.ok) {
				return { ok: false, action: "replace", message: parsed.error };
			}
			state.docsById.clear();
			state.awaitingUiIds.clear();
			for (const doc of parsed.docs) {
				state.docsById.set(doc.ui_id, doc);
				if (runnableActions(doc).length > 0) {
					state.awaitingUiIds.add(doc.ui_id);
				}
			}
			retainPromptedRevisionKeysForActiveDocs(state);
			retainAwaitingUiIdsForActiveDocs(state);
			retainPendingPromptsForActiveDocs(state);
			return {
				ok: true,
				action: "replace",
				message: `UI docs replaced (${parsed.docs.length}).`,
				extra: {
					doc_count: parsed.docs.length,
					...statusProfileWarningsExtraForDocs(parsed.docs),
				},
				changedUiIds: parsed.docs.map((doc) => doc.ui_id),
			};
		}
		case "remove": {
			const uiId = (params.ui_id ?? "").trim();
			if (!uiId) {
				return { ok: false, action: "remove", message: "Missing ui_id." };
			}
			if (!state.docsById.delete(uiId)) {
				return { ok: false, action: "remove", message: `UI doc not found: ${uiId}` };
			}
			removePendingPromptsForUiId(state, uiId);
			state.awaitingUiIds.delete(uiId);
			retainPromptedRevisionKeysForActiveDocs(state);
			retainAwaitingUiIdsForActiveDocs(state);
			retainPendingPromptsForActiveDocs(state);
			return { ok: true, action: "remove", message: `UI doc removed: ${uiId}` };
		}
		case "clear":
			state.docsById.clear();
			state.pendingPrompts = [];
			state.promptedRevisionKeys.clear();
			state.awaitingUiIds.clear();
			return { ok: true, action: "clear", message: "UI docs cleared." };
	}
}

function buildToolResult(opts: {
	state: UiState;
	ok: boolean;
	action: UiToolAction;
	message: string;
	extra?: Record<string, unknown>;
}): AgentToolResult<unknown> {
	const docs = activeDocs(opts.state);
	const result: AgentToolResult<unknown> & { ui_docs: UiDoc[] } = {
		content: [{ type: "text", text: opts.message }],
		ui_docs: docs,
		details: {
			ok: opts.ok,
			action: opts.action,
			doc_count: docs.length,
			ui_ids: docs.map((doc) => doc.ui_id),
			...(opts.extra ?? {}),
		},
	};
	return result;
}

function refreshUi(ctx: ExtensionContext): void {
	const key = sessionKey(ctx);
	const state = ensureState(key);
	if (!ctx.hasUI) {
		return;
	}
	retainAwaitingUiIdsForActiveDocs(state);
	const docs = activeDocs(state);
	if (docs.length === 0) {
		ctx.ui.setStatus("mu-ui", undefined);
		ctx.ui.setWidget("mu-ui", undefined);
		return;
	}
	const awaiting = awaitingDocs(state, docs);
	const labels = docs.map((doc) => doc.ui_id).join(", ");
	const readiness =
		state.interactionDepth > 0
			? ctx.ui.theme.fg("accent", "prompting")
			: awaiting.length > 0
				? ctx.ui.theme.fg("accent", `awaiting ${awaiting.length}`)
				: ctx.ui.theme.fg("dim", "ready");
	ctx.ui.setStatus(
		"mu-ui",
		[
			ctx.ui.theme.fg("dim", "ui"),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("accent", `${docs.length}`),
			ctx.ui.theme.fg("muted", "·"),
			readiness,
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("text", labels),
		].join(" "),
	);
	ctx.ui.setWidget("mu-ui", undefined);
}

export function uiExtension(pi: ExtensionAPI) {
	const commandUsage = "/mu ui status|snapshot [compact|multiline]|interact [ui_id [action_id]]";
	const usage = `Usage: ${commandUsage}`;

	const runUiActionFromDoc = async (ctx: ExtensionContext, state: UiState, uiId?: string, actionId?: string) =>
		withUiInteraction(ctx, state, async () => {
			const docs = activeDocs(state, UI_DISPLAY_DOCS_MAX);
			if (docs.length === 0) {
				ctx.ui.notify("No UI docs are currently available.", "info");
				return;
			}

			const entries = docs.map((doc) => ({ doc, actions: runnableActions(doc) }));
			const runnableEntries = entries.filter((entry) => entry.actions.length > 0);

			let selectedDoc: UiDoc | null = null;
			let selectedAction: UiAction | null = null;
			const normalizedUiId = uiId?.trim() ?? "";
			const normalizedActionId = actionId?.trim() ?? "";
			if (normalizedUiId.length > 0 && normalizedActionId.length > 0) {
				const entry = entries.find((candidate) => candidate.doc.ui_id === normalizedUiId) ?? null;
				if (!entry) {
					ctx.ui.notify(`UI doc not found: ${normalizedUiId}`, "error");
					return;
				}
				const action = entry.actions.find((candidate) => candidate.id === normalizedActionId) ?? null;
				if (!action) {
					ctx.ui.notify(`Action not found: ${normalizedActionId} in ${normalizedUiId}`, "error");
					return;
				}
				selectedDoc = entry.doc;
				selectedAction = action;
			} else {
				const picked = await pickUiActionInteractively({
					ctx,
					entries,
					uiId: normalizedUiId.length > 0 ? normalizedUiId : undefined,
					actionId: normalizedActionId.length > 0 ? normalizedActionId : undefined,
				});
				if (!picked) {
					if (runnableEntries.length > 0) {
						ctx.ui.notify("UI interaction cancelled.", "info");
					}
					return;
				}
				selectedDoc = picked.doc;
				selectedAction = picked.action;
			}

			if (!selectedDoc || !selectedAction) {
				if (runnableEntries.length === 0) {
					return;
				}
				ctx.ui.notify("No UI action was selected.", "info");
				return;
			}

			const commandText = actionCommandText(selectedAction);
			if (!commandText) {
				ctx.ui.notify(`Action ${selectedAction.id} is missing metadata.command_text.`, "error");
				return;
			}

			const templateKeys = extractTemplateKeys(commandText);
			const templateValues = await collectTemplateValues({
				ctx,
				action: selectedAction,
				templateKeys,
			});
			if (!templateValues) {
				ctx.ui.notify("UI interaction cancelled.", "info");
				return;
			}

			const composed = composePromptFromAction({
				commandText,
				templateValues,
			});
			const edited = await ctx.ui.editor(`Review prompt (${selectedDoc.ui_id}/${selectedAction.id})`, composed);
			if (edited === undefined) {
				ctx.ui.notify("UI submit cancelled.", "info");
				return;
			}
			const finalPrompt = edited.trim();
			if (finalPrompt.length === 0) {
				ctx.ui.notify("Cannot submit an empty prompt.", "error");
				return;
			}

			const confirmed = await ctx.ui.confirm("Submit UI prompt", short(finalPrompt, UI_PROMPT_PREVIEW_MAX));
			if (!confirmed) {
				ctx.ui.notify("UI submit cancelled.", "info");
				return;
			}

			pi.sendUserMessage(finalPrompt);
			state.awaitingUiIds.delete(selectedDoc.ui_id);
			removePendingPromptsForUiId(state, selectedDoc.ui_id);
			retainAwaitingUiIdsForActiveDocs(state);
			retainPendingPromptsForActiveDocs(state);
			ctx.ui.notify(`Submitted prompt from ${selectedDoc.ui_id}/${selectedAction.id}.`, "info");
		});

	registerMuSubcommand(pi, {
		subcommand: "ui",
		summary: "Inspect and manage interactive UI docs",
		usage: commandUsage,
		handler: async (args, ctx) => {
			const tokens = args
				.trim()
				.split(/\s+/)
				.filter((token) => token.length > 0);
			const subcommand = tokens[0] ?? "status";
			const key = sessionKey(ctx);
			const state = ensureState(key);
			if (subcommand === "status" || subcommand === "snapshot") {
				const snapshotFormat = subcommand === "snapshot" ? tokens[1] : undefined;
				const actionParams: UiToolParams = {
					action: subcommand as UiToolAction,
					snapshot_format: snapshotFormat as "compact" | "multiline" | undefined,
				};
				const result = applyUiAction(actionParams, state);
				refreshUi(ctx);
				ctx.ui.notify(result.message, result.ok ? "info" : "error");
				return;
			}
			if (subcommand === "interact") {
				if (tokens.length > 3) {
					ctx.ui.notify(usage, "info");
					return;
				}
				const uiId = tokens[1];
				const actionId = tokens[2];
				await runUiActionFromDoc(ctx, state, uiId, actionId);
				refreshUi(ctx);
				return;
			}
			ctx.ui.notify(usage, "info");
		},
	});

	pi.registerShortcut(UI_INTERACT_SHORTCUT, {
		description: "Open programmable UI modal and optionally submit prompt",
		handler: async (ctx) => {
			const key = sessionKey(ctx);
			const state = ensureState(key);
			await runUiActionFromDoc(ctx, state);
			refreshUi(ctx);
		},
	});

	pi.registerTool({
		name: "mu_ui",
		label: "mu UI",
		description: "Publish, inspect, and manage interactive UI documents.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ["status", "snapshot", "set", "update", "replace", "remove", "clear"],
				},
				doc: { type: "object", additionalProperties: true },
				docs: { type: "array", items: { type: "object", additionalProperties: true } },
				ui_id: { type: "string" },
				snapshot_format: { type: "string", enum: ["compact", "multiline"] },
			},
			required: ["action"],
		} as unknown as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
		execute: async (_toolCallId, paramsRaw, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> => {
			const key = sessionKey(ctx);
			const state = ensureState(key);
			const params = paramsRaw as UiToolParams;
			const result = applyUiAction(params, state);
			if (ctx.hasUI && result.ok && result.changedUiIds && result.changedUiIds.length > 0) {
				armAutoPromptForUiDocs(state, result.changedUiIds);
			}
			refreshUi(ctx);
			return buildToolResult({ state, ...result });
		},
	});

	pi.on("session_start", (_event, ctx) => {
		refreshUi(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		refreshUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}
		const key = sessionKey(ctx);
		const state = ensureState(key);
		retainPendingPromptsForActiveDocs(state);
		const pending = state.pendingPrompts.shift();
		if (!pending) {
			return;
		}
		if (pending.kind === "action") {
			ctx.ui.notify(
				`Agent requested input via ${pending.uiId}. Submit now or press ${UI_INTERACT_SHORTCUT} later.`,
				"info",
			);
		}
		await runUiActionFromDoc(ctx, state, pending.uiId, pending.actionId);
		refreshUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const key = sessionKey(ctx);
		touchState(key);
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setStatus("mu-ui", undefined);
		ctx.ui.setWidget("mu-ui", undefined);
	});
}

export default uiExtension;
