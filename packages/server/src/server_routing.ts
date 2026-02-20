import { controlPlaneRoutes } from "./api/control_plane.js";
import { cronRoutes } from "./api/cron.js";
import { heartbeatRoutes } from "./api/heartbeats.js";
import type { MuConfig } from "./config.js";
import type { ControlPlaneHandle } from "./control_plane_contract.js";
import type { CronProgramRegistry } from "./cron_programs.js";
import type { HeartbeatProgramRegistry } from "./heartbeat_programs.js";
import type { ServerContext } from "./server.js";

export type ServerRoutingDependencies = {
	context: ServerContext;
	controlPlaneProxy: ControlPlaneHandle;
	heartbeatPrograms: HeartbeatProgramRegistry;
	cronPrograms: CronProgramRegistry;
	loadConfigFromDisk: () => Promise<MuConfig>;
	writeConfig: (repoRoot: string, config: MuConfig) => Promise<string>;
	reloadControlPlane: (reason: string) => Promise<{ ok: boolean }>;
	getControlPlaneStatus: () => unknown;
	describeError: (error: unknown) => string;
	initiateShutdown?: () => Promise<void>;
};

export function createServerRequestHandler(deps: ServerRoutingDependencies) {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;

		const headers = new Headers({
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		});

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers });
		}

		if (path === "/healthz" || path === "/health") {
			return new Response("ok", { status: 200, headers });
		}

		if (path === "/api/server/shutdown") {
			if (request.method !== "POST") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}
			if (!deps.initiateShutdown) {
				return Response.json({ error: "shutdown not supported" }, { status: 501, headers });
			}
			const shutdown = deps.initiateShutdown;
			setTimeout(() => {
				void shutdown();
			}, 100);
			return Response.json({ ok: true, message: "shutdown initiated" }, { headers });
		}

		if (path === "/api/control-plane" || path.startsWith("/api/control-plane/")) {
			return controlPlaneRoutes(request, url, deps, headers);
		}

		if (path === "/api/cron" || path.startsWith("/api/cron/")) {
			return cronRoutes(request, url, deps, headers);
		}

		if (path === "/api/heartbeats" || path.startsWith("/api/heartbeats/")) {
			return heartbeatRoutes(request, url, deps, headers);
		}

		if (path.startsWith("/webhooks/")) {
			const response = await deps.controlPlaneProxy.handleWebhook(path, request);
			if (response) {
				headers.forEach((value, key) => {
					response.headers.set(key, value);
				});
				return response;
			}
			return new Response("Not Found", { status: 404, headers });
		}

		if (path.startsWith("/api/")) {
			return Response.json({ error: "Not Found" }, { status: 404, headers });
		}

		return new Response("Not Found", { status: 404, headers });
	};
}
