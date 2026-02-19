import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { queryExtension } from "../src/extensions/query.js";

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

describe("queryExtension", () => {
	const originalFetch = globalThis.fetch;
	const originalServerUrl = Bun.env.MU_SERVER_URL;

	beforeEach(() => {
		Bun.env.MU_SERVER_URL = "http://mu.test";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalServerUrl == null) {
			delete Bun.env.MU_SERVER_URL;
		} else {
			Bun.env.MU_SERVER_URL = originalServerUrl;
		}
	});

	test("describe returns machine-readable capability map", async () => {
		const pi = createPiMock();
		queryExtension(pi.api as any);
		const tool = pi.tool("query");
		const response = await tool.execute("tool-1", { action: "describe" });
		const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
		expect(payload.tool).toBe("query");
		expect(payload.resources.context.actions).toEqual(["search", "timeline", "stats"]);
		expect(payload.mutation_pathway.tool).toBe("command");
		expect(payload.mutation_pathway.kinds).toContain("heartbeat_create");
		expect(payload.mutation_pathway.kinds).toContain("cron_create");
	});

	test("get status fetches /api/status and supports fields projection", async () => {
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			seen.push(String(input));
			return new Response(
				JSON.stringify({
					repo_root: "/repo",
					open_count: 3,
					ready_count: 1,
					control_plane: {
						active: true,
						adapters: ["telegram"],
						routes: [{ name: "telegram", route: "/webhooks/telegram" }],
						generation: {
							supervisor_id: "cp",
							active_generation: { generation_id: "g1", generation_seq: 1 },
							pending_reload: null,
							last_reload: null,
						},
						observability: {
							counters: {
								reload_success_total: 0,
								reload_failure_total: 0,
								reload_drain_duration_ms_total: 0,
								reload_drain_duration_samples_total: 0,
								duplicate_signal_total: 0,
								drop_signal_total: 0,
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const pi = createPiMock();
		queryExtension(pi.api as any);
		const tool = pi.tool("query");
		const response = await tool.execute("tool-2", {
			action: "get",
			resource: "status",
			fields: "repo_root,control_plane.active",
		});
		const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
		expect(seen[0]).toBe("http://mu.test/api/status");
		expect(payload).toEqual({
			repo_root: "/repo",
			"control_plane.active": true,
		});
	});

	test("context search maps filters to /api/context/search", async () => {
		let requested = "";
		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			requested = String(input);
			return new Response(
				JSON.stringify({
					mode: "search",
					total: 1,
					items: [
						{
							source_kind: "events",
							text: "reload failed",
							ts_ms: 1,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const pi = createPiMock();
		queryExtension(pi.api as any);
		const tool = pi.tool("query");
		const response = await tool.execute("tool-3", {
			action: "search",
			resource: "context",
			query: "reload failed",
			sources: "events,cp_commands",
			limit: 15,
		});
		const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
		expect(requested).toContain("http://mu.test/api/context/search?");
		expect(requested).toContain("query=reload+failed");
		expect(requested).toContain("sources=events%2Ccp_commands");
		expect(requested).toContain("limit=15");
		expect(payload.total).toBe(1);
	});
});
