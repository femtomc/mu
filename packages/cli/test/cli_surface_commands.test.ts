import { expect, test } from "bun:test";
import { getStorePaths } from "@femtomc/mu-core/node";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@femtomc/mu";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-cli-surface-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	await mkdir(join(getStorePaths(dir).storeDir, "control-plane"), { recursive: true });
	return dir;
}

test("new CLI parity surfaces call dedicated server APIs for control-plane commands", async () => {
	const dir = await mkTempRepo();
	const seen: Array<{ method: string; path: string; search: string; body: unknown }> = [];

	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			let body: unknown = null;
			if (req.method !== "GET") {
				try {
					body = await req.json();
				} catch {
					body = null;
				}
			}
			seen.push({ method: req.method, path: url.pathname, search: url.search, body });

			if (url.pathname === "/healthz") {
				return Response.json({ ok: true });
			}
			if (url.pathname === "/api/control-plane/runs") {
				return Response.json({ count: 1, runs: [{ job_id: "run-1", status: "running" }] });
			}
			if (url.pathname === "/api/heartbeats/create") {
				return Response.json({ ok: true, program: { program_id: "hb-1", ...(body as Record<string, unknown>) } });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});

	const discovery = join(getStorePaths(dir).storeDir, "control-plane", "server.json");
	await writeFile(
		discovery,
		`${JSON.stringify({ pid: process.pid, port: server.port, url: `http://localhost:${server.port}` })}\n`,
		"utf8",
	);

	try {
		const runs = await run(["runs", "list", "--status", "running", "--limit", "5", "--json"], { cwd: dir });
		expect(runs.exitCode).toBe(0);
		const runsPayload = JSON.parse(runs.stdout) as { count: number; runs: Array<{ job_id: string }> };
		expect(runsPayload.count).toBe(1);
		expect(runsPayload.runs[0]?.job_id).toBe("run-1");

		const hb = await run(
			[
				"heartbeats",
				"create",
				"--title",
				"Run heartbeat",
				"--prompt",
				"Check queued runs and recover stuck work",
				"--every-ms",
				"15000",
			],
			{
				cwd: dir,
			},
		);
		expect(hb.exitCode).toBe(0);
		const hbPayload = JSON.parse(hb.stdout) as {
			ok: boolean;
			program: { program_id: string; title: string; prompt?: string | null };
		};
		expect(hbPayload.ok).toBe(true);
		expect(hbPayload.program.program_id).toBe("hb-1");
		expect(hbPayload.program.title).toBe("Run heartbeat");
		expect(hbPayload.program.prompt).toBe("Check queued runs and recover stuck work");

		expect(
			seen.some((entry) => entry.path === "/api/control-plane/runs" && entry.search.includes("status=running")),
		).toBe(true);
		expect(seen.some((entry) => entry.path === "/api/heartbeats/create" && entry.method === "POST")).toBe(true);
		expect(
			seen.some(
				(entry) =>
					entry.path === "/api/heartbeats/create" &&
					(entry.body as Record<string, unknown> | null)?.prompt === "Check queued runs and recover stuck work",
			),
		).toBe(true);
		expect(seen.some((entry) => entry.path.startsWith("/api/context"))).toBe(false);
		expect(seen.some((entry) => entry.path === "/api/query")).toBe(false);
		expect(seen.some((entry) => entry.path === "/api/commands/submit")).toBe(false);
	} finally {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	}
});

