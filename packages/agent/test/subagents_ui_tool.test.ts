import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { subagentsUiExtension } from "../src/extensions/subagents-ui.js";

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
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(_name: string, _command: unknown) {
			return undefined;
		},
		on(_event: string, _handler: unknown) {
			return undefined;
		},
	};
	return { api, tools };
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

async function executeSubagentsTool(
	tool: RegisteredTool,
	params: Record<string, unknown>,
): Promise<unknown> {
	return tool.execute("call-1", params, undefined, undefined, { hasUI: false, cwd: process.cwd() });
}

describe("subagents HUD tool", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
	});

	test("registers mu_subagents_hud and reports status details", async () => {
		const { api, tools } = createExtensionApiMock();
		subagentsUiExtension(api as unknown as Parameters<typeof subagentsUiExtension>[0]);

		const tool = tools.get("mu_subagents_hud");
		expect(tool).toBeDefined();
		if (!tool) {
			throw new Error("mu_subagents_hud tool missing");
		}

		const result = await executeSubagentsTool(tool, { action: "status" });
		const details = detailsOf(result);
		expect(details.ok).toBe(true);
		expect(details.enabled).toBe(false);
		expect(details.prefix).toBe("mu-sub-");
		expect(details.issue_role_tag).toBe("role:worker");
		expect(details.issue_root_id).toBeNull();
	});

	test("returns structured validation errors without spawning external commands", async () => {
		const { api, tools } = createExtensionApiMock();
		subagentsUiExtension(api as unknown as Parameters<typeof subagentsUiExtension>[0]);

		const tool = tools.get("mu_subagents_hud");
		if (!tool) {
			throw new Error("mu_subagents_hud tool missing");
		}

		const missingPrefix = await executeSubagentsTool(tool, { action: "set_prefix" });
		const missingPrefixDetails = detailsOf(missingPrefix);
		expect(missingPrefixDetails.ok).toBe(false);
		expect(missingPrefixDetails.error).toBe("Missing prefix value.");

		const missingRoot = await executeSubagentsTool(tool, { action: "set_root" });
		const missingRootDetails = detailsOf(missingRoot);
		expect(missingRootDetails.ok).toBe(false);
		expect(missingRootDetails.error).toBe("Missing root issue id.");

		const spawnWithoutRoot = await executeSubagentsTool(tool, { action: "spawn", count: "all" });
		const spawnWithoutRootDetails = detailsOf(spawnWithoutRoot);
		expect(spawnWithoutRootDetails.ok).toBe(false);
		expect(textOf(spawnWithoutRoot)).toContain("Set a root first");
	});
});
