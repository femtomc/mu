import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { COMMAND_TOOL_NAME, operatorCommandExtension } from "../src/extensions/operator-command.js";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
	) => Promise<{ content?: Array<{ text?: string }>; details?: Record<string, unknown> }>;
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
		const tool = pi.tool(COMMAND_TOOL_NAME);
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
		const tool = pi.tool(COMMAND_TOOL_NAME);
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
		const tool = pi.tool(COMMAND_TOOL_NAME);
		await tool.execute("tool-3", { kind: "reload" });

		expect(called).toBe(true);
	});

	test("supports issue lifecycle mutation kinds", async () => {
		let requestBody: any = null;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						kind: "completed",
						command: {
							target_type: "issue close",
							result: { issue: { id: "mu-123", status: "closed", outcome: "success" } },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const pi = createPiMock();
		operatorCommandExtension(pi.api as any);
		const tool = pi.tool(COMMAND_TOOL_NAME);
		const response = await tool.execute("tool-4", {
			kind: "issue_close",
			id: "mu-123",
			outcome: "success",
		});

		expect(requestBody).toEqual({ kind: "issue_close", id: "mu-123", outcome: "success" });
		expect(response.content?.[0]?.text).toContain("Command completed: issue_close");
	});

	test("supports session flash mutation kinds", async () => {
		let requestBody: any = null;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						kind: "completed",
						command: {
							target_type: "session flash create",
							result: {
								flash: {
									flash_id: "flash-123",
									session_id: "operator-1",
									status: "pending",
								},
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const pi = createPiMock();
		operatorCommandExtension(pi.api as any);
		const tool = pi.tool(COMMAND_TOOL_NAME);
		const response = await tool.execute("tool-5", {
			kind: "session_flash_create",
			session_id: "operator-1",
			body: "ctx-123",
			context_ids: "ctx-123,ctx-456",
		});

		expect(requestBody).toEqual({
			kind: "session_flash_create",
			session_id: "operator-1",
			body: "ctx-123",
			context_ids: "ctx-123,ctx-456",
		});
		expect(response.content?.[0]?.text).toContain("Command completed: session_flash_create");
	});

	test("supports session_turn command kind", async () => {
		let requestBody: any = null;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						kind: "completed",
						command: {
							target_type: "session turn",
							result: {
								turn: {
									session_id: "operator-1",
									context_entry_id: "entry-1",
									reply: "Done",
								},
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const pi = createPiMock();
		operatorCommandExtension(pi.api as any);
		const tool = pi.tool(COMMAND_TOOL_NAME);
		const response = await tool.execute("tool-6", {
			kind: "session_turn",
			session_id: "operator-1",
			session_kind: "cp_operator",
			body: "Please answer in-context",
			source: "neovim",
		});

		expect(requestBody).toEqual({
			kind: "session_turn",
			session_id: "operator-1",
			session_kind: "cp_operator",
			body: "Please answer in-context",
			source: "neovim",
		});
		expect(response.content?.[0]?.text).toContain("Command completed: session_turn");
	});

	test("supports scheduler mutation kinds", async () => {
		let requestBody: any = null;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						kind: "completed",
						command: {
							target_type: "cron create",
							result: {
								program: {
									program_id: "cron-123",
									schedule: { kind: "every", every_ms: 60000 },
								},
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const pi = createPiMock();
		operatorCommandExtension(pi.api as any);
		const tool = pi.tool(COMMAND_TOOL_NAME);
		const response = await tool.execute("tool-5", {
			kind: "cron_create",
			title: "Minute pulse",
			target_kind: "activity",
			activity_id: "act-123",
			schedule_kind: "every",
			every_ms: 60_000,
			reason: "cron-scheduled",
		});

		expect(requestBody).toEqual({
			kind: "cron_create",
			title: "Minute pulse",
			target_kind: "activity",
			activity_id: "act-123",
			schedule_kind: "every",
			every_ms: 60_000,
			reason: "cron-scheduled",
		});
		expect(response.content?.[0]?.text).toContain("Command completed: cron_create");
	});
});
