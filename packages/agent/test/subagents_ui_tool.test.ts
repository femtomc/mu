import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetHudMode } from "../src/extensions/hud-mode.js";
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
	ctx: unknown = { hasUI: false, cwd: process.cwd() },
): Promise<unknown> {
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

function createInteractiveUiContext() {
	let widgetLines: string[] | undefined;
	const statuses = new Map<string, string>();
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			notify: () => undefined,
			setStatus: (key: string, text: string | undefined) => {
				if (text == null) {
					statuses.delete(key);
					return;
				}
				statuses.set(key, text);
			},
			setWidget: (_key: string, content: string[] | undefined) => {
				widgetLines = Array.isArray(content) ? [...content] : undefined;
			},
			theme: {
				fg: (_tone: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};
	return {
		ctx,
		getWidgetLines: () => widgetLines,
		getStatus: (key: string) => statuses.get(key),
	};
}

function textStream(value: string): ReadableStream {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			if (value.length > 0) {
				controller.enqueue(encoder.encode(value));
			}
			controller.close();
		},
	});
}

function fakeProcess(stdout: string, stderr = "", exitCode = 0): Bun.Subprocess {
	return {
		exited: Promise.resolve(exitCode),
		stdout: textStream(stdout),
		stderr: textStream(stderr),
		kill: () => undefined,
	} as unknown as Bun.Subprocess;
}

