import { CONTROL_PLANE_CHANNEL_ADAPTER_SPECS } from "@femtomc/mu-control-plane";
import type { MuConfig } from "../config.js";
import type { ServerRoutingDependencies } from "../server_routing.js";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function activeChannelsFromStatus(status: unknown): Set<string> {
	const record = asRecord(status);
	const adapters = Array.isArray(record?.adapters) ? record.adapters : [];
	const set = new Set<string>();
	for (const adapter of adapters) {
		if (typeof adapter === "string" && adapter.trim().length > 0) {
			set.add(adapter.trim());
		}
	}
	return set;
}

function configuredForChannel(config: MuConfig, channel: string): boolean {
	switch (channel) {
		case "slack":
			return typeof config.control_plane.adapters.slack.signing_secret === "string";
		case "discord":
			return typeof config.control_plane.adapters.discord.signing_secret === "string";
		case "telegram":
			return typeof config.control_plane.adapters.telegram.webhook_secret === "string";
		case "neovim":
			return typeof config.control_plane.adapters.neovim.shared_secret === "string";
		default:
			return false;
	}
}

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

	if (path === "/api/control-plane/channels") {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const [config, status] = await Promise.all([deps.loadConfigFromDisk(), Promise.resolve(deps.getControlPlaneStatus())]);
		const activeChannels = activeChannelsFromStatus(status);
		const channels = CONTROL_PLANE_CHANNEL_ADAPTER_SPECS.map((spec) => ({
			channel: spec.channel,
			route: spec.route,
			ingress_payload: spec.ingress_payload,
			verification: spec.verification,
			ack_format: spec.ack_format,
			delivery_semantics: spec.delivery_semantics,
			deferred_delivery: spec.deferred_delivery,
			configured: configuredForChannel(config, spec.channel),
			active: activeChannels.has(spec.channel),
			frontend: spec.channel === "neovim",
		}));

		return Response.json(
			{
				ok: true,
				generated_at_ms: Date.now(),
				channels,
			},
			{ headers },
		);
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
