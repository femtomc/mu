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
		const runs = await run(["runs", "list", "--status", "running", "--limit", "5"], { cwd: dir });
		expect(runs.exitCode).toBe(0);
		const runsPayload = JSON.parse(runs.stdout) as { count: number; runs: Array<{ job_id: string }> };
		expect(runsPayload.count).toBe(1);
		expect(runsPayload.runs[0]?.job_id).toBe("run-1");

		const hb = await run(["heartbeats", "create", "--title", "Run heartbeat", "--every-ms", "15000"], {
			cwd: dir,
		});
		expect(hb.exitCode).toBe(0);
		const hbPayload = JSON.parse(hb.stdout) as { ok: boolean; program: { program_id: string; title: string } };
		expect(hbPayload.ok).toBe(true);
		expect(hbPayload.program.program_id).toBe("hb-1");
		expect(hbPayload.program.title).toBe("Run heartbeat");

		expect(
			seen.some((entry) => entry.path === "/api/control-plane/runs" && entry.search.includes("status=running")),
		).toBe(true);
		expect(seen.some((entry) => entry.path === "/api/heartbeats/create" && entry.method === "POST")).toBe(true);
		expect(seen.some((entry) => entry.path.startsWith("/api/context"))).toBe(false);
		expect(seen.some((entry) => entry.path === "/api/query")).toBe(false);
		expect(seen.some((entry) => entry.path === "/api/commands/submit")).toBe(false);
	} finally {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	}
});

test("context search/timeline/stats use direct CLI runtime even when legacy /api/context routes 404", async () => {
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
		const search = await run(["context", "search", "--query", "reload", "--limit", "10"], { cwd: dir });
		expect(search.exitCode).toBe(0);
		const searchPayload = JSON.parse(search.stdout) as {
			mode: string;
			total: number;
			items: Array<{ source_kind: string }>;
		};
		expect(searchPayload.mode).toBe("search");
		expect(searchPayload.total).toBeGreaterThanOrEqual(1);
		expect(searchPayload.items.some((item) => item.source_kind === "events")).toBe(true);

		const timeline = await run(["context", "timeline", "--issue-id", "mu-ctx-1", "--limit", "10"], {
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

		const stats = await run(["context", "stats", "--source", "events"], { cwd: dir });
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
