import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { hudExtension } from "../src/extensions/hud.js";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
};

function createExtensionApiMock() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, unknown>();
	const handlers = new Map<string, unknown[]>();
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		on(event: string, handler: unknown) {
			const bucket = handlers.get(event) ?? [];
			bucket.push(handler);
			handlers.set(event, bucket);
		},
	};
	return { api, tools, commands, handlers };
}

function detailsOf(result: unknown): Record<string, unknown> {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error("expected object tool result");
	}
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		throw new Error("expected object details");
	}
	return details as Record<string, unknown>;
}

function textOf(result: unknown): string {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return "";
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return "";
	}
	const first = content[0];
	if (!first || typeof first !== "object" || Array.isArray(first)) {
		return "";
	}
	const text = (first as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

function mkHudDoc(hudId: string, title: string, snapshot: string, updatedAtMs: number): Record<string, unknown> {
	return {
		v: 1,
		hud_id: hudId,
		title,
		scope: null,
		chips: [],
		sections: [{ kind: "text", text: snapshot }],
		actions: [],
		snapshot_compact: snapshot,
		updated_at_ms: updatedAtMs,
		metadata: {},
	};
}

async function executeHudTool(
	tool: RegisteredTool,
	params: Record<string, unknown>,
	ctx: unknown = { hasUI: false },
): Promise<unknown> {
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

function createHudUiHarness() {
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const theme = {
		fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
		inverse: (text: string) => `<inverse>${text}</inverse>`,
	};
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setStatus(key: string, text: string | undefined) {
				statuses.set(key, text);
			},
			setWidget(key: string, content: unknown) {
				if (Array.isArray(content)) {
					widgets.set(
						key,
						content.map((line) => (typeof line === "string" ? line : String(line))),
					);
					return;
				}
				widgets.set(key, undefined);
			},
			notify() {
				return undefined;
			},
		},
	};
	return { ctx, statuses, widgets };
}

