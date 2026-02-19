import type { AutoHeartbeatRunSnapshot } from "../server_program_orchestration.js";
import type { ServerRoutingDependencies } from "../server_routing.js";
import { normalizeWakeMode } from "../server_types.js";

export async function runRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	const path = url.pathname;

	if (path === "/api/runs") {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const status = url.searchParams.get("status")?.trim() || undefined;
		const limitRaw = url.searchParams.get("limit");
		const limit =
			limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : undefined;
		const runs = await deps.controlPlaneProxy.listRuns?.({ status, limit });
		return Response.json({ count: runs?.length ?? 0, runs: runs ?? [] }, { headers });
	}

	if (path === "/api/runs/start") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { prompt?: unknown; max_steps?: unknown };
		try {
			body = (await request.json()) as { prompt?: unknown; max_steps?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		if (prompt.length === 0) {
			return Response.json({ error: "prompt is required" }, { status: 400, headers });
		}
		const maxSteps =
			typeof body.max_steps === "number" && Number.isFinite(body.max_steps)
				? Math.max(1, Math.trunc(body.max_steps))
				: undefined;
		try {
			const run = await deps.controlPlaneProxy.startRun?.({ prompt, maxSteps });
			if (!run) {
				return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
			}
			await deps.registerAutoRunHeartbeatProgram(run as AutoHeartbeatRunSnapshot).catch(async (error) => {
				await deps.context.eventLog.emit("run.auto_heartbeat.lifecycle", {
					source: "mu-server.runs",
					payload: {
						action: "register_failed",
						run_job_id: run.job_id,
						error: deps.describeError(error),
					},
				});
			});
			return Response.json({ ok: true, run }, { status: 201, headers });
		} catch (err) {
			return Response.json({ error: deps.describeError(err) }, { status: 500, headers });
		}
	}

	if (path === "/api/runs/resume") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { root_issue_id?: unknown; max_steps?: unknown };
		try {
			body = (await request.json()) as { root_issue_id?: unknown; max_steps?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const rootIssueId = typeof body.root_issue_id === "string" ? body.root_issue_id.trim() : "";
		if (rootIssueId.length === 0) {
			return Response.json({ error: "root_issue_id is required" }, { status: 400, headers });
		}
		const maxSteps =
			typeof body.max_steps === "number" && Number.isFinite(body.max_steps)
				? Math.max(1, Math.trunc(body.max_steps))
				: undefined;
		try {
			const run = await deps.controlPlaneProxy.resumeRun?.({ rootIssueId, maxSteps });
			if (!run) {
				return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
			}
			await deps.registerAutoRunHeartbeatProgram(run as AutoHeartbeatRunSnapshot).catch(async (error) => {
				await deps.context.eventLog.emit("run.auto_heartbeat.lifecycle", {
					source: "mu-server.runs",
					payload: {
						action: "register_failed",
						run_job_id: run.job_id,
						error: deps.describeError(error),
					},
				});
			});
			return Response.json({ ok: true, run }, { status: 201, headers });
		} catch (err) {
			return Response.json({ error: deps.describeError(err) }, { status: 500, headers });
		}
	}

	if (path === "/api/runs/interrupt") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { root_issue_id?: unknown; job_id?: unknown };
		try {
			body = (await request.json()) as { root_issue_id?: unknown; job_id?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const rootIssueId = typeof body.root_issue_id === "string" ? body.root_issue_id.trim() : null;
		const jobId = typeof body.job_id === "string" ? body.job_id.trim() : null;
		const result = await deps.controlPlaneProxy.interruptRun?.({
			rootIssueId,
			jobId,
		});
		if (!result) {
			return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
		}
		if (!result.ok && result.reason === "not_running" && result.run) {
			await deps.disableAutoRunHeartbeatProgram({
				jobId: result.run.job_id,
				status: result.run.status,
				reason: "interrupt_not_running",
			}).catch(() => {
				// best effort cleanup only
			});
		}
		return Response.json(result, { status: result.ok ? 200 : 404, headers });
	}

	if (path === "/api/runs/heartbeat") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { root_issue_id?: unknown; job_id?: unknown; reason?: unknown; wake_mode?: unknown };
		try {
			body = (await request.json()) as {
				root_issue_id?: unknown;
				job_id?: unknown;
				reason?: unknown;
				wake_mode?: unknown;
			};
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const rootIssueId = typeof body.root_issue_id === "string" ? body.root_issue_id.trim() : null;
		const jobId = typeof body.job_id === "string" ? body.job_id.trim() : null;
		const reason = typeof body.reason === "string" ? body.reason.trim() : null;
		const wakeMode = normalizeWakeMode(body.wake_mode);
		const result = await deps.controlPlaneProxy.heartbeatRun?.({
			rootIssueId,
			jobId,
			reason,
			wakeMode,
		});
		if (!result) {
			return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
		}
		if (!result.ok && result.reason === "not_running" && result.run) {
			await deps.disableAutoRunHeartbeatProgram({
				jobId: result.run.job_id,
				status: result.run.status,
				reason: "run_not_running",
			}).catch(() => {
				// best effort cleanup only
			});
		}
		if (result.ok) {
			return Response.json(result, { status: 200, headers });
		}
		if (result.reason === "missing_target") {
			return Response.json(result, { status: 400, headers });
		}
		if (result.reason === "not_running") {
			return Response.json(result, { status: 409, headers });
		}
		return Response.json(result, { status: 404, headers });
	}

	if (path.startsWith("/api/runs/")) {
		const rest = path.slice("/api/runs/".length);
		const [rawId, maybeSub] = rest.split("/");
		const idOrRoot = decodeURIComponent(rawId ?? "").trim();
		if (idOrRoot.length === 0) {
			return Response.json({ error: "missing run id" }, { status: 400, headers });
		}
		if (maybeSub === "trace") {
			if (request.method !== "GET") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}
			const limitRaw = url.searchParams.get("limit");
			const limit =
				limitRaw && /^\d+$/.test(limitRaw)
					? Math.max(1, Math.min(2_000, Number.parseInt(limitRaw, 10)))
					: undefined;
			const trace = await deps.controlPlaneProxy.traceRun?.({ idOrRoot, limit });
			if (!trace) {
				return Response.json({ error: "run trace not found" }, { status: 404, headers });
			}
			return Response.json(trace, { headers });
		}
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const run = await deps.controlPlaneProxy.getRun?.(idOrRoot);
		if (!run) {
			return Response.json({ error: "run not found" }, { status: 404, headers });
		}
		if (run.status !== "running") {
			await deps.disableAutoRunHeartbeatProgram({
				jobId: run.job_id,
				status: run.status,
				reason: "run_terminal_snapshot",
			}).catch(() => {
				// best effort cleanup only
			});
		}
		return Response.json(run, { headers });
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