test("control-plane/memory read interfaces default to compact output with opt-in --json", async () => {
	const dir = await mkTempRepo();
	const storeDir = getStorePaths(dir).storeDir;

	await writeFile(
		join(storeDir, "events.jsonl"),
		`${JSON.stringify({
			type: "control_plane.reload",
			source: "control-plane",
			issue_id: "mu-ctx-compact",
			run_id: "mu-root-compact",
			ts_ms: 1_700_000_010_000,
			payload: { result: "reload complete" },
		})}\n`,
		"utf8",
	);

	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/healthz") {
				return Response.json({ ok: true });
			}
			if (url.pathname === "/api/control-plane/runs") {
				return Response.json({
					count: 1,
					runs: [
						{
							job_id: "run-compact-1",
							status: "running",
							mode: "run_start",
							root_issue_id: "mu-root-compact",
							max_steps: 20,
							updated_at_ms: Date.now(),
							last_progress: "step 1/20",
						},
					],
				});
			}
			if (url.pathname === "/api/heartbeats") {
				return Response.json({
					count: 1,
					programs: [
						{
							program_id: "hb-compact-1",
							title: "health",
							enabled: true,
							every_ms: 15_000,
							updated_at_ms: Date.now(),
						},
					],
				});
			}
			if (url.pathname === "/api/cron/status") {
				return Response.json({ count: 1, enabled_count: 1, armed_count: 0, armed: [] });
			}
			if (url.pathname === "/api/cron") {
				return Response.json({
					count: 1,
					programs: [
						{
							program_id: "cron-compact-1",
							title: "daily",
							enabled: true,
							schedule: { kind: "every", every_ms: 60_000 },
							next_run_at_ms: Date.now() + 60_000,
						},
					],
				});
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});

	const discovery = join(getStorePaths(dir).storeDir, "control-plane", "server.json");
	await writeFile(
		discovery,
		`${JSON.stringify({ pid: process.pid, port: server.port, url: `http://localhost:${server.port}` })}\n`,
		"utf8",
	);

	try {
		const runsCompact = await run(["runs", "list"], { cwd: dir });
		expect(runsCompact.exitCode).toBe(0);
		expect(runsCompact.stdout).toContain("Runs:");

		const runsJson = await run(["runs", "list", "--json"], { cwd: dir });
		expect(runsJson.exitCode).toBe(0);
		expect((JSON.parse(runsJson.stdout) as { count: number }).count).toBe(1);

		const heartbeatsCompact = await run(["heartbeats", "list"], { cwd: dir });
		expect(heartbeatsCompact.exitCode).toBe(0);
		expect(heartbeatsCompact.stdout).toContain("Heartbeats:");

		const cronStatsCompact = await run(["cron", "stats"], { cwd: dir });
		expect(cronStatsCompact.exitCode).toBe(0);
		expect(cronStatsCompact.stdout).toContain("Cron status:");

		const cronListCompact = await run(["cron", "list"], { cwd: dir });
		expect(cronListCompact.exitCode).toBe(0);
		expect(cronListCompact.stdout).toContain("Cron programs:");

		const contextCompact = await run(["memory", "search", "--query", "reload", "--limit", "10"], { cwd: dir });
		expect(contextCompact.exitCode).toBe(0);
		expect(contextCompact.stdout).toContain("search:");

		const contextJson = await run(["memory", "search", "--query", "reload", "--limit", "10", "--json"], {
			cwd: dir,
		});
		expect(contextJson.exitCode).toBe(0);
		expect((JSON.parse(contextJson.stdout) as { mode: string }).mode).toBe("search");
	} finally {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	}
});

