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
import { type Component, matchesKey } from "@mariozechner/pi-tui";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

const UI_DISPLAY_DOCS_MAX = 16;
const UI_WIDGET_COMPONENTS_MAX = 6;
const UI_WIDGET_ACTIONS_MAX = 4;
const UI_PICKER_COMPONENTS_MAX = 8;
const UI_PICKER_LIST_ITEMS_MAX = 4;
const UI_PICKER_KEYVALUE_ROWS_MAX = 4;
const UI_SESSION_KEY_FALLBACK = "__mu_ui_active_session__";
const UI_PROMPT_PREVIEW_MAX = 160;
const UI_INTERACT_SHORTCUT = "ctrl+shift+u";

type UiToolAction = "status" | "snapshot" | "set" | "update" | "replace" | "remove" | "clear";

type UiToolParams = {
	action: UiToolAction;
	doc?: unknown;
	docs?: unknown;
	ui_id?: string;
	snapshot_format?: "compact" | "multiline";
};

type UiAutoPromptRequest = {
	uiId: string;
	actionId?: string;
};

type UiState = {
	docsById: Map<string, UiDoc>;
	pendingPrompt: UiAutoPromptRequest | null;
	promptedRevisionKeys: Set<string>;
	awaitingUiIds: Set<string>;
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
		pendingPrompt: null,
		promptedRevisionKeys: new Set(),
		awaitingUiIds: new Set(),
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
	const candidates = changedDocs.filter((doc) => {
		if (runnableActions(doc).length === 0) {
			return false;
		}
		return !state.promptedRevisionKeys.has(docRevisionKey(doc));
	});
	if (candidates.length === 0) {
		return;
	}
	candidates.sort((left, right) => {
		if (left.updated_at_ms !== right.updated_at_ms) {
			return right.updated_at_ms - left.updated_at_ms;
		}
		return left.ui_id.localeCompare(right.ui_id);
	});
	const doc = candidates[0]!;
	const actions = runnableActions(doc);
	const actionId = actions.length === 1 ? actions[0]!.id : undefined;
	state.pendingPrompt = { uiId: doc.ui_id, actionId };
	state.promptedRevisionKeys.add(docRevisionKey(doc));
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

function pickerComponentLines(component: UiComponent): string[] {
	switch (component.kind) {
		case "text":
			return [`text · ${component.text}`];
		case "list": {
			const lines = [`list${component.title ? ` · ${component.title}` : ""}`];
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
			const lines = [`key_value${component.title ? ` · ${component.title}` : ""}`];
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
			return ["divider"];
		default:
			return ["component"];
	}
}

class UiActionPickerComponent implements Component {
	readonly #entries: UiActionPickerEntry[];
	readonly #theme: ThemeShape;
	readonly #done: (result: UiActionSelection | null) => void;
	#mode: "doc" | "action" = "doc";
	#docIndex = 0;
	#actionIndex = 0;

	constructor(opts: {
		entries: UiActionPickerEntry[];
		theme: ThemeShape;
		done: (result: UiActionSelection | null) => void;
		initialUiId?: string;
		initialActionId?: string;
	}) {
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

	handleInput(data: string): void {
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

	render(width: number): string[] {
		const maxWidth = Math.max(24, width - 2);
		const lines: string[] = [];
		lines.push(this.#theme.fg("accent", short("Programmable UI", maxWidth)));
		lines.push(this.#theme.fg("dim", short("↑/↓ move · tab switch · enter select/submit · esc cancel", maxWidth)));
		lines.push("");

		lines.push(
			this.#theme.fg(
				this.#mode === "doc" ? "accent" : "dim",
				short(`Documents (${this.#entries.length})`, maxWidth),
			),
		);
		for (let idx = 0; idx < this.#entries.length; idx += 1) {
			const entry = this.#entries[idx]!;
			const active = idx === this.#docIndex;
			const marker = active ? (this.#mode === "doc" ? "▶" : "▸") : " ";
			const label = `${marker} ${entry.doc.ui_id} · ${entry.doc.title}`;
			lines.push(this.#theme.fg(active ? "accent" : "muted", short(label, maxWidth)));
		}

		const selectedDoc = this.#currentEntry().doc;
		if (selectedDoc.summary) {
			lines.push("");
			lines.push(this.#theme.fg("dim", short(`Summary: ${selectedDoc.summary}`, maxWidth)));
		}

		lines.push("");
		lines.push(this.#theme.fg("dim", short(`Components (${selectedDoc.components.length})`, maxWidth)));
		const visibleComponents = selectedDoc.components.slice(0, UI_PICKER_COMPONENTS_MAX);
		for (const component of visibleComponents) {
			const componentLines = pickerComponentLines(component);
			for (let idx = 0; idx < componentLines.length; idx += 1) {
				const line = componentLines[idx]!;
				const prefix = idx === 0 ? "  " : "    ";
				lines.push(this.#theme.fg("text", short(`${prefix}${line}`, maxWidth)));
			}
		}
		if (selectedDoc.components.length > visibleComponents.length) {
			lines.push(
				this.#theme.fg(
					"muted",
					short(`  ... (+${selectedDoc.components.length - visibleComponents.length} more components)`, maxWidth),
				),
			);
		}

		const actions = this.#currentActions();
		lines.push("");
		lines.push(
			this.#theme.fg(this.#mode === "action" ? "accent" : "dim", short(`Actions (${actions.length})`, maxWidth)),
		);
		for (let idx = 0; idx < actions.length; idx += 1) {
			const action = actions[idx]!;
			const active = idx === this.#actionIndex;
			const marker = active ? (this.#mode === "action" ? "▶" : "▸") : " ";
			const label = `${marker} ${action.id} · ${action.label}`;
			lines.push(this.#theme.fg(active ? "accent" : "text", short(label, maxWidth)));
		}

		const action = this.#currentAction();
		if (action?.description) {
			lines.push("");
			lines.push(this.#theme.fg("dim", short(`Ask: ${action.description}`, maxWidth)));
		}
		if (action?.component_id) {
			lines.push(this.#theme.fg("dim", short(`Targets component: ${action.component_id}`, maxWidth)));
		}
		const commandText = action ? actionCommandText(action) : null;
		if (commandText) {
			lines.push("");
			lines.push(this.#theme.fg("dim", short(`Prompt template: ${commandText}`, maxWidth)));
		}
		return lines;
	}
}

async function pickUiActionInteractively(opts: {
	ctx: ExtensionContext;
	entries: UiActionPickerEntry[];
	uiId?: string;
	actionId?: string;
}): Promise<UiActionSelection | null> {
	const selected = await opts.ctx.ui.custom<UiActionSelection | null>(
		(_tui, theme, _keybindings, done) =>
			new UiActionPickerComponent({
				entries: opts.entries,
				theme: theme as ThemeShape,
				done,
				initialUiId: opts.uiId,
				initialActionId: opts.actionId,
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "78%",
				maxHeight: "70%",
				margin: 1,
			},
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
			if (state.pendingPrompt?.uiId === uiId) {
				state.pendingPrompt = null;
			}
			state.awaitingUiIds.delete(uiId);
			retainPromptedRevisionKeysForActiveDocs(state);
			retainAwaitingUiIdsForActiveDocs(state);
			return { ok: true, action: "remove", message: `UI doc removed: ${uiId}` };
		}
		case "clear":
			state.docsById.clear();
			state.pendingPrompt = null;
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

function renderDocPreview(
	theme: ExtensionContext["ui"]["theme"],
	doc: UiDoc,
	opts: { awaitingResponse: boolean; awaitingCount: number },
): string[] {
	const lines: string[] = [];
	const headerParts = [theme.fg("accent", doc.title), theme.fg("muted", `[${doc.ui_id}]`)];
	if (opts.awaitingResponse) {
		headerParts.push(theme.fg("accent", "awaiting-response"));
	}
	lines.push(headerParts.join(" "));
	if (doc.summary) {
		lines.push(theme.fg("muted", short(doc.summary, 80)));
	}
	if (opts.awaitingCount > 0) {
		lines.push(theme.fg("accent", `Awaiting user response for ${opts.awaitingCount} UI doc(s).`));
	}
	const components = doc.components.slice(0, UI_WIDGET_COMPONENTS_MAX);
	if (components.length > 0) {
		lines.push(theme.fg("dim", "Components:"));
		for (const component of components) {
			lines.push(`  ${componentPreview(component)}`);
		}
	}
	const interactiveActions = runnableActions(doc);
	if (interactiveActions.length > 0) {
		lines.push(theme.fg("muted", "Actions:"));
		const visibleActions = interactiveActions.slice(0, UI_WIDGET_ACTIONS_MAX);
		for (let idx = 0; idx < visibleActions.length; idx += 1) {
			const action = visibleActions[idx]!;
			lines.push(`  ${idx + 1}. ${action.label}`);
		}
		if (interactiveActions.length > visibleActions.length) {
			lines.push(`  ... (+${interactiveActions.length - visibleActions.length} more actions)`);
		}
		if (opts.awaitingResponse) {
			lines.push(theme.fg("accent", "Awaiting your response. Select an action to continue."));
		}
		lines.push(theme.fg("dim", `Press ${UI_INTERACT_SHORTCUT} to compose and submit a prompt from actions.`));
	} else {
		lines.push(theme.fg("dim", "No interactive actions."));
	}
	return lines;
}

function componentPreview(component: UiComponent): string {
	const { kind } = component;
	switch (kind) {
		case "text":
			return `text · ${short(component.text, 80)}`;
		case "list":
			return `list · ${component.title ?? kind} · ${component.items.length} item(s)`;
		case "key_value":
			return `key_value · ${component.title ?? kind} · ${component.rows.length} row(s)`;
		case "divider":
			return "divider";
	}
	return kind;
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
	ctx.ui.setStatus(
		"mu-ui",
		[
			ctx.ui.theme.fg("dim", "ui"),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("accent", `${docs.length}`),
			ctx.ui.theme.fg("muted", "·"),
			awaiting.length > 0
				? ctx.ui.theme.fg("accent", `awaiting ${awaiting.length}`)
				: ctx.ui.theme.fg("dim", "ready"),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("text", labels),
		].join(" "),
	);
	const primaryDoc = awaiting[0] ?? docs[0]!;
	ctx.ui.setWidget(
		"mu-ui",
		renderDocPreview(ctx.ui.theme, primaryDoc, {
			awaitingResponse: state.awaitingUiIds.has(primaryDoc.ui_id),
			awaitingCount: awaiting.length,
		}),
		{ placement: "belowEditor" },
	);
}

export function uiExtension(pi: ExtensionAPI) {
	const commandUsage = "/mu ui status|snapshot [compact|multiline]|interact [ui_id [action_id]]";
	const usage = `Usage: ${commandUsage}`;

	const runUiActionFromDoc = async (ctx: ExtensionContext, state: UiState, uiId?: string, actionId?: string) => {
		const docs = activeDocs(state, UI_DISPLAY_DOCS_MAX);
		if (docs.length === 0) {
			ctx.ui.notify("No UI docs are currently available.", "info");
			return;
		}

		const entries = docs
			.map((doc) => ({ doc, actions: runnableActions(doc) }))
			.filter((entry) => entry.actions.length > 0);
		if (entries.length === 0) {
			ctx.ui.notify("No runnable UI actions are currently available.", "error");
			return;
		}

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
				ctx.ui.notify("UI interaction cancelled.", "info");
				return;
			}
			selectedDoc = picked.doc;
			selectedAction = picked.action;
		}

		if (!selectedDoc || !selectedAction) {
			ctx.ui.notify("No UI action was selected.", "error");
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
		if (state.pendingPrompt?.uiId === selectedDoc.ui_id) {
			state.pendingPrompt = null;
		}
		retainAwaitingUiIdsForActiveDocs(state);
		ctx.ui.notify(`Submitted prompt from ${selectedDoc.ui_id}/${selectedAction.id}.`, "info");
	};

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
		description: "Interact with programmable UI docs and submit prompt",
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
		const pending = state.pendingPrompt;
		if (!pending) {
			return;
		}
		state.pendingPrompt = null;
		ctx.ui.notify(
			`Agent requested input via ${pending.uiId}. Submit now or press ${UI_INTERACT_SHORTCUT} later.`,
			"info",
		);
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
