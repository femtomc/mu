import {
	normalizeUiDocs,
	parseUiDoc,
	type UiComponent,
	type UiDoc,
} from "@femtomc/mu-core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

const UI_DISPLAY_DOCS_MAX = 16;
const UI_WIDGET_COMPONENTS_MAX = 6;
const UI_WIDGET_ACTIONS_MAX = 4;
const UI_SESSION_KEY_FALLBACK = "__mu_ui_active_session__";

type UiToolAction = "status" | "snapshot" | "set" | "update" | "replace" | "remove" | "clear";

type UiToolParams = {
	action: UiToolAction;
	doc?: unknown;
	docs?: unknown;
	ui_id?: string;
	snapshot_format?: "compact" | "multiline";
};

type UiState = {
	docsById: Map<string, UiDoc>;
};

type SessionStateEntry = {
	state: UiState;
	lastAccessMs: number;
};

const STATE_BY_SESSION = new Map<string, SessionStateEntry>();
const UI_STATE_TTL_MS = 30 * 60 * 1000; // keep session state for 30 minutes after last access

function createState(): UiState {
	return { docsById: new Map() };
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

function preferredDocForState(state: UiState, candidate: UiDoc): UiDoc {
	const existing = state.docsById.get(candidate.ui_id);
	if (!existing) {
		return candidate;
	}
	const merged = normalizeUiDocs([existing, candidate], { maxDocs: 2 });
	const chosen = merged.find((doc) => doc.ui_id === candidate.ui_id);
	return chosen ?? candidate;
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

function statusSummary(docs: UiDoc[]): string {
	const ids = docs.map((doc) => doc.ui_id).join(", ") || "(none)";
	return [`UI docs: ${docs.length}`, `ids: ${ids}`].join(" · ");
}

function snapshotText(docs: UiDoc[], format: "compact" | "multiline"): string {
	if (docs.length === 0) {
		return "(no UI docs)";
	}
	if (format === "compact") {
		return docs
			.map((doc) => `${doc.ui_id}: ${short(doc.title, 32)} (${doc.revision.version})`)
			.join(" | ");
	}
	const lines: string[] = [];
	docs.slice(0, 8).forEach((doc, idx) => {
		lines.push(`${idx + 1}. ${doc.title} [${doc.ui_id}]`);
		if (doc.summary) {
			lines.push(`   summary: ${short(doc.summary, 120)}`);
		}
		if (doc.actions.length > 0) {
			lines.push(`   actions: ${doc.actions.map((action) => action.label).join(", ")}`);
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

function parseSnapshotFormat(raw?: string): "compact" | "multiline" {
	const normalized = (raw ?? "compact").trim().toLowerCase();
	return normalized === "multiline" ? "multiline" : "compact";
}

function applyUiAction(params: UiToolParams, state: UiState): {
	ok: boolean;
	action: UiToolAction;
	message: string;
	extra?: Record<string, unknown>;
} {
	const docs = activeDocs(state);
	switch (params.action) {
		case "status":
			return { ok: true, action: "status", message: statusSummary(docs) };
		case "snapshot": {
			const format = parseSnapshotFormat(params.snapshot_format);
			return {
				ok: true,
				action: "snapshot",
				message: snapshotText(docs, format),
				extra: { snapshot_format: format },
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
			return {
				ok: true,
				action: params.action,
				message: `UI doc set: ${parsed.doc.ui_id}`,
				extra: { ui_id: parsed.doc.ui_id },
			};
		}
		case "replace": {
			const parsed = parseDocListInput(params.docs);
			if (!parsed.ok) {
				return { ok: false, action: "replace", message: parsed.error };
			}
			state.docsById.clear();
			for (const doc of parsed.docs) {
				state.docsById.set(doc.ui_id, doc);
			}
			return {
				ok: true,
				action: "replace",
				message: `UI docs replaced (${parsed.docs.length}).`,
				extra: { doc_count: parsed.docs.length },
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
			return { ok: true, action: "remove", message: `UI doc removed: ${uiId}` };
		}
		case "clear":
			state.docsById.clear();
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

function renderDocPreview(theme: ExtensionContext["ui"]["theme"], doc: UiDoc): string[] {
	const lines: string[] = [];
	lines.push(`${theme.fg("accent", doc.title)} ${theme.fg("muted", `[${doc.ui_id}]`)}`);
	if (doc.summary) {
		lines.push(theme.fg("muted", short(doc.summary, 80)));
	}
	const components = doc.components.slice(0, UI_WIDGET_COMPONENTS_MAX);
	if (components.length > 0) {
		lines.push(theme.fg("dim", "Components:"));
		for (const component of components) {
			lines.push(`  ${componentPreview(component)}`);
		}
	}
	if (doc.actions.length > 0) {
		lines.push(theme.fg("muted", "Actions:"));
		const visibleActions = doc.actions.slice(0, UI_WIDGET_ACTIONS_MAX);
		for (let idx = 0; idx < visibleActions.length; idx += 1) {
			const action = visibleActions[idx]!;
			lines.push(`  ${idx + 1}. ${action.label}`);
		}
		if (doc.actions.length > visibleActions.length) {
			lines.push(`  ... (+${doc.actions.length - visibleActions.length} more actions)`);
		}
		lines.push(theme.fg("dim", "Actions are handled through channel-native callbacks."));
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
	const docs = activeDocs(state);
	if (docs.length === 0) {
		ctx.ui.setStatus("mu-ui", undefined);
		ctx.ui.setWidget("mu-ui", undefined);
		return;
	}
	const labels = docs.map((doc) => doc.ui_id).join(", ");
	ctx.ui.setStatus(
		"mu-ui",
		[
			ctx.ui.theme.fg("dim", "ui"),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("accent", `${docs.length}`),
			ctx.ui.theme.fg("muted", "·"),
			ctx.ui.theme.fg("text", labels),
		].join(" "),
	);
	ctx.ui.setWidget("mu-ui", renderDocPreview(ctx.ui.theme, docs[0]!), { placement: "belowEditor" });
}

export function uiExtension(pi: ExtensionAPI) {
	registerMuSubcommand(pi, {
		subcommand: "ui",
		summary: "Inspect interactive UI docs",
		usage: "/mu ui status|snapshot [compact|multiline]",
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
			ctx.ui.notify("Usage: /mu ui status|snapshot [compact|multiline]", "info");
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
		execute: async (
			_toolCallId,
			paramsRaw,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<unknown>> => {
			const key = sessionKey(ctx);
			const state = ensureState(key);
			const params = paramsRaw as UiToolParams;
			const result = applyUiAction(params, state);
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