test("memory queries auto-heal missing index on demand", async () => {
	const dir = await mkTempRepo();
	const storeDir = getStorePaths(dir).storeDir;

	try {
		await writeFile(
			join(storeDir, "issues.jsonl"),
			`${JSON.stringify({
				id: "mu-auto-index-1",
				title: "Auto index",
				body: "auto-index-token",
				status: "open",
				tags: ["node:agent"],
				priority: 2,
				created_at: 1_700_000_200_000,
				updated_at: 1_700_000_200_100,
			})}\n`,
			"utf8",
		);

		const before = await run(["memory", "index", "status", "--json"], { cwd: dir });
		expect(before.exitCode).toBe(0);
		expect((JSON.parse(before.stdout) as { exists: boolean }).exists).toBe(false);

		const search = await run(["memory", "search", "--query", "auto-index-token", "--json"], { cwd: dir });
		expect(search.exitCode).toBe(0);
		expect((JSON.parse(search.stdout) as { total: number }).total).toBeGreaterThanOrEqual(1);

		const after = await run(["memory", "index", "status", "--json"], { cwd: dir });
		expect(after.exitCode).toBe(0);
		const afterPayload = JSON.parse(after.stdout) as { exists: boolean; total_count: number };
		expect(afterPayload.exists).toBe(true);
		expect(afterPayload.total_count).toBeGreaterThanOrEqual(1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("memory index rebuild/status enables index-first query fallback when source files disappear", async () => {
	const dir = await mkTempRepo();
	const storeDir = getStorePaths(dir).storeDir;

	try {
		await writeFile(
			join(storeDir, "issues.jsonl"),
			`${JSON.stringify({
				id: "mu-idx-1",
				title: "Index bootstrap",
				body: "index-only-token from issue",
				status: "open",
				tags: ["node:agent"],
				priority: 2,
				created_at: 1_700_000_100_000,
				updated_at: 1_700_000_100_100,
			})}\n`,
			"utf8",
		);
		await writeFile(
			join(storeDir, "forum.jsonl"),
			`${JSON.stringify({
				topic: "issue:mu-idx-1",
				author: "worker",
				body: "index-only-token from forum",
				created_at: 1_700_000_100_200,
			})}\n`,
			"utf8",
		);
		await writeFile(
			join(storeDir, "events.jsonl"),
			`${JSON.stringify({
				type: "control_plane.reload",
				source: "control-plane",
				issue_id: "mu-idx-1",
				run_id: "mu-root-idx",
				ts_ms: 1_700_000_100_300,
				payload: { note: "index-only-token from events" },
			})}\n`,
			"utf8",
		);

		const statusBefore = await run(["memory", "index", "status", "--json"], { cwd: dir });
		expect(statusBefore.exitCode).toBe(0);
		expect((JSON.parse(statusBefore.stdout) as { exists: boolean }).exists).toBe(false);

		const rebuild = await run(["memory", "index", "rebuild", "--json"], { cwd: dir });
		expect(rebuild.exitCode).toBe(0);
		const rebuildPayload = JSON.parse(rebuild.stdout) as {
			mode: string;
			exists: boolean;
			indexed_count: number;
		};
		expect(rebuildPayload.mode).toBe("index_rebuild");
		expect(rebuildPayload.exists).toBe(true);
		expect(rebuildPayload.indexed_count).toBeGreaterThanOrEqual(3);

		await rm(join(storeDir, "issues.jsonl"), { force: true });
		await rm(join(storeDir, "forum.jsonl"), { force: true });
		await rm(join(storeDir, "events.jsonl"), { force: true });

		const search = await run(["memory", "search", "--query", "index-only-token", "--json"], {
			cwd: dir,
		});
		expect(search.exitCode).toBe(0);
		const searchPayload = JSON.parse(search.stdout) as {
			mode: string;
			total: number;
			items: Array<{ source_kind: string }>;
		};
		expect(searchPayload.mode).toBe("search");
		expect(searchPayload.total).toBeGreaterThanOrEqual(1);
		expect(searchPayload.items.some((item) => item.source_kind === "issues")).toBe(true);

		const timeline = await run(["memory", "timeline", "--issue-id", "mu-idx-1", "--json"], {
			cwd: dir,
		});
		expect(timeline.exitCode).toBe(0);
		expect((JSON.parse(timeline.stdout) as { total: number }).total).toBeGreaterThanOrEqual(1);

		const statusAfter = await run(["memory", "index", "status", "--json"], { cwd: dir });
		expect(statusAfter.exitCode).toBe(0);
		const statusAfterPayload = JSON.parse(statusAfter.stdout) as {
			exists: boolean;
			stale_source_count: number;
		};
		expect(statusAfterPayload.exists).toBe(true);
		expect(statusAfterPayload.stale_source_count).toBeGreaterThanOrEqual(1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("memory search/timeline/stats use direct CLI runtime even when legacy /api/context routes 404", async () => {
	const dir = await mkTempRepo();
	const seen: string[] = [];
	const storeDir = getStorePaths(dir).storeDir;

	await writeFile(
		join(storeDir, "issues.jsonl"),
		`${JSON.stringify({
			id: "mu-ctx-1",
			title: "Fix reload failure",
			body: "control-plane reload hit a 404",
			status: "open",
			tags: ["bug", "node:agent"],
			priority: 2,
			created_at: 1_700_000_000_000,
			updated_at: 1_700_000_000_100,
		})}\n`,
		"utf8",
	);
	await writeFile(
		join(storeDir, "forum.jsonl"),
		`${JSON.stringify({
			topic: "issue:mu-ctx-1",
			author: "worker",
			body: "Investigating reload regression path.",
			created_at: 1_700_000_000_200,
		})}\n`,
		"utf8",
	);
	await writeFile(
		join(storeDir, "events.jsonl"),
		`${JSON.stringify({
			type: "control_plane.reload",
			source: "control-plane",
			issue_id: "mu-ctx-1",
			run_id: "mu-root-ctx",
			ts_ms: 1_700_000_000_300,
			payload: { result: "reload failed with 404" },
		})}\n`,
		"utf8",
	);

	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			seen.push(`${url.pathname}${url.search}`);
			if (url.pathname === "/healthz") {
				return Response.json({ ok: true });
			}
			if (url.pathname.startsWith("/api/context/")) {
				return Response.json({ error: "legacy context route removed" }, { status: 404 });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});

	const discovery = join(getStorePaths(dir).storeDir, "control-plane", "server.json");
	await writeFile(
		discovery,
		`${JSON.stringify({ pid: process.pid, port: server.port, url: `http://localhost:${server.port}` })}\n`,
		"utf8",
	);

	try {
		const search = await run(["memory", "search", "--query", "reload", "--limit", "10", "--json"], {
			cwd: dir,
		});
		expect(search.exitCode).toBe(0);
		const searchPayload = JSON.parse(search.stdout) as {
			mode: string;
			total: number;
			items: Array<{ source_kind: string }>;
		};
		expect(searchPayload.mode).toBe("search");
		expect(searchPayload.total).toBeGreaterThanOrEqual(1);
		expect(searchPayload.items.some((item) => item.source_kind === "events")).toBe(true);

		const timeline = await run(["memory", "timeline", "--issue-id", "mu-ctx-1", "--limit", "10", "--json"], {
			cwd: dir,
		});
		expect(timeline.exitCode).toBe(0);
		const timelinePayload = JSON.parse(timeline.stdout) as {
			mode: string;
			count: number;
			items: Array<{ issue_id: string | null }>;
		};
		expect(timelinePayload.mode).toBe("timeline");
		expect(timelinePayload.count).toBeGreaterThanOrEqual(1);
		expect(timelinePayload.items.every((item) => item.issue_id === "mu-ctx-1")).toBe(true);

		const stats = await run(["memory", "stats", "--source", "events", "--json"], { cwd: dir });
		expect(stats.exitCode).toBe(0);
		const statsPayload = JSON.parse(stats.stdout) as {
			mode: string;
			total_count: number;
			sources: Array<{ source_kind: string; count: number }>;
		};
		expect(statsPayload.mode).toBe("stats");
		expect(statsPayload.total_count).toBeGreaterThanOrEqual(1);
		expect(statsPayload.sources.some((source) => source.source_kind === "events" && source.count >= 1)).toBe(true);

		expect(seen.some((path) => path.startsWith("/api/context/"))).toBe(false);
	} finally {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	}
});

test("direct CLI surfaces return deterministic failure payloads when dedicated endpoints fail", async () => {
	const dir = await mkTempRepo();
	const seen: string[] = [];

	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			seen.push(url.pathname);
			if (url.pathname === "/healthz") {
				return Response.json({ ok: true });
			}
			if (url.pathname === "/api/control-plane/runs") {
				return Response.json({ error: "runs unavailable" }, { status: 503 });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});

	const discovery = join(getStorePaths(dir).storeDir, "control-plane", "server.json");
	await writeFile(
		discovery,
		`${JSON.stringify({ pid: process.pid, port: server.port, url: `http://localhost:${server.port}` })}\n`,
		"utf8",
	);

	try {
		const result = await run(["runs", "list"], { cwd: dir });
		expect(result.exitCode).toBe(1);
		const payload = JSON.parse(result.stdout) as { error?: string };
		expect(payload.error).toContain("request failed: runs unavailable (503 Service Unavailable)");
		expect(seen.includes("/api/control-plane/runs")).toBe(true);
		expect(seen.includes("/api/query")).toBe(false);
		expect(seen.includes("/api/commands/submit")).toBe(false);
	} finally {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	}
});