describe("hud tool", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
	});

	test("registers mu_hud tool and /mu command", () => {
		const { api, tools, commands } = createExtensionApiMock();
		hudExtension(api as unknown as Parameters<typeof hudExtension>[0]);

		expect(tools.has("mu_hud")).toBe(true);
		expect(commands.has("mu")).toBe(true);
	});

	test("sets docs, reports status, and renders snapshots", async () => {
		const { api, tools } = createExtensionApiMock();
		hudExtension(api as unknown as Parameters<typeof hudExtension>[0]);

		const tool = tools.get("mu_hud");
		if (!tool) {
			throw new Error("mu_hud tool missing");
		}

		await executeHudTool(tool, { action: "on" });
		await executeHudTool(tool, {
			action: "set",
			doc: mkHudDoc("planning", "Planning HUD", "phase=investigating", 10),
		});
		await executeHudTool(tool, {
			action: "set",
			doc: mkHudDoc("subagents", "Subagents HUD", "ready=2 active=1", 11),
		});

		const status = await executeHudTool(tool, { action: "status" });
		const statusDetails = detailsOf(status);
		expect(statusDetails.ok).toBe(true);
		expect(statusDetails.enabled).toBe(true);
		expect(statusDetails.doc_count).toBe(2);
		expect(statusDetails.hud_ids).toEqual(["planning", "subagents"]);

		const snapshot = await executeHudTool(tool, { action: "snapshot", snapshot_format: "compact" });
		expect(textOf(snapshot)).toContain("Planning HUD");
		expect(textOf(snapshot)).toContain("Subagents HUD");
	});

	test("renders styled widget lines when UI context is available", async () => {
		const { api, tools } = createExtensionApiMock();
		hudExtension(api as unknown as Parameters<typeof hudExtension>[0]);

		const tool = tools.get("mu_hud");
		if (!tool) {
			throw new Error("mu_hud tool missing");
		}

		const uiHarness = createHudUiHarness();
		await executeHudTool(
			tool,
			{
				action: "set",
				doc: {
					v: 1,
					hud_id: "planning",
					title: "Planning HUD",
					title_style: { italic: true },
					scope: "issue:mu-1",
					chips: [{ key: "phase", label: "phase:review", tone: "warning", style: { weight: "normal", italic: true } }],
					sections: [
						{
							kind: "kv",
							title: "Status",
							title_style: { italic: true },
							items: [
								{
									key: "next",
									label: "next_action",
									value: "Ship HUD styling",
									tone: "accent",
									value_style: { code: true },
								},
							],
						},
						{
							kind: "checklist",
							title: "Checklist",
							items: [{ id: "1", label: "Render styled rows", done: true, style: { italic: true } }],
						},
					],
					actions: [
						{
							id: "snapshot",
							label: "Snapshot",
							command_text: "/mu hud snapshot",
							kind: "primary",
							style: { italic: true },
						},
					],
					snapshot_compact: "phase=review · waiting=no",
					snapshot_style: { code: true },
					updated_at_ms: 42,
					metadata: {},
				},
			},
			uiHarness.ctx,
		);

		const status = uiHarness.statuses.get("mu-hud") ?? "";
		expect(status).toContain("<accent>1</accent>");

		const widgetLines = uiHarness.widgets.get("mu-hud");
		expect(Array.isArray(widgetLines)).toBe(true);
		const rendered = (widgetLines ?? []).join("\n");
		expect(rendered).toContain("<accent><b><i>Planning HUD</i></b></accent>");
		expect(rendered).toContain("<warning><i>phase:review</i></warning>");
		expect(rendered).toContain("<accent><inverse>Ship HUD styling</inverse></accent>");
		expect(rendered).toContain("<success>[x]</success>");
		expect(rendered).toContain("<dim>snapshot:</dim> <muted><i><inverse>phase=review · waiting=no</inverse></i></muted>");
	});

	test("applies planning style preset metadata in TUI widget rendering", async () => {
		const { api, tools } = createExtensionApiMock();
		hudExtension(api as unknown as Parameters<typeof hudExtension>[0]);

		const tool = tools.get("mu_hud");
		if (!tool) {
			throw new Error("mu_hud tool missing");
		}

		const uiHarness = createHudUiHarness();
		await executeHudTool(
			tool,
			{
				action: "set",
				doc: {
					v: 1,
					hud_id: "planning",
					title: "Planning HUD",
					scope: "issue:mu-1",
					chips: [{ key: "phase", label: "phase:investigating", tone: "warning" }],
					sections: [
						{
							kind: "kv",
							title: "Status",
							items: [{ key: "root", label: "root", value: "mu-root-1", tone: "accent" }],
						},
					],
					actions: [{ id: "snapshot", label: "Snapshot", command_text: "/mu hud snapshot", kind: "secondary" }],
					snapshot_compact: "phase=investigating",
					updated_at_ms: 43,
					metadata: { style_preset: "planning" },
				},
			},
			uiHarness.ctx,
		);

		const rendered = (uiHarness.widgets.get("mu-hud") ?? []).join("\n");
		expect(rendered).toContain("<accent><b>Planning HUD</b></accent>");
		expect(rendered).toContain("<warning><b>phase:investigating</b></warning>");
		expect(rendered).toContain("<accent><inverse>mu-root-1</inverse></accent>");
		expect(rendered).toContain("<dim>snapshot:</dim> <muted><i>phase=investigating</i></muted>");
	});

	test("returns advisory preset warnings when style preset and doc shape diverge", async () => {
		const { api, tools } = createExtensionApiMock();
		hudExtension(api as unknown as Parameters<typeof hudExtension>[0]);

		const tool = tools.get("mu_hud");
		if (!tool) {
			throw new Error("mu_hud tool missing");
		}

		const result = await executeHudTool(tool, {
			action: "set",
			doc: {
				v: 1,
				hud_id: "subagents",
				title: "Mismatched HUD",
				scope: null,
				chips: [],
				sections: [{ kind: "text", text: "noop" }],
				actions: [],
				snapshot_compact: "noop",
				updated_at_ms: 50,
				metadata: { style_preset: "planning" },
			},
		});
		const details = detailsOf(result);
		expect(details.ok).toBe(true);
		const warnings = details.preset_warnings;
		expect(Array.isArray(warnings)).toBe(true);
		expect((warnings as string[]).some((warning) => warning.includes("expects hud_id=planning"))).toBe(true);
		expect((warnings as string[]).some((warning) => warning.includes("recommends a checklist section"))).toBe(true);
	});

	test("replace/remove/clear lifecycle updates doc inventory deterministically", async () => {
		const { api, tools } = createExtensionApiMock();
		hudExtension(api as unknown as Parameters<typeof hudExtension>[0]);

		const tool = tools.get("mu_hud");
		if (!tool) {
			throw new Error("mu_hud tool missing");
		}

		await executeHudTool(tool, {
			action: "replace",
			docs: [mkHudDoc("planning", "Planning HUD", "phase=drafting", 20)],
		});
		let details = detailsOf(await executeHudTool(tool, { action: "status" }));
		expect(details.doc_count).toBe(1);
		expect(details.hud_ids).toEqual(["planning"]);

		await executeHudTool(tool, { action: "remove", hud_id: "planning" });
		details = detailsOf(await executeHudTool(tool, { action: "status" }));
		expect(details.doc_count).toBe(0);

		await executeHudTool(tool, {
			action: "replace",
			docs: [mkHudDoc("planning", "Planning HUD", "phase=reviewing", 30), mkHudDoc("ops", "Ops HUD", "ok", 31)],
		});
		await executeHudTool(tool, { action: "clear" });
		details = detailsOf(await executeHudTool(tool, { action: "status" }));
		expect(details.doc_count).toBe(0);
		expect(details.hud_ids).toEqual([]);
	});

	test("returns structured errors for invalid docs and missing ids", async () => {
		const { api, tools } = createExtensionApiMock();
		hudExtension(api as unknown as Parameters<typeof hudExtension>[0]);

		const tool = tools.get("mu_hud");
		if (!tool) {
			throw new Error("mu_hud tool missing");
		}

		const invalidDoc = await executeHudTool(tool, { action: "set", doc: { hud_id: "planning" } });
		let details = detailsOf(invalidDoc);
		expect(details.ok).toBe(false);
		expect(String(details.error ?? "")).toContain("Invalid");

		const missingId = await executeHudTool(tool, { action: "remove" });
		details = detailsOf(missingId);
		expect(details.ok).toBe(false);
		expect(String(details.error ?? "")).toContain("Missing hud_id");
	});
});