describe("subagents HUD tool", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
		resetHudMode();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
		resetHudMode();
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
		expect(details.issue_tag_filter).toBeNull();
		expect(details.issue_root_id).toBeNull();
		expect(details.spawn_mode).toBe("operator");
		expect(details.spawn_paused).toBe(false);
		expect(details.refresh_seconds).toBe(8);
		expect(details.stale_after_seconds).toBe(60);
	});

	test("supports compact snapshots for communication", async () => {
		const { api, tools } = createExtensionApiMock();
		subagentsUiExtension(api as unknown as Parameters<typeof subagentsUiExtension>[0]);

		const tool = tools.get("mu_subagents_hud");
		if (!tool) {
			throw new Error("mu_subagents_hud tool missing");
		}

		const result = await executeSubagentsTool(tool, { action: "snapshot", snapshot_format: "compact" });
		expect(textOf(result)).toContain("HUD(subagents)");
		expect(textOf(result)).toContain("mode=operator");
		expect(textOf(result)).toContain("paused=no");
	});

	test("renders compact widget layout on narrow terminal-friendly flow", async () => {
		const { api, tools } = createExtensionApiMock();
		subagentsUiExtension(api as unknown as Parameters<typeof subagentsUiExtension>[0]);

		const tool = tools.get("mu_subagents_hud");
		if (!tool) {
			throw new Error("mu_subagents_hud tool missing");
		}

		const originalSpawn = Bun.spawn;
		(Bun as { spawn: typeof Bun.spawn }).spawn = ((opts: { cmd: string[] }) => {
			const cmd = opts.cmd;
			if (cmd[0] === "tmux" && cmd[1] === "ls") {
				return fakeProcess(
					[
						"mu-sub-20260221-mu-a1111111: 1 windows (created)",
						"mu-sub-20260221-mu-b2222222: 1 windows (created)",
					].join("\n"),
				);
			}
			if (cmd[0] === "mu" && cmd.includes("ready")) {
				return fakeProcess("[]\n");
			}
			if (cmd[0] === "mu" && cmd.includes("in_progress")) {
				return fakeProcess(
					JSON.stringify([
						{
							id: "mu-a1111111",
							title: "Implement outbound-only v1 adapter path",
							status: "in_progress",
							priority: 2,
							tags: ["node:agent"],
						},
						{
							id: "mu-b2222222",
							title: "Validate fallback parser behavior under retries",
							status: "in_progress",
							priority: 2,
							tags: ["node:agent"],
						},
					]),
				);
			}
			return fakeProcess("", "unexpected command", 1);
		}) as typeof Bun.spawn;

		try {
			const uiHarness = createInteractiveUiContext();
			await executeSubagentsTool(tool, { action: "set_root", root_issue_id: "mu-1f703f7e" }, uiHarness.ctx);

			const lines = uiHarness.getWidgetLines() ?? [];
			expect(lines.length).toBeLessThanOrEqual(10);
			expect(lines[0]).toContain("Subagents");
			expect(lines.some((line) => line === "activity")).toBe(true);
			expect(
				lines.some(
					(line) =>
						line.startsWith("•") ||
						line.includes("subagent updates") ||
						line.includes("active operators") ||
						line.includes("activity refresh failed"),
				),
			).toBe(true);

			const subagentsStatus = uiHarness.getStatus("mu-subagents") ?? "";
			expect(subagentsStatus).toContain("subagents");
			expect(subagentsStatus).toContain("q:0/2");
			expect(uiHarness.getStatus("mu-hud-mode")).toBe("hud:subagents");
		} finally {
			(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
		}
	});

	test("treats missing activity endpoint as non-fatal", async () => {
		const { api, tools } = createExtensionApiMock();
		subagentsUiExtension(api as unknown as Parameters<typeof subagentsUiExtension>[0]);

		const tool = tools.get("mu_subagents_hud");
		if (!tool) {
			throw new Error("mu_subagents_hud tool missing");
		}

		const originalSpawn = Bun.spawn;
		const originalFetch = globalThis.fetch;
		const originalServerUrl = Bun.env.MU_SERVER_URL;
		Bun.env.MU_SERVER_URL = "http://127.0.0.1:3000";
		(globalThis as { fetch: typeof fetch }).fetch = ((async () =>
			new Response(JSON.stringify({ error: "Not Found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			})) as unknown) as typeof fetch;
		(Bun as { spawn: typeof Bun.spawn }).spawn = ((opts: { cmd: string[] }) => {
			const cmd = opts.cmd;
			if (cmd[0] === "tmux" && cmd[1] === "ls") {
				return fakeProcess("");
			}
			if (cmd[0] === "mu" && cmd.includes("ready")) {
				return fakeProcess(
					JSON.stringify([
						{
							id: "mu-a1111111",
							title: "Draft rollout sequence",
							status: "open",
							priority: 2,
							tags: ["node:agent"],
						},
					]),
				);
			}
			if (cmd[0] === "mu" && cmd.includes("in_progress")) {
				return fakeProcess("[]\n");
			}
			return fakeProcess("", "unexpected command", 1);
		}) as typeof Bun.spawn;

		try {
			const uiHarness = createInteractiveUiContext();
			await executeSubagentsTool(tool, { action: "set_root", root_issue_id: "mu-81fa6563" }, uiHarness.ctx);

			const lines = uiHarness.getWidgetLines() ?? [];
			expect(lines.some((line) => line.includes("activity refresh failed"))).toBe(false);
			expect(lines.some((line) => line.includes("ready mu-a1111111"))).toBe(true);

			const statusLine = uiHarness.getStatus("mu-subagents") ?? "";
			expect(statusLine).toContain("healthy");
		} finally {
			(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
			(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
			if (originalServerUrl === undefined) {
				delete Bun.env.MU_SERVER_URL;
			} else {
				Bun.env.MU_SERVER_URL = originalServerUrl;
			}
		}
	});

	test("falls back to forum topic activity when event API is unavailable", async () => {
		const { api, tools } = createExtensionApiMock();
		subagentsUiExtension(api as unknown as Parameters<typeof subagentsUiExtension>[0]);

		const tool = tools.get("mu_subagents_hud");
		if (!tool) {
			throw new Error("mu_subagents_hud tool missing");
		}

		const originalSpawn = Bun.spawn;
		const originalServerUrl = Bun.env.MU_SERVER_URL;
		delete Bun.env.MU_SERVER_URL;
		(Bun as { spawn: typeof Bun.spawn }).spawn = ((opts: { cmd: string[] }) => {
			const cmd = opts.cmd;
			if (cmd[0] === "tmux" && cmd[1] === "ls") {
				return fakeProcess("mu-sub-20260222-mu-a1111111: 1 windows (created)");
			}
			if (cmd[0] === "mu" && cmd.includes("ready")) {
				return fakeProcess("[]\n");
			}
			if (cmd[0] === "mu" && cmd.includes("in_progress")) {
				return fakeProcess(
					JSON.stringify([
						{
							id: "mu-a1111111",
							title: "Implement dynamic activity feed",
							status: "in_progress",
							priority: 1,
							tags: ["node:agent"],
						},
					]),
				);
			}
			if (cmd[0] === "mu" && cmd[1] === "forum" && cmd[2] === "read") {
				return fakeProcess(
					JSON.stringify([
						{
							topic: "issue:mu-a1111111",
							body: "START: Worker claimed this issue and is implementing updates.",
							author: "worker",
							created_at: Math.floor(Date.now() / 1000),
						},
					]),
				);
			}
			return fakeProcess("", "unexpected command", 1);
		}) as typeof Bun.spawn;

		try {
			const uiHarness = createInteractiveUiContext();
			await executeSubagentsTool(tool, { action: "set_root", root_issue_id: "mu-81fa6563" }, uiHarness.ctx);

			const lines = uiHarness.getWidgetLines() ?? [];
			expect(lines.some((line) => line.includes("worker:"))).toBe(true);
			expect(lines.some((line) => line.includes("mu-a1111111"))).toBe(true);
		} finally {
			(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
			if (originalServerUrl === undefined) {
				delete Bun.env.MU_SERVER_URL;
			} else {
				Bun.env.MU_SERVER_URL = originalServerUrl;
			}
		}
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

		const invalidMode = await executeSubagentsTool(tool, { action: "set_mode", spawn_mode: "invalid" });
		const invalidModeDetails = detailsOf(invalidMode);
		expect(invalidModeDetails.ok).toBe(false);
		expect(invalidModeDetails.error).toBe("Invalid spawn mode.");

		const invalidRefresh = await executeSubagentsTool(tool, { action: "set_refresh_interval", refresh_seconds: 0 });
		const invalidRefreshDetails = detailsOf(invalidRefresh);
		expect(invalidRefreshDetails.ok).toBe(false);
		expect(String(invalidRefreshDetails.error)).toContain("refresh_seconds must be 2-120 seconds");

		const updateNoFields = await executeSubagentsTool(tool, { action: "update" });
		const updateNoFieldsDetails = detailsOf(updateNoFields);
		expect(updateNoFieldsDetails.ok).toBe(false);
		expect(updateNoFieldsDetails.error).toBe("No update fields provided.");

		const spawnWithoutRoot = await executeSubagentsTool(tool, { action: "spawn", count: "all" });
		const spawnWithoutRootDetails = detailsOf(spawnWithoutRoot);
		expect(spawnWithoutRootDetails.ok).toBe(false);
		expect(textOf(spawnWithoutRoot)).toContain("Set a root first");
	});
});
