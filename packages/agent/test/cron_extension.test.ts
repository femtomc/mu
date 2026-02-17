import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cronExtension } from "../src/extensions/cron.js";

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<any>;
};

type FetchCall = {
	url: string;
	method: string;
	body: unknown;
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

describe("cronExtension", () => {
	const originalFetch = globalThis.fetch;
	const originalMuServerUrl = Bun.env.MU_SERVER_URL;
	let fetchCalls: FetchCall[] = [];

	beforeEach(() => {
		fetchCalls = [];
		Bun.env.MU_SERVER_URL = "http://mu.test";
		globalThis.fetch = (async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof Request
						? input.url
						: input instanceof URL
							? input.href
							: String(input);
			const method = init?.method ?? "GET";
			const rawBody = typeof init?.body === "string" ? init.body : null;
			fetchCalls.push({
				url,
				method,
				body: rawBody ? JSON.parse(rawBody) : null,
			});
			return new Response(JSON.stringify({ ok: true, url, method }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalMuServerUrl == null) {
			delete Bun.env.MU_SERVER_URL;
		} else {
			Bun.env.MU_SERVER_URL = originalMuServerUrl;
		}
	});

	test("status/list/get actions call cron API endpoints", async () => {
		const pi = createPiMock();
		cronExtension(pi.api as any);
		const tool = pi.tool("mu_cron");

		await tool.execute("call-1", { action: "status" });
		await tool.execute("call-2", {
			action: "list",
			target_kind: "activity",
			enabled: true,
			schedule_filter: "every",
			limit: 25,
		});
		await tool.execute("call-3", { action: "get", program_id: "cron-123" });

		expect(fetchCalls[0]?.url).toBe("http://mu.test/api/cron/status");
		expect(fetchCalls[1]?.url).toContain("http://mu.test/api/cron?");
		expect(fetchCalls[1]?.url).toContain("target_kind=activity");
		expect(fetchCalls[1]?.url).toContain("enabled=true");
		expect(fetchCalls[1]?.url).toContain("schedule_kind=every");
		expect(fetchCalls[2]?.url).toBe("http://mu.test/api/cron/cron-123");
	});

	test("mutation actions send expected cron payloads", async () => {
		const pi = createPiMock();
		cronExtension(pi.api as any);
		const tool = pi.tool("mu_cron");

		await tool.execute("call-1", {
			action: "create",
			title: "Morning reminder",
			target_kind: "run",
			run_root_issue_id: "mu-root",
			schedule_kind: "cron",
			expr: "0 9 * * *",
			tz: "UTC",
			reason: "scheduled",
		});
		await tool.execute("call-2", {
			action: "update",
			program_id: "cron-123",
			title: "Updated",
			schedule_kind: "every",
			every_ms: 30_000,
		});
		await tool.execute("call-3", { action: "trigger", program_id: "cron-123", reason: "manual" });
		await tool.execute("call-4", { action: "enable", program_id: "cron-123" });
		await tool.execute("call-5", { action: "delete", program_id: "cron-123" });

		expect(fetchCalls.map((call) => call.url)).toEqual([
			"http://mu.test/api/cron/create",
			"http://mu.test/api/cron/update",
			"http://mu.test/api/cron/trigger",
			"http://mu.test/api/cron/update",
			"http://mu.test/api/cron/delete",
		]);
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toMatchObject({
			title: "Morning reminder",
			target_kind: "run",
			run_root_issue_id: "mu-root",
			schedule_kind: "cron",
			expr: "0 9 * * *",
			tz: "UTC",
		});
		expect(fetchCalls[1]?.body).toMatchObject({
			program_id: "cron-123",
			title: "Updated",
			schedule_kind: "every",
			every_ms: 30_000,
		});
		expect(fetchCalls[2]?.body).toMatchObject({
			program_id: "cron-123",
			reason: "manual",
		});
		expect(fetchCalls[3]?.body).toMatchObject({
			program_id: "cron-123",
			enabled: true,
		});
		expect(fetchCalls[4]?.body).toMatchObject({
			program_id: "cron-123",
		});
	});
});
