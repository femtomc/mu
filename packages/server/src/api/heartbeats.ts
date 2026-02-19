import type { HeartbeatProgramTarget } from "../heartbeat_programs.js";
import type { ServerRoutingDependencies } from "../server_routing.js";
import { normalizeWakeMode } from "../server_types.js";

export async function heartbeatRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	const path = url.pathname;

	if (path === "/api/heartbeats") {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const enabledRaw = url.searchParams.get("enabled")?.trim().toLowerCase();
		const enabled = enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined;
		const targetKindRaw = url.searchParams.get("target_kind")?.trim().toLowerCase();
		const targetKind = targetKindRaw === "run" || targetKindRaw === "activity" ? targetKindRaw : undefined;
		const limitRaw = url.searchParams.get("limit");
		const limit =
			limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : undefined;
		const programs = await deps.heartbeatPrograms.list({ enabled, targetKind, limit });
		return Response.json({ count: programs.length, programs }, { headers });
	}

	if (path === "/api/heartbeats/create") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: {
			title?: unknown;
			target_kind?: unknown;
			run_job_id?: unknown;
			run_root_issue_id?: unknown;
			activity_id?: unknown;
			every_ms?: unknown;
			reason?: unknown;
			wake_mode?: unknown;
			enabled?: unknown;
			metadata?: unknown;
		};
		try {
			body = (await request.json()) as {
				title?: unknown;
				target_kind?: unknown;
				run_job_id?: unknown;
				run_root_issue_id?: unknown;
				activity_id?: unknown;
				every_ms?: unknown;
				reason?: unknown;
				wake_mode?: unknown;
				enabled?: unknown;
				metadata?: unknown;
			};
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const title = typeof body.title === "string" ? body.title.trim() : "";
		if (!title) {
			return Response.json({ error: "title is required" }, { status: 400, headers });
		}
		const targetKind = typeof body.target_kind === "string" ? body.target_kind.trim().toLowerCase() : "";
		let target: HeartbeatProgramTarget | null = null;
		if (targetKind === "run") {
			const jobId = typeof body.run_job_id === "string" ? body.run_job_id.trim() : "";
			const rootIssueId = typeof body.run_root_issue_id === "string" ? body.run_root_issue_id.trim() : "";
			if (!jobId && !rootIssueId) {
				return Response.json(
					{ error: "run target requires run_job_id or run_root_issue_id" },
					{ status: 400, headers },
				);
			}
			target = {
				kind: "run",
				job_id: jobId || null,
				root_issue_id: rootIssueId || null,
			};
		} else if (targetKind === "activity") {
			const activityId = typeof body.activity_id === "string" ? body.activity_id.trim() : "";
			if (!activityId) {
				return Response.json({ error: "activity target requires activity_id" }, { status: 400, headers });
			}
			target = {
				kind: "activity",
				activity_id: activityId,
			};
		} else {
			return Response.json({ error: "target_kind must be run or activity" }, { status: 400, headers });
		}
		const everyMs =
			typeof body.every_ms === "number" && Number.isFinite(body.every_ms)
				? Math.max(0, Math.trunc(body.every_ms))
				: undefined;
		const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;
		const wakeMode = normalizeWakeMode(body.wake_mode);
		const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
		try {
			const program = await deps.heartbeatPrograms.create({
				title,
				target,
				everyMs,
				reason,
				wakeMode,
				enabled,
				metadata:
					body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
						? (body.metadata as Record<string, unknown>)
						: undefined,
			});
			return Response.json({ ok: true, program }, { status: 201, headers });
		} catch (err) {
			return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
		}
	}

	if (path === "/api/heartbeats/update") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: {
			program_id?: unknown;
			title?: unknown;
			target_kind?: unknown;
			run_job_id?: unknown;
			run_root_issue_id?: unknown;
			activity_id?: unknown;
			every_ms?: unknown;
			reason?: unknown;
			wake_mode?: unknown;
			enabled?: unknown;
			metadata?: unknown;
		};
		try {
			body = (await request.json()) as {
				program_id?: unknown;
				title?: unknown;
				target_kind?: unknown;
				run_job_id?: unknown;
				run_root_issue_id?: unknown;
				activity_id?: unknown;
				every_ms?: unknown;
				reason?: unknown;
				wake_mode?: unknown;
				enabled?: unknown;
				metadata?: unknown;
			};
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const programId = typeof body.program_id === "string" ? body.program_id.trim() : "";
		if (!programId) {
			return Response.json({ error: "program_id is required" }, { status: 400, headers });
		}
		let target: HeartbeatProgramTarget | undefined;
		if (typeof body.target_kind === "string") {
			const targetKind = body.target_kind.trim().toLowerCase();
			if (targetKind === "run") {
				const jobId = typeof body.run_job_id === "string" ? body.run_job_id.trim() : "";
				const rootIssueId = typeof body.run_root_issue_id === "string" ? body.run_root_issue_id.trim() : "";
				if (!jobId && !rootIssueId) {
					return Response.json(
						{ error: "run target requires run_job_id or run_root_issue_id" },
						{ status: 400, headers },
					);
				}
				target = {
					kind: "run",
					job_id: jobId || null,
					root_issue_id: rootIssueId || null,
				};
			} else if (targetKind === "activity") {
				const activityId = typeof body.activity_id === "string" ? body.activity_id.trim() : "";
				if (!activityId) {
					return Response.json({ error: "activity target requires activity_id" }, { status: 400, headers });
				}
				target = {
					kind: "activity",
					activity_id: activityId,
				};
			} else {
				return Response.json({ error: "target_kind must be run or activity" }, { status: 400, headers });
			}
		}
		const wakeMode = Object.hasOwn(body, "wake_mode") ? normalizeWakeMode(body.wake_mode) : undefined;
		try {
			const result = await deps.heartbeatPrograms.update({
				programId,
				title: typeof body.title === "string" ? body.title : undefined,
				target,
				everyMs:
					typeof body.every_ms === "number" && Number.isFinite(body.every_ms)
						? Math.max(0, Math.trunc(body.every_ms))
						: undefined,
				reason: typeof body.reason === "string" ? body.reason : undefined,
				wakeMode,
				enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
				metadata:
					body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
						? (body.metadata as Record<string, unknown>)
						: undefined,
			});
			if (result.ok) {
				return Response.json(result, { headers });
			}
			return Response.json(result, { status: result.reason === "not_found" ? 404 : 400, headers });
		} catch (err) {
			return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
		}
	}

	if (path === "/api/heartbeats/delete") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { program_id?: unknown };
		try {
			body = (await request.json()) as { program_id?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const programId = typeof body.program_id === "string" ? body.program_id.trim() : "";
		if (!programId) {
			return Response.json({ error: "program_id is required" }, { status: 400, headers });
		}
		const result = await deps.heartbeatPrograms.remove(programId);
		return Response.json(result, { status: result.ok ? 200 : result.reason === "not_found" ? 404 : 400, headers });
	}

	if (path === "/api/heartbeats/trigger") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { program_id?: unknown; reason?: unknown };
		try {
			body = (await request.json()) as { program_id?: unknown; reason?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const result = await deps.heartbeatPrograms.trigger({
			programId: typeof body.program_id === "string" ? body.program_id : null,
			reason: typeof body.reason === "string" ? body.reason : null,
		});
		if (result.ok) {
			return Response.json(result, { headers });
		}
		if (result.reason === "missing_target") {
			return Response.json(result, { status: 400, headers });
		}
		if (result.reason === "not_found") {
			return Response.json(result, { status: 404, headers });
		}
		return Response.json(result, { status: 409, headers });
	}

	if (path.startsWith("/api/heartbeats/")) {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const id = decodeURIComponent(path.slice("/api/heartbeats/".length)).trim();
		if (!id) {
			return Response.json({ error: "missing program id" }, { status: 400, headers });
		}
		const program = await deps.heartbeatPrograms.get(id);
		if (!program) {
			return Response.json({ error: "program not found" }, { status: 404, headers });
		}
		return Response.json(program, { headers });
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
