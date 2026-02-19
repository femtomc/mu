import type { CronProgramTarget } from "../cron_programs.js";
import {
	cronScheduleInputFromBody,
	hasCronScheduleInput,
	parseCronTarget,
} from "../cron_request.js";
import type { ServerRoutingDependencies } from "../server_routing.js";
import { normalizeWakeMode } from "../server_types.js";

export async function cronRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	const path = url.pathname;

	if (path === "/api/cron/status") {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const status = await deps.cronPrograms.status();
		return Response.json(status, { headers });
	}

	if (path === "/api/cron") {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const enabledRaw = url.searchParams.get("enabled")?.trim().toLowerCase();
		const enabled = enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined;
		const targetKindRaw = url.searchParams.get("target_kind")?.trim().toLowerCase();
		const targetKind = targetKindRaw === "run" || targetKindRaw === "activity" ? targetKindRaw : undefined;
		const scheduleKindRaw = url.searchParams.get("schedule_kind")?.trim().toLowerCase();
		const scheduleKind =
			scheduleKindRaw === "at" || scheduleKindRaw === "every" || scheduleKindRaw === "cron"
				? scheduleKindRaw
				: undefined;
		const limitRaw = url.searchParams.get("limit");
		const limit =
			limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : undefined;
		const programs = await deps.cronPrograms.list({ enabled, targetKind, scheduleKind, limit });
		return Response.json({ count: programs.length, programs }, { headers });
	}

	if (path === "/api/cron/create") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const title = typeof body.title === "string" ? body.title.trim() : "";
		if (!title) {
			return Response.json({ error: "title is required" }, { status: 400, headers });
		}
		const parsedTarget = parseCronTarget(body);
		if (!parsedTarget.target) {
			return Response.json({ error: parsedTarget.error ?? "invalid target" }, { status: 400, headers });
		}
		if (!hasCronScheduleInput(body)) {
			return Response.json({ error: "schedule is required" }, { status: 400, headers });
		}
		const schedule = cronScheduleInputFromBody(body);
		const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;
		const wakeMode = normalizeWakeMode(body.wake_mode);
		const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
		try {
			const program = await deps.cronPrograms.create({
				title,
				target: parsedTarget.target,
				schedule,
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

	if (path === "/api/cron/update") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const programId = typeof body.program_id === "string" ? body.program_id.trim() : "";
		if (!programId) {
			return Response.json({ error: "program_id is required" }, { status: 400, headers });
		}
		let target: CronProgramTarget | undefined;
		if (typeof body.target_kind === "string") {
			const parsedTarget = parseCronTarget(body);
			if (!parsedTarget.target) {
				return Response.json({ error: parsedTarget.error ?? "invalid target" }, { status: 400, headers });
			}
			target = parsedTarget.target;
		}
		const schedule = hasCronScheduleInput(body) ? cronScheduleInputFromBody(body) : undefined;
		const wakeMode = Object.hasOwn(body, "wake_mode") ? normalizeWakeMode(body.wake_mode) : undefined;
		try {
			const result = await deps.cronPrograms.update({
				programId,
				title: typeof body.title === "string" ? body.title : undefined,
				reason: typeof body.reason === "string" ? body.reason : undefined,
				wakeMode,
				enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
				target,
				schedule,
				metadata:
					body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
						? (body.metadata as Record<string, unknown>)
						: undefined,
			});
			if (result.ok) {
				return Response.json(result, { headers });
			}
			if (result.reason === "not_found") {
				return Response.json(result, { status: 404, headers });
			}
			return Response.json(result, { status: 400, headers });
		} catch (err) {
			return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
		}
	}

	if (path === "/api/cron/delete") {
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
		const result = await deps.cronPrograms.remove(programId);
		return Response.json(result, { status: result.ok ? 200 : result.reason === "not_found" ? 404 : 400, headers });
	}

	if (path === "/api/cron/trigger") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { program_id?: unknown; reason?: unknown };
		try {
			body = (await request.json()) as { program_id?: unknown; reason?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const result = await deps.cronPrograms.trigger({
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

	if (path.startsWith("/api/cron/")) {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const id = decodeURIComponent(path.slice("/api/cron/".length)).trim();
		if (!id) {
			return Response.json({ error: "missing program id" }, { status: 400, headers });
		}
		const program = await deps.cronPrograms.get(id);
		if (!program) {
			return Response.json({ error: "program not found" }, { status: 404, headers });
		}
		return Response.json(program, { headers });
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
