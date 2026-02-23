import { HudDocSchema, type HudDoc, normalizeHudDocs, serializeHudDocsTextFallback } from "@femtomc/mu-core";
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

	const snapshot = serializeHudDocsTextFallback(docs, {
		mode: "multiline",
		maxDocs: HUD_DISPLAY_DOCS_MAX,
		maxSectionItems: 6,
		maxActions: 4,
		maxChars: 8_000,
	});
	const lines = snapshot
		.split(/\r?\n/)
		.map((line) => short(line, HUD_LINE_MAX))
		.filter((line) => line.length > 0);
	ctx.ui.setWidget("mu-hud", lines.length > 0 ? lines : ["(hud enabled, no docs)"], { placement: "belowEditor" });
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
				extra: { hud_id: parsed.doc.hud_id },
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
			return { ok: true, action: "replace", message: `HUD docs replaced (${parsed.docs.length}).` };
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
