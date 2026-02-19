import {
	getControlPlanePaths,
	IdentityStore,
	ROLE_SCOPES,
} from "@femtomc/mu-control-plane";
import type { ServerRoutingDependencies } from "../server_routing.js";

export async function identityRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	const path = url.pathname;
	const cpPaths = getControlPlanePaths(deps.context.repoRoot);
	const identityStore = new IdentityStore(cpPaths.identitiesPath);
	await identityStore.load();

	if (path === "/api/identities") {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const includeInactive = url.searchParams.get("include_inactive")?.trim().toLowerCase() === "true";
		const bindings = identityStore.listBindings({ includeInactive });
		return Response.json({ count: bindings.length, bindings }, { headers });
	}

	if (path === "/api/identities/link") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: {
			channel?: unknown;
			actor_id?: unknown;
			tenant_id?: unknown;
			role?: unknown;
			operator_id?: unknown;
			binding_id?: unknown;
		};
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const channel = typeof body.channel === "string" ? body.channel.trim() : "";
		if (
			!channel ||
			(channel !== "slack" &&
				channel !== "discord" &&
				channel !== "telegram" &&
				channel !== "neovim" &&
				channel !== "vscode")
		) {
			return Response.json(
				{ error: "channel is required (slack, discord, telegram, neovim, vscode)" },
				{ status: 400, headers },
			);
		}
		const actorId = typeof body.actor_id === "string" ? body.actor_id.trim() : "";
		if (!actorId) {
			return Response.json({ error: "actor_id is required" }, { status: 400, headers });
		}
		const tenantId = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "";
		if (!tenantId) {
			return Response.json({ error: "tenant_id is required" }, { status: 400, headers });
		}
		const roleKey = typeof body.role === "string" ? body.role.trim() : "operator";
		const roleScopes = ROLE_SCOPES[roleKey];
		if (!roleScopes) {
			return Response.json(
				{ error: `invalid role: ${roleKey} (operator, contributor, viewer)` },
				{ status: 400, headers },
			);
		}
		const bindingId =
			typeof body.binding_id === "string" && body.binding_id.trim().length > 0
				? body.binding_id.trim()
				: `bind-${crypto.randomUUID()}`;
		const operatorId =
			typeof body.operator_id === "string" && body.operator_id.trim().length > 0
				? body.operator_id.trim()
				: "default";

		const decision = await identityStore.link({
			bindingId,
			operatorId,
			channel: channel as "slack" | "discord" | "telegram" | "neovim" | "vscode",
			channelTenantId: tenantId,
			channelActorId: actorId,
			scopes: [...roleScopes],
		});
		switch (decision.kind) {
			case "linked":
				return Response.json(
					{ ok: true, kind: "linked", binding: decision.binding },
					{ status: 201, headers },
				);
			case "binding_exists":
				return Response.json(
					{ ok: false, kind: "binding_exists", binding: decision.binding },
					{ status: 409, headers },
				);
			case "principal_already_linked":
				return Response.json(
					{ ok: false, kind: "principal_already_linked", binding: decision.binding },
					{ status: 409, headers },
				);
		}
	}

	if (path === "/api/identities/unlink") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: { binding_id?: unknown; actor_binding_id?: unknown; reason?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const bindingId = typeof body.binding_id === "string" ? body.binding_id.trim() : "";
		if (!bindingId) {
			return Response.json({ error: "binding_id is required" }, { status: 400, headers });
		}
		const actorBindingId = typeof body.actor_binding_id === "string" ? body.actor_binding_id.trim() : "";
		if (!actorBindingId) {
			return Response.json({ error: "actor_binding_id is required" }, { status: 400, headers });
		}
		const reason = typeof body.reason === "string" ? body.reason.trim() : null;

		const decision = await identityStore.unlinkSelf({
			bindingId,
			actorBindingId,
			reason: reason || null,
		});
		switch (decision.kind) {
			case "unlinked":
				return Response.json({ ok: true, kind: "unlinked", binding: decision.binding }, { headers });
			case "not_found":
				return Response.json({ ok: false, kind: "not_found" }, { status: 404, headers });
			case "invalid_actor":
				return Response.json({ ok: false, kind: "invalid_actor" }, { status: 403, headers });
			case "already_inactive":
				return Response.json(
					{ ok: false, kind: "already_inactive", binding: decision.binding },
					{ status: 409, headers },
				);
		}
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
