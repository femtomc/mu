import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UiDoc } from "@femtomc/mu-core";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { uiExtension } from "../src/extensions/ui.js";

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
	const shortcuts = new Map<string, unknown>();
	const eventHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sendUserMessageCalls: string[] = [];
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		registerShortcut(shortcut: string, options: unknown) {
			shortcuts.set(shortcut, options);
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
			return undefined;
		},
		sendUserMessage(message: string) {
			sendUserMessageCalls.push(message);
			return Promise.resolve();
		},
	};
	return { api, tools, commands, shortcuts, eventHandlers, sendUserMessageCalls };
}

function createToolContext(sessionId: string) {
	const theme = {
		fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
	};
	const uiCapture = {
		statusCalls: [] as Array<{ key: string; content: unknown }>,
		widgetCalls: [] as Array<{ key: string; content: unknown; options: unknown }>,
		customCalls: [] as Array<{ options: unknown }>,
	};
	return {
		hasUI: true,
		sessionManager: {
			getSessionId: () => sessionId,
		},
		__uiCapture: uiCapture,
		ui: {
			theme,
			setStatus(key: string, content: unknown) {
				uiCapture.statusCalls.push({ key, content });
				return undefined;
			},
			setWidget(key: string, content: unknown, options?: unknown) {
				uiCapture.widgetCalls.push({ key, content, options });
				return undefined;
			},
			notify() {
				return undefined;
			},
			select(_title: string, options: string[]) {
				return Promise.resolve(options[0]);
			},
			confirm() {
				return Promise.resolve(true);
			},
			input(_title: string, placeholder?: string) {
				return Promise.resolve(placeholder ?? "");
			},
			editor(_title: string, prefill?: string) {
				return Promise.resolve(prefill ?? "");
			},
			custom<T>(_factory: unknown, options?: unknown): Promise<T> {
				uiCapture.customCalls.push({ options });
				return Promise.resolve(null as T);
			},
		},
	};
}

type CommandContextOptions = {
	selectResponses?: Array<string | undefined>;
	confirmResponses?: Array<boolean | undefined>;
	inputResponses?: Array<string | undefined>;
	editorResponses?: Array<string | undefined>;
	customResponses?: unknown[];
};

function createCommandContext(sessionId: string, opts: CommandContextOptions = {}) {
	const base = createToolContext(sessionId);
	const notifications: Array<{ text: string; level: string }> = [];
	const inputCallTitles: string[] = [];
	const selectResponses = [...(opts.selectResponses ?? [])];
	const confirmResponses = [...(opts.confirmResponses ?? [])];
	const inputResponses = [...(opts.inputResponses ?? [])];
	const editorResponses = [...(opts.editorResponses ?? [])];
	const customResponses = [...(opts.customResponses ?? [])];
	const ctx = {
		...base,
		ui: {
			...base.ui,
			notify(text: string, level: string) {
				notifications.push({ text, level });
			},
			select(_title: string, options: string[]) {
				const next = selectResponses.shift();
				if (next === undefined) {
					return Promise.resolve(options[0]);
				}
				return Promise.resolve(next);
			},
			confirm() {
				const next = confirmResponses.shift();
				return Promise.resolve(next === undefined ? true : next);
			},
			input(title: string, placeholder?: string) {
				inputCallTitles.push(title);
				const next = inputResponses.shift();
				if (next === undefined) {
					return Promise.resolve(placeholder ?? "");
				}
				return Promise.resolve(next);
			},
			editor(_title: string, prefill?: string) {
				const next = editorResponses.shift();
				if (next === undefined) {
					return Promise.resolve(prefill ?? "");
				}
				return Promise.resolve(next);
			},
			custom<T>(_factory: unknown, options?: unknown) {
				(base as { __uiCapture: { customCalls: Array<{ options: unknown }> } }).__uiCapture.customCalls.push({
					options,
				});
				const next = customResponses.shift();
				return Promise.resolve((next === undefined ? null : next) as T);
			},
		},
	};
	return { ctx, notifications, inputCallTitles, uiCapture: (base as { __uiCapture: unknown }).__uiCapture };
}

