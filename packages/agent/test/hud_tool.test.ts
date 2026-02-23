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
