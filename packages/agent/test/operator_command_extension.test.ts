import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MU_COMMAND_TOOL_NAME, operatorCommandExtension } from "../src/extensions/operator-command.js";

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<{ content?: Array<{ text?: string }>; details?: Record<string, unknown> }>;
};

function createPiMock() {
	const tools = new Map<string, RegisteredTool>();
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on() {
			return undefined;
		},
		registerCommand() {
			return undefined;
		},
	};
	return {
		api,
		tool(name: string): RegisteredTool {
			const tool = tools.get(name);
			if (!tool) {
				throw new Error(`missing tool: ${name}`);
			}
			return tool;
		},
	};
}

describe("operatorCommandExtension", () => {
	const originalFetch = globalThis.fetch;
	const originalServerUrl = Bun.env.MU_SERVER_URL;

	beforeEach(() => {
		Bun.env.MU_SERVER_URL = "http://mu.test";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete Bun.env.MU_OPERATOR_MESSAGING_MODE;
		if (originalServerUrl == null) {
			delete Bun.env.MU_SERVER_URL;
		} else {
			Bun.env.MU_SERVER_URL = originalServerUrl;
		}
	});

	test("reports explicit command API mismatch when server returns non-JSON", async () => {
		globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
			return new Response("<html><body>not json</body></html>", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		}) as typeof fetch;

		const pi = createPiMock();
		operatorCommandExtension(pi.api as any);
		const tool = pi.tool(MU_COMMAND_TOOL_NAME);
		const response = await tool.execute("tool-1", {
			kind: "run_start",
			prompt: "hello",
		});

		expect(response.content?.[0]?.text).toContain("Command API mismatch");
		expect(response.details).toMatchObject({
			error: "command_api_mismatch",
			status: 200,
			content_type: "text/html",
		});
	});

	test("renders completed pipeline responses from command API", async () => {
		globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						kind: "completed",
						command: {
							target_type: "reload",
							result: { ok: true, action: "reload" },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const pi = createPiMock();
		operatorCommandExtension(pi.api as any);
		const tool = pi.tool(MU_COMMAND_TOOL_NAME);
		const response = await tool.execute("tool-2", { kind: "reload" });

		expect(response.content?.[0]?.text).toContain("Command completed: reload");
		expect(response.content?.[0]?.text).toContain('"action": "reload"');
		expect(response.details?.pipeline_result).toMatchObject({ kind: "completed" });
	});

	test("always routes through server even if MU_OPERATOR_MESSAGING_MODE is set", async () => {
		Bun.env.MU_OPERATOR_MESSAGING_MODE = "1";
		let called = false;
		globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
			called = true;
			return new Response(JSON.stringify({ ok: true, result: { kind: "completed", command: {} } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const pi = createPiMock();
		operatorCommandExtension(pi.api as any);
		const tool = pi.tool(MU_COMMAND_TOOL_NAME);
		await tool.execute("tool-3", { kind: "status" });

		expect(called).toBe(true);
	});
});