function mkUiDoc(overrides: Partial<UiDoc> = {}): UiDoc {
	return {
		v: 1,
		ui_id: "ui:panel",
		title: "Panel",
		summary: "Summary",
		components: [
			{
				kind: "text",
				id: "c1",
				text: "Hello",
				metadata: {},
			},
		],
		actions: [],
		revision: { id: "rev:1", version: 1 },
		updated_at_ms: 123,
		metadata: {},
		...overrides,
	};
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

function uiDocsOf(result: unknown): UiDoc[] {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error("expected object tool result");
	}
	const uiDocs = (result as { ui_docs?: unknown }).ui_docs;
	if (!Array.isArray(uiDocs)) {
		return [];
	}
	return uiDocs as UiDoc[];
}

describe("uiExtension", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
	});

	test("registers mu_ui tool, /mu ui command, and interaction shortcuts", () => {
		const { api, tools, commands, shortcuts } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		expect(tools.has("mu_ui")).toBe(true);
		expect(commands.has("mu")).toBe(true);
		expect(shortcuts.has("ctrl+shift+u")).toBe(true);
		expect(shortcuts.has("alt+u")).toBe(true);
	});

	test("mu_ui tool stores docs and reports status", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const ctx = createToolContext("session-status");
		const doc = mkUiDoc({ ui_id: "panel-1", title: "Panel One" });
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, ctx);

		const statusResult = await tool.execute("call-2", { action: "status" }, undefined, undefined, ctx);
		const details = detailsOf(statusResult);
		expect(details.ok).toBe(true);
		expect(details.doc_count).toBe(1);
		expect(details.ui_ids).toEqual(["panel-1"]);

		const snapshotResult = await tool.execute(
			"call-3",
			{ action: "snapshot", snapshot_format: "compact" },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(snapshotResult)).toContain("panel-1");
	});

	test("mu_ui status reports profile-safe warning details for active status docs", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const ctx = createToolContext("session-status-profile-summary");
		await tool.execute(
			"call-1",
			{
				action: "set",
				doc: mkUiDoc({
					ui_id: "ui:planning",
					actions: [
						{
							id: "ask",
							label: "Ask",
							payload: {},
							metadata: { command_text: "/answer yes" },
						},
					],
					metadata: { profile: { id: "planning", variant: "status" } },
				}),
			},
			undefined,
			undefined,
			ctx,
		);

		const statusResult = await tool.execute("call-2", { action: "status" }, undefined, undefined, ctx);
		const details = detailsOf(statusResult);
		expect(details.status_profile_count).toBe(1);
		const warningsByUiId = details.profile_warnings as Record<string, string[]>;
		const planningWarnings = warningsByUiId["ui:planning"] ?? [];
		expect(Array.isArray(planningWarnings)).toBe(true);
		expect(planningWarnings.some((warning) => warning.includes("status docs should omit actions"))).toBe(true);
	});

	test("mu_ui snapshot compact prefers status-profile metadata and keeps deterministic ui_id ordering", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const ctx = createToolContext("session-status-snapshot-compact");
		const planningDoc = mkUiDoc({
			ui_id: "ui:planning",
			title: "Planning",
			actions: [],
			metadata: {
				profile: {
					id: "planning",
					variant: "status",
					snapshot: { compact: "phase=review" },
				},
			},
		});
		const subagentsDoc = mkUiDoc({
			ui_id: "ui:subagents",
			title: "Subagents",
			actions: [],
			metadata: {
				profile: {
					id: "subagents",
					variant: "status",
					snapshot: { compact: "workers=2 · ready=1" },
				},
			},
		});
		await tool.execute(
			"call-1",
			{
				action: "replace",
				docs: [subagentsDoc, planningDoc],
			},
			undefined,
			undefined,
			ctx,
		);

		const snapshotResult = await tool.execute(
			"call-2",
			{ action: "snapshot", snapshot_format: "compact" },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(snapshotResult)).toBe("ui:planning: phase=review | ui:subagents: workers=2 · ready=1");
		const details = detailsOf(snapshotResult);
		expect(details.status_profile_count).toBe(2);
	});

	test("mu_ui snapshot multiline keeps status-profile docs non-interactive and sorts generic action labels", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const ctx = createToolContext("session-status-snapshot-multiline");
		const statusDoc = mkUiDoc({
			ui_id: "ui:planning",
			title: "Planning",
			actions: [
				{
					id: "approve",
					label: "Approve now",
					payload: {},
					metadata: { command_text: "/approve" },
				},
			],
			metadata: {
				profile: {
					id: "planning",
					variant: "status",
					snapshot: { multiline: "phase: review\nwaiting: no" },
				},
			},
		});
		const genericDoc = mkUiDoc({
			ui_id: "ui:generic",
			title: "Generic",
			actions: [
				{ id: "z", label: "Z action", payload: {}, metadata: { command_text: "/z" } },
				{ id: "a", label: "A action", payload: {}, metadata: { command_text: "/a" } },
			],
			metadata: {},
		});
		await tool.execute(
			"call-1",
			{
				action: "replace",
				docs: [statusDoc, genericDoc],
			},
			undefined,
			undefined,
			ctx,
		);

		const snapshotResult = await tool.execute(
			"call-2",
			{ action: "snapshot", snapshot_format: "multiline" },
			undefined,
			undefined,
			ctx,
		);
		const snapshotText = textOf(snapshotResult);
		expect(snapshotText.includes("phase: review")).toBe(true);
		expect(snapshotText.includes("waiting: no")).toBe(true);
		expect(snapshotText.includes("actions omitted for status profile (1)")).toBe(true);
		expect(snapshotText.includes("Approve now")).toBe(false);
		expect(snapshotText.includes("actions: A action, Z action")).toBe(true);
	});

	test("mu_ui set surfaces profile_warnings for status-profile mismatches", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const ctx = createToolContext("session-profile-warnings");
		const result = await tool.execute(
			"call-1",
			{
				action: "set",
				doc: mkUiDoc({
					ui_id: "ui:runtime",
					metadata: { profile: { id: "planning", variant: "status" } },
				}),
			},
			undefined,
			undefined,
			ctx,
		);
		const details = detailsOf(result);
		const warnings = details.profile_warnings;
		expect(Array.isArray(warnings)).toBe(true);
		expect((warnings as string[]).some((warning) => warning.includes("expects ui_id=ui:planning"))).toBe(true);
	});

	test("mu_ui state is session-scoped and survives reconnects", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const primarySession = createToolContext("session-reconnect");
		const reconnectSession = createToolContext("session-reconnect");
		const otherSession = createToolContext("session-other");

		const doc = mkUiDoc({ ui_id: "panel-reconnect", title: "Reconnect panel" });
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, primarySession);

		const reconnectStatus = await tool.execute(
			"call-2",
			{ action: "status" },
			undefined,
			undefined,
			reconnectSession,
		);
		expect(detailsOf(reconnectStatus).doc_count).toBe(1);

		const otherStatus = await tool.execute("call-3", { action: "status" }, undefined, undefined, otherSession);
		expect(detailsOf(otherStatus).doc_count).toBe(0);
	});

	test("mu_ui set keeps highest revision when stale docs replay", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const ctx = createToolContext("session-revision");
		const latest = mkUiDoc({ ui_id: "panel-revision", revision: { id: "rev:2", version: 2 }, updated_at_ms: 200 });
		const stale = mkUiDoc({ ui_id: "panel-revision", revision: { id: "rev:1", version: 1 }, updated_at_ms: 100 });

		await tool.execute("call-1", { action: "set", doc: latest }, undefined, undefined, ctx);
		const staleResult = await tool.execute("call-2", { action: "set", doc: stale }, undefined, undefined, ctx);

		const docs = uiDocsOf(staleResult);
		expect(docs).toHaveLength(1);
		expect(docs[0]?.revision.version).toBe(2);
	});

	test("ui shortcut composes and submits a prompt from selected doc action", async () => {
		const { api, tools, shortcuts, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { name: "Ada", choice: "yes" },
			metadata: { command_text: "/answer name={{name}} choice={{choice}}" },
		};
		const doc = mkUiDoc({
			ui_id: "panel-run",
			title: "Run Panel",
			actions: [action],
		});
		const ctx = createToolContext("session-run");
		await tool.execute(
			"call-1",
			{
				action: "set",
				doc,
			},
			undefined,
			undefined,
			ctx,
		);

		const { ctx: commandCtx } = createCommandContext("session-run", {
			customResponses: [{ doc, action }],
			inputResponses: ["Grace", "no"],
			editorResponses: ["/answer name=Grace choice=no"],
			confirmResponses: [true],
		});
		await shortcut.handler(commandCtx);

		expect(sendUserMessageCalls).toEqual(["/answer name=Grace choice=no"]);
	});

	test("ui shortcut opens the action picker in fullscreen overlay mode", async () => {
		const { api, tools, shortcuts } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({
			ui_id: "panel-overlay",
			title: "Overlay Panel",
			actions: [action],
		});
		const toolCtx = createToolContext("session-overlay");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, toolCtx);

		const { ctx: commandCtx, uiCapture } = createCommandContext("session-overlay", {
			customResponses: [{ doc, action }],
			confirmResponses: [true],
		});
		await shortcut.handler(commandCtx);

		const capture = uiCapture as { customCalls: Array<{ options: unknown }> };
		expect(capture.customCalls.length).toBeGreaterThan(0);
		const firstCall = capture.customCalls[0]?.options as {
			overlay?: boolean;
			overlayOptions?: Record<string, unknown>;
		};
		expect(firstCall?.overlay).toBe(true);
		expect(firstCall?.overlayOptions).toEqual({
			anchor: "top-left",
			row: 0,
			col: 0,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
	});

	test("ui picker frame paints border rows on modal background", async () => {
		const { api, tools, shortcuts } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({
			ui_id: "panel-border-bg",
			title: "Border Background Panel",
			actions: [action],
		});
		const toolCtx = createToolContext("session-border-bg");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, toolCtx);

		const renderedFrames: string[][] = [];
		const baseCtx = createToolContext("session-border-bg");
		const commandCtx = {
			...baseCtx,
			ui: {
				...baseCtx.ui,
				notify() {
					return undefined;
				},
				custom<T>(factory: unknown, options?: unknown): Promise<T> {
					(baseCtx as { __uiCapture: { customCalls: Array<{ options: unknown }> } }).__uiCapture.customCalls.push({
						options,
					});
					const customBgAnsi = "\u001b[48;5;236m";
					const selectedBgAnsi = "\u001b[48;5;237m";
					const renderedTheme = {
						fg: (_tone: string, text: string) => text,
						bg: (tone: string, text: string) => {
							if (tone === "selectedBg") {
								return `${selectedBgAnsi}${text}\u001b[49m`;
							}
							return `${customBgAnsi}${text}\u001b[49m`;
						},
						bold: (text: string) => text,
					};
					const component = (
						factory as (
							tui: { terminal: { write: (data: string) => void }; requestRender: () => void },
							theme: { fg: (tone: string, text: string) => string; bg: (tone: string, text: string) => string; bold: (text: string) => string },
							keybindings: unknown,
							done: (result: unknown) => void,
						) => { render: (width: number) => string[]; dispose?: () => void }
					)(
						{
							terminal: { write: () => undefined },
							requestRender: () => undefined,
						},
						renderedTheme,
						{},
						() => undefined,
					);
					renderedFrames.push(component.render(120));
					component.dispose?.();
					return Promise.resolve(null as T);
				},
			},
		};

		await shortcut.handler(commandCtx);

		expect(renderedFrames.length).toBe(1);
		const frame = renderedFrames[0] ?? [];
		expect(frame.some((line) => line.includes("\u001b[48;5;236m╭"))).toBe(true);
		expect(frame.some((line) => line.includes("\u001b[48;5;236m╰"))).toBe(true);
	});

	test("ui shortcut hides widget while interactive picker is open", async () => {
		const { api, tools, shortcuts } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({
			ui_id: "panel-modal",
			title: "Modal Panel",
			actions: [action],
		});
		const toolCtx = createToolContext("session-modal");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, toolCtx);

		let resolveSelection!: (value: { doc: UiDoc; action: typeof action }) => void;
		const selectionPromise = new Promise<{ doc: UiDoc; action: typeof action }>((resolve) => {
			resolveSelection = resolve;
		});
		const { ctx: commandCtx, uiCapture } = createCommandContext("session-modal", {
			customResponses: [selectionPromise],
			confirmResponses: [true],
		});

		const runPromise = shortcut.handler(commandCtx);
		await Promise.resolve();
		await Promise.resolve();

		const capture = uiCapture as {
			statusCalls: Array<{ content: unknown }>;
			widgetCalls: Array<{ content: unknown }>;
		};
		const statusDuringPrompt = capture.statusCalls[capture.statusCalls.length - 1]?.content;
		expect(typeof statusDuringPrompt).toBe("string");
		expect((statusDuringPrompt as string).includes("prompting")).toBe(true);
		const widgetDuringPrompt = capture.widgetCalls[capture.widgetCalls.length - 1]?.content;
		expect(widgetDuringPrompt).toBeUndefined();

		resolveSelection({ doc, action });
		await runPromise;

		const statusAfterPrompt = capture.statusCalls[capture.statusCalls.length - 1]?.content;
		expect(typeof statusAfterPrompt).toBe("string");
		expect((statusAfterPrompt as string).includes("prompting")).toBe(false);
		const widgetAfterPrompt = capture.widgetCalls[capture.widgetCalls.length - 1]?.content;
		expect(widgetAfterPrompt).toBeUndefined();
	});

	test("ui shortcut auto-fills template values from payload defaults without extra prompts", async () => {
		const { api, tools, shortcuts, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { name: "Ada", choice: "yes" },
			metadata: { command_text: "/answer name={{name}} choice={{choice}}" },
		};
		const doc = mkUiDoc({
			ui_id: "panel-defaults",
			title: "Defaults Panel",
			actions: [action],
		});
		const ctx = createToolContext("session-defaults");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, ctx);

		const { ctx: commandCtx, inputCallTitles } = createCommandContext("session-defaults", {
			customResponses: [{ doc, action }],
			confirmResponses: [true],
		});
		await shortcut.handler(commandCtx);

		expect(inputCallTitles).toHaveLength(0);
		expect(sendUserMessageCalls).toEqual(["/answer name=Ada choice=yes"]);
	});

	test("ui shortcut prompts only unresolved template values and supports dotted payload paths", async () => {
		const { api, tools, shortcuts, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { user: { name: "Ada" } },
			metadata: { command_text: "/answer name={{user.name}} note={{note}}" },
		};
		const doc = mkUiDoc({
			ui_id: "panel-unresolved",
			title: "Unresolved Panel",
			actions: [action],
		});
		const ctx = createToolContext("session-unresolved");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, ctx);

		const { ctx: commandCtx, inputCallTitles } = createCommandContext("session-unresolved", {
			customResponses: [{ doc, action }],
			inputResponses: ["ship-it"],
			confirmResponses: [true],
		});
		await shortcut.handler(commandCtx);

		expect(inputCallTitles).toEqual(["UI field: note"]);
		expect(sendUserMessageCalls).toEqual(["/answer name=Ada note=ship-it"]);
	});

	test("agent_end auto-prompts for newly published runnable UI docs", async () => {
		const { api, tools, eventHandlers, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const agentEndHandlers = eventHandlers.get("agent_end") ?? [];
		const agentEndHandler = agentEndHandlers[0];
		if (typeof agentEndHandler !== "function") {
			throw new Error("agent_end handler missing");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({ ui_id: "panel-auto", title: "Auto Prompt", actions: [action] });
		const toolCtx = createToolContext("session-auto");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, toolCtx);

		const { ctx: commandCtx } = createCommandContext("session-auto", {
			confirmResponses: [true],
		});
		await agentEndHandler({ type: "agent_end", messages: [] }, commandCtx);

		expect(sendUserMessageCalls).toEqual(["/answer choice=yes"]);
	});

	test("status-profile async docs update widget and do not auto-open modal", async () => {
		const { api, tools, eventHandlers, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const agentEndHandlers = eventHandlers.get("agent_end") ?? [];
		const agentEndHandler = agentEndHandlers[0];
		if (typeof agentEndHandler !== "function") {
			throw new Error("agent_end handler missing");
		}

		const statusDoc = mkUiDoc({
			ui_id: "ui:planning",
			title: "Planning status",
			actions: [],
			metadata: {
				profile: {
					id: "planning",
					variant: "status",
					snapshot: { compact: "phase=investigating waiting=no" },
				},
			},
		});
		const toolCtx = createToolContext("session-status-no-auto");
		await tool.execute("call-1", { action: "set", doc: statusDoc }, undefined, undefined, toolCtx);

		const capture = (
			toolCtx as {
				__uiCapture: {
					statusCalls: Array<{ content: unknown }>;
					widgetCalls: Array<{ content: unknown }>;
				};
			}
		).__uiCapture;
		const statusText = capture.statusCalls[capture.statusCalls.length - 1]?.content;
		expect(typeof statusText).toBe("string");
		expect((statusText as string).includes("awaiting")).toBe(false);
		expect((statusText as string).includes("async 1")).toBe(true);
		const widgetContent = capture.widgetCalls[capture.widgetCalls.length - 1]?.content;
		expect(Array.isArray(widgetContent)).toBe(true);
		expect((widgetContent as string[]).some((line) => line.includes("planning"))).toBe(true);

		const { ctx: commandCtx, uiCapture } = createCommandContext("session-status-no-auto", {
			customResponses: [null],
		});
		await agentEndHandler({ type: "agent_end", messages: [] }, commandCtx);

		const commandCapture = uiCapture as { customCalls: Array<{ options: unknown }> };
		expect(commandCapture.customCalls.length).toBe(0);
		expect(sendUserMessageCalls).toEqual([]);
	});

	test("agent_end auto-opens status modal once per published status revision", async () => {
		const { api, tools, eventHandlers } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const agentEndHandlers = eventHandlers.get("agent_end") ?? [];
		const agentEndHandler = agentEndHandlers[0];
		if (typeof agentEndHandler !== "function") {
			throw new Error("agent_end handler missing");
		}

		const rev1 = mkUiDoc({
			ui_id: "ui:subagents",
			title: "Subagents status",
			actions: [],
			revision: { id: "rev:subagents:1", version: 1 },
			updated_at_ms: 100,
			metadata: { profile: { id: "subagents", variant: "status", delivery: "review" } },
		});
		const toolCtx = createToolContext("session-status-revision");
		await tool.execute("call-1", { action: "set", doc: rev1 }, undefined, undefined, toolCtx);

		const first = createCommandContext("session-status-revision", { customResponses: [null] });
		await agentEndHandler({ type: "agent_end", messages: [] }, first.ctx);
		expect((first.uiCapture as { customCalls: Array<{ options: unknown }> }).customCalls.length).toBeGreaterThan(0);

		const second = createCommandContext("session-status-revision", { customResponses: [null] });
		await agentEndHandler({ type: "agent_end", messages: [] }, second.ctx);
		expect((second.uiCapture as { customCalls: Array<{ options: unknown }> }).customCalls.length).toBe(0);

		const rev2 = mkUiDoc({
			ui_id: "ui:subagents",
			title: "Subagents status",
			actions: [],
			revision: { id: "rev:subagents:2", version: 2 },
			updated_at_ms: 200,
			metadata: { profile: { id: "subagents", variant: "status", delivery: "review" } },
		});
		await tool.execute("call-2", { action: "set", doc: rev2 }, undefined, undefined, toolCtx);

		const third = createCommandContext("session-status-revision", { customResponses: [null] });
		await agentEndHandler({ type: "agent_end", messages: [] }, third.ctx);
		expect((third.uiCapture as { customCalls: Array<{ options: unknown }> }).customCalls.length).toBeGreaterThan(0);
	});

	test("agent_end queues status review behind runnable auto-prompt when both are published", async () => {
		const { api, tools, eventHandlers, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const agentEndHandlers = eventHandlers.get("agent_end") ?? [];
		const agentEndHandler = agentEndHandlers[0];
		if (typeof agentEndHandler !== "function") {
			throw new Error("agent_end handler missing");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const runnableDoc = mkUiDoc({
			ui_id: "panel-queue-action",
			title: "Queue Action",
			actions: [action],
			revision: { id: "rev:queue:action:1", version: 1 },
			updated_at_ms: 200,
		});
		const statusDoc = mkUiDoc({
			ui_id: "ui:subagents",
			title: "Subagents status",
			actions: [],
			revision: { id: "rev:queue:status:1", version: 1 },
			updated_at_ms: 100,
			metadata: { profile: { id: "subagents", variant: "status", delivery: "review" } },
		});
		const toolCtx = createToolContext("session-auto-queue");
		await tool.execute(
			"call-1",
			{
				action: "replace",
				docs: [statusDoc, runnableDoc],
			},
			undefined,
			undefined,
			toolCtx,
		);

		const first = createCommandContext("session-auto-queue", { confirmResponses: [true] });
		await agentEndHandler({ type: "agent_end", messages: [] }, first.ctx);
		expect(sendUserMessageCalls).toEqual(["/answer choice=yes"]);
		expect((first.uiCapture as { customCalls: Array<{ options: unknown }> }).customCalls.length).toBe(0);

		const second = createCommandContext("session-auto-queue", { customResponses: [null] });
		await agentEndHandler({ type: "agent_end", messages: [] }, second.ctx);
		expect((second.uiCapture as { customCalls: Array<{ options: unknown }> }).customCalls.length).toBeGreaterThan(0);
		expect(sendUserMessageCalls).toEqual(["/answer choice=yes"]);
	});

	test("agent_end auto-prompt runs once per published revision", async () => {
		const { api, tools, eventHandlers, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const agentEndHandlers = eventHandlers.get("agent_end") ?? [];
		const agentEndHandler = agentEndHandlers[0];
		if (typeof agentEndHandler !== "function") {
			throw new Error("agent_end handler missing");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({ ui_id: "panel-auto-once", title: "Auto Once", actions: [action] });
		const toolCtx = createToolContext("session-auto-once");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, toolCtx);

		const first = createCommandContext("session-auto-once", { confirmResponses: [true] });
		await agentEndHandler({ type: "agent_end", messages: [] }, first.ctx);
		const second = createCommandContext("session-auto-once", { confirmResponses: [true] });
		await agentEndHandler({ type: "agent_end", messages: [] }, second.ctx);

		expect(sendUserMessageCalls).toEqual(["/answer choice=yes"]);
	});

	test("ui status surfaces awaiting response state for runnable docs while widget stays hidden", async () => {
		const { api, tools } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({ ui_id: "panel-awaiting", title: "Awaiting Panel", actions: [action] });
		const ctx = createToolContext("session-awaiting");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, ctx);

		const capture = (
			ctx as { __uiCapture: { statusCalls: Array<{ content: unknown }>; widgetCalls: Array<{ content: unknown }> } }
		).__uiCapture;
		const statusText = capture.statusCalls[capture.statusCalls.length - 1]?.content;
		expect(typeof statusText).toBe("string");
		expect((statusText as string).includes("awaiting 1")).toBe(true);
		const widgetContent = capture.widgetCalls[capture.widgetCalls.length - 1]?.content;
		expect(widgetContent).toBeUndefined();
	});

	test("ui shortcut opens modal overlay for status docs without runnable actions", async () => {
		const { api, tools, shortcuts } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const doc = mkUiDoc({
			ui_id: "ui:planning",
			title: "Planning status",
			components: [
				{
					kind: "key_value",
					id: "status",
					title: "Status",
					rows: [
						{ key: "phase", value: "investigating" },
						{ key: "waiting", value: "no" },
						{ key: "confidence", value: "medium" },
					],
					metadata: {},
				},
			],
			actions: [],
			metadata: { profile: { id: "planning", variant: "status" } },
		});
		const toolCtx = createToolContext("session-modal-status");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, toolCtx);

		const { ctx: commandCtx, uiCapture, notifications } = createCommandContext("session-modal-status", {
			customResponses: [null],
		});
		await shortcut.handler(commandCtx);

		const capture = uiCapture as { customCalls: Array<{ options: unknown }> };
		expect(capture.customCalls.length).toBeGreaterThan(0);
		const firstCall = capture.customCalls[0]?.options as {
			overlay?: boolean;
			overlayOptions?: Record<string, unknown>;
		};
		expect(firstCall?.overlay).toBe(true);
		expect(firstCall?.overlayOptions).toEqual({
			anchor: "top-left",
			row: 0,
			col: 0,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		expect(notifications.some((entry) => entry.text.includes("No runnable UI actions"))).toBe(false);
	});

	test("submitting a ui action clears awaiting response status", async () => {
		const { api, tools, shortcuts } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const shortcut = shortcuts.get("ctrl+shift+u") as { handler?: (ctx: unknown) => Promise<void> } | undefined;
		if (!shortcut || typeof shortcut.handler !== "function") {
			throw new Error("ui interaction shortcut not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({ ui_id: "panel-awaiting-clear", title: "Awaiting Clear", actions: [action] });
		const ctx = createToolContext("session-awaiting-clear");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, ctx);

		const { ctx: commandCtx, uiCapture } = createCommandContext("session-awaiting-clear", {
			customResponses: [{ doc, action }],
			confirmResponses: [true],
		});
		await shortcut.handler(commandCtx);

		const capture = uiCapture as {
			statusCalls: Array<{ content: unknown }>;
			widgetCalls: Array<{ content: unknown }>;
		};
		const statusText = capture.statusCalls[capture.statusCalls.length - 1]?.content;
		expect(typeof statusText).toBe("string");
		expect((statusText as string).includes("awaiting 1")).toBe(false);
		expect((statusText as string).includes("ready")).toBe(true);
		const widgetContent = capture.widgetCalls[capture.widgetCalls.length - 1]?.content;
		expect(widgetContent).toBeUndefined();
	});

	test("/mu ui interact runs local action flow via command dispatcher", async () => {
		const { api, tools, commands, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const command = commands.get("mu");
		if (!command || typeof (command as any).handler !== "function") {
			throw new Error("/mu command not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({ ui_id: "panel-cmd", title: "Command Panel", actions: [action] });
		const ctx = createToolContext("session-command-interact");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, ctx);

		const { ctx: commandCtx } = createCommandContext("session-command-interact", {
			customResponses: [{ doc, action }],
			editorResponses: ["/answer choice=no"],
			confirmResponses: [true],
		});
		await (command as any).handler("ui interact", commandCtx);
		expect(sendUserMessageCalls).toEqual(["/answer choice=no"]);
	});

	test("/mu ui interact <ui_id> <action_id> executes targeted action without picker", async () => {
		const { api, tools, commands, sendUserMessageCalls } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const tool = tools.get("mu_ui");
		if (!tool) {
			throw new Error("mu_ui tool missing");
		}
		const command = commands.get("mu");
		if (!command || typeof (command as any).handler !== "function") {
			throw new Error("/mu command not registered");
		}

		const action = {
			id: "submit",
			label: "Submit",
			payload: { choice: "yes" },
			metadata: { command_text: "/answer choice={{choice}}" },
		};
		const doc = mkUiDoc({ ui_id: "panel-target", title: "Target Panel", actions: [action] });
		const ctx = createToolContext("session-command-target");
		await tool.execute("call-1", { action: "set", doc }, undefined, undefined, ctx);

		const { ctx: commandCtx } = createCommandContext("session-command-target", {
			confirmResponses: [true],
		});
		await (command as any).handler("ui interact panel-target submit", commandCtx);
		expect(sendUserMessageCalls).toEqual(["/answer choice=yes"]);
	});

	test("/mu ui unknown subcommand reports canonical usage", async () => {
		const { api, commands } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const command = commands.get("mu");
		if (!command || typeof (command as any).handler !== "function") {
			throw new Error("/mu command not registered");
		}

		const { ctx: commandCtx, notifications } = createCommandContext("session-usage");
		await (command as any).handler("ui nope", commandCtx);
		expect(
			notifications.some((entry) =>
				entry.text.includes("Usage: /mu ui status|snapshot [compact|multiline]|interact [ui_id [action_id]]"),
			),
		).toBe(true);
	});
});
