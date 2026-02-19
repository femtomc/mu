import type { ServerRoutingDependencies } from "../server_routing.js";

export async function controlPlaneRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	const path = url.pathname;

	if (path === "/api/control-plane/reload") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}

		let reason = "api_control_plane_reload";
		try {
			const body = (await request.json()) as { reason?: unknown };
			if (typeof body.reason === "string" && body.reason.trim().length > 0) {
				reason = body.reason.trim();
			}
		} catch {
			// ignore invalid body for reason
		}

		const result = await deps.reloadControlPlane(reason);
		return Response.json(result, { status: result.ok ? 200 : 500, headers });
	}

	if (path === "/api/control-plane/rollback") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const result = await deps.reloadControlPlane("rollback");
		return Response.json(result, { status: result.ok ? 200 : 500, headers });
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
