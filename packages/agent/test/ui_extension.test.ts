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
		on() {
			return undefined;
		},
		sendUserMessage(message: string) {
			sendUserMessageCalls.push(message);
			return Promise.resolve();
		},
	};
	return { api, tools, commands, shortcuts, sendUserMessageCalls };
}

function createToolContext(sessionId: string) {
	const theme = {
		fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
	};
	return {
		hasUI: true,
		sessionManager: {
			getSessionId: () => sessionId,
		},
		ui: {
			theme,
			setStatus() {
				return undefined;
			},
			setWidget() {
				return undefined;
			},
			notify() {
				return undefined;
			},
		},
	};
}

function createCommandContext(sessionId: string) {
	const base = createToolContext(sessionId);
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		...base,
		ui: {
			...base.ui,
			notify(text: string, level: string) {
				notifications.push({ text, level });
			},
		},
	};
	return { ctx, notifications };
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

	test("registers mu_ui tool and /mu ui command without local interaction shortcut", () => {
		const { api, tools, commands, shortcuts } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		expect(tools.has("mu_ui")).toBe(true);
		expect(commands.has("mu")).toBe(true);
		expect(shortcuts.size).toBe(0);
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

		const reconnectStatus = await tool.execute("call-2", { action: "status" }, undefined, undefined, reconnectSession);
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

	test("/mu ui run is no longer supported and reports canonical usage", async () => {
		const { api, commands } = createExtensionApiMock();
		uiExtension(api as unknown as Parameters<typeof uiExtension>[0]);

		const command = commands.get("mu");
		if (!command || typeof (command as any).handler !== "function") {
			throw new Error("/mu command not registered");
		}

		const { ctx: commandCtx, notifications } = createCommandContext("session-no-run");
		await (command as any).handler("ui run", commandCtx);
		expect(notifications.some((entry) => entry.text.includes("Usage: /mu ui status|snapshot [compact|multiline]"))).toBe(true);
	});
});
