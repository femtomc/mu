import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneHandle } from "../src/control_plane.js";
import { composeServerRuntime, createServerFromRuntime } from "../src/server.js";

async function createServerForTest(opts: {
	repoRoot: string;
	controlPlane?: ControlPlaneHandle | null;
	serverOptions?: Parameters<typeof createServerFromRuntime>[1];
}) {
	const runtime = await composeServerRuntime({
		repoRoot: opts.repoRoot,
		controlPlane: opts.controlPlane ?? null,
	});
	return createServerFromRuntime(runtime, opts.serverOptions);
}

describe("server control-plane-only route surface", () => {
	let tempDir: string;
	let server: ReturnType<typeof createServerFromRuntime>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mu-server-cp-scope-"));
		const muDir = join(tempDir, ".mu");
		await mkdir(muDir, { recursive: true });
		await Bun.write(join(muDir, "events.jsonl"), "");
		server = await createServerForTest({ repoRoot: tempDir });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("/api/status exposes control-plane status without issue/forum counters", async () => {
		const response = await server.fetch(new Request("http://localhost/api/status"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.repo_root).toBe(tempDir);
		expect(payload.control_plane).toBeDefined();
		expect("open_count" in payload).toBe(false);
		expect("ready_count" in payload).toBe(false);
	});

	test("run/activity scheduling endpoints remain mounted", async () => {
		const heartbeatList = await server.fetch(new Request("http://localhost/api/heartbeats?limit=1"));
		expect(heartbeatList.status).toBe(200);

		const cronStatus = await server.fetch(new Request("http://localhost/api/cron/status"));
		expect(cronStatus.status).toBe(200);

		const runsList = await server.fetch(new Request("http://localhost/api/runs?limit=1"));
		expect(runsList.status).toBe(200);
	});

	test("legacy business gateway endpoints return 404", async () => {
		const legacyEndpoints = [
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "reload" }),
			}),
			new Request("http://localhost/api/issues", { method: "GET" }),
			new Request("http://localhost/api/forum/topics", { method: "GET" }),
			new Request("http://localhost/api/context/search?query=test", { method: "GET" }),
		];

		for (const request of legacyEndpoints) {
			const response = await server.fetch(request);
			expect(response.status).toBe(404);
		}
	});
});
