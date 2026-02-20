import type { ControlPlaneActivityStatus } from "../activity_supervisor.js";
import type { ServerRoutingDependencies } from "../server_routing.js";

export async function activityRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	const path = url.pathname;

	if (path === "/api/control-plane/activities") {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const statusRaw = url.searchParams.get("status")?.trim().toLowerCase();
		const status =
			statusRaw === "running" || statusRaw === "completed" || statusRaw === "failed" || statusRaw === "cancelled"
				? (statusRaw as ControlPlaneActivityStatus)
				: undefined;
		const kind = url.searchParams.get("kind")?.trim() || undefined;
		const limitRaw = url.searchParams.get("limit");
		const limit =
			limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : undefined;
		const activities = deps.activitySupervisor.list({ status, kind, limit });
		return Response.json({ count: activities.length, activities }, { headers });
	}

	if (path === "/api/control-plane/activities/start") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: {
			title?: unknown;
			kind?: unknown;
			heartbeat_every_ms?: unknown;
			metadata?: unknown;
			source?: unknown;
		};
		try {
			body = (await request.json()) as {
				title?: unknown;
				kind?: unknown;
				heartbeat_every_ms?: unknown;
				metadata?: unknown;
				source?: unknown;
			};
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const title = typeof body.title === "string" ? body.title.trim() : "";
		if (!title) {
			return Response.json({ error: "title is required" }, { status: 400, headers });
		}
		const kind = typeof body.kind === "string" ? body.kind.trim() : undefined;
		const heartbeatEveryMs =
			typeof body.heartbeat_every_ms === "number" && Number.isFinite(body.heartbeat_every_ms)
				? Math.max(0, Math.trunc(body.heartbeat_every_ms))
				: undefined;
		const source =
			body.source === "api" || body.source === "command" || body.source === "system" ? body.source : "api";
		try {
			const activity = deps.activitySupervisor.start({
				title,
				kind,
				heartbeatEveryMs,
				metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
				source,
			});
			return Response.json({ ok: true, activity }, { status: 201, headers });
		} catch (err) {
			return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
		}
	}

	if (path === "/api/control-plane/activities/progress") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { activity_id?: unknown; message?: unknown };
		try {
			body = (await request.json()) as { activity_id?: unknown; message?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const result = deps.activitySupervisor.progress({
			activityId: typeof body.activity_id === "string" ? body.activity_id : null,
			message: typeof body.message === "string" ? body.message : null,
		});
		if (result.ok) {
			return Response.json(result, { headers });
		}
		if (result.reason === "missing_target") {
			return Response.json(result, { status: 400, headers });
		}
		if (result.reason === "not_running") {
			return Response.json(result, { status: 409, headers });
		}
		return Response.json(result, { status: 404, headers });
	}

	if (path === "/api/control-plane/activities/heartbeat") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { activity_id?: unknown; reason?: unknown };
		try {
			body = (await request.json()) as { activity_id?: unknown; reason?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const result = deps.activitySupervisor.heartbeat({
			activityId: typeof body.activity_id === "string" ? body.activity_id : null,
			reason: typeof body.reason === "string" ? body.reason : null,
		});
		if (result.ok) {
			return Response.json(result, { headers });
		}
		if (result.reason === "missing_target") {
			return Response.json(result, { status: 400, headers });
		}
		if (result.reason === "not_running") {
			return Response.json(result, { status: 409, headers });
		}
		return Response.json(result, { status: 404, headers });
	}

	if (path === "/api/control-plane/activities/complete" || path === "/api/control-plane/activities/fail" || path === "/api/control-plane/activities/cancel") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { activity_id?: unknown; message?: unknown };
		try {
			body = (await request.json()) as { activity_id?: unknown; message?: unknown };
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const activityId = typeof body.activity_id === "string" ? body.activity_id : null;
		const message = typeof body.message === "string" ? body.message : null;
		const result =
			path === "/api/control-plane/activities/complete"
				? deps.activitySupervisor.complete({ activityId, message })
				: path === "/api/control-plane/activities/fail"
					? deps.activitySupervisor.fail({ activityId, message })
					: deps.activitySupervisor.cancel({ activityId, message });
		if (result.ok) {
			return Response.json(result, { headers });
		}
		if (result.reason === "missing_target") {
			return Response.json(result, { status: 400, headers });
		}
		if (result.reason === "not_running") {
			return Response.json(result, { status: 409, headers });
		}
		return Response.json(result, { status: 404, headers });
	}

	if (path.startsWith("/api/control-plane/activities/")) {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const rest = path.slice("/api/control-plane/activities/".length);
		const [rawId, maybeSub] = rest.split("/");
		const activityId = decodeURIComponent(rawId ?? "").trim();
		if (activityId.length === 0) {
			return Response.json({ error: "missing activity id" }, { status: 400, headers });
		}
		if (maybeSub === "events") {
			const limitRaw = url.searchParams.get("limit");
			const limit =
				limitRaw && /^\d+$/.test(limitRaw)
					? Math.max(1, Math.min(2_000, Number.parseInt(limitRaw, 10)))
					: undefined;
			const events = deps.activitySupervisor.events(activityId, { limit });
			if (!events) {
				return Response.json({ error: "activity not found" }, { status: 404, headers });
			}
			return Response.json({ count: events.length, events }, { headers });
		}
		const activity = deps.activitySupervisor.get(activityId);
		if (!activity) {
			return Response.json({ error: "activity not found" }, { status: 404, headers });
		}
		return Response.json(activity, { headers });
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
