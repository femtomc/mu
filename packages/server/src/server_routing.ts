import { extname, join, resolve } from "node:path";
import type { CommandPipelineResult } from "@femtomc/mu-control-plane";
import type { ControlPlaneActivitySupervisor } from "./activity_supervisor.js";
import { activityRoutes } from "./api/activities.js";
import { configRoutes } from "./api/config.js";
import { controlPlaneRoutes } from "./api/control_plane.js";
import { cronRoutes } from "./api/cron.js";
import { eventRoutes } from "./api/events.js";
import { forumRoutes } from "./api/forum.js";
import { heartbeatRoutes } from "./api/heartbeats.js";
import { identityRoutes } from "./api/identities.js";
import { issueRoutes } from "./api/issues.js";
import { runRoutes } from "./api/runs.js";
import type { MuConfig } from "./config.js";
import type { ControlPlaneHandle } from "./control_plane_contract.js";
import type { CronProgramRegistry } from "./cron_programs.js";
import type { HeartbeatProgramRegistry } from "./heartbeat_programs.js";
import type { AutoHeartbeatRunSnapshot } from "./server_program_orchestration.js";
import type { ServerContext } from "./server.js";

const DEFAULT_MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

const DEFAULT_PUBLIC_DIR = join(new URL(".", import.meta.url).pathname, "..", "public");

export type ServerRoutingDependencies = {
	context: ServerContext;
	controlPlaneProxy: ControlPlaneHandle;
	activitySupervisor: ControlPlaneActivitySupervisor;
	heartbeatPrograms: HeartbeatProgramRegistry;
	cronPrograms: CronProgramRegistry;
	loadConfigFromDisk: () => Promise<MuConfig>;
	writeConfig: (repoRoot: string, config: MuConfig) => Promise<string>;
	reloadControlPlane: (reason: string) => Promise<{ ok: boolean }>;
	getControlPlaneStatus: () => unknown;
	registerAutoRunHeartbeatProgram: (run: AutoHeartbeatRunSnapshot) => Promise<void>;
	disableAutoRunHeartbeatProgram: (opts: { jobId: string; status: string; reason: string }) => Promise<void>;
	describeError: (error: unknown) => string;
	initiateShutdown?: () => Promise<void>;
	publicDir?: string;
	mimeTypes?: Record<string, string>;
};

export function createServerRequestHandler(deps: ServerRoutingDependencies) {
	const publicDir = deps.publicDir ?? DEFAULT_PUBLIC_DIR;
	const mimeTypes = deps.mimeTypes ?? DEFAULT_MIME_TYPES;
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
		// Respond before shutting down so the client receives the response.
		setTimeout(() => { void shutdown(); }, 100);
		return Response.json({ ok: true, message: "shutdown initiated" }, { headers });
	}

	if (path === "/api/config") {
		return configRoutes(request, url, deps, headers);
	}

	if (path === "/api/control-plane/reload" || path === "/api/control-plane/rollback") {
		return controlPlaneRoutes(request, url, deps, headers);
	}

	if (path === "/api/status") {
		const issues = await deps.context.issueStore.list();
		const openIssues = issues.filter((i) => i.status === "open");
		const readyIssues = await deps.context.issueStore.ready();
		const controlPlane = deps.getControlPlaneStatus();

		return Response.json(
			{
				repo_root: deps.context.repoRoot,
				open_count: openIssues.length,
				ready_count: readyIssues.length,
				control_plane: controlPlane,
			},
			{ headers },
		);
	}

	if (path === "/api/commands/submit") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const kind = typeof body.kind === "string" ? body.kind.trim() : "";
		if (!kind) {
			return Response.json({ error: "kind is required" }, { status: 400, headers });
		}

		let commandText: string;
		switch (kind) {
			case "run_start": {
				const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
				if (!prompt) {
					return Response.json({ error: "prompt is required for run_start" }, { status: 400, headers });
				}
				const maxStepsSuffix =
					typeof body.max_steps === "number" && Number.isFinite(body.max_steps)
						? ` --max-steps ${Math.max(1, Math.trunc(body.max_steps))}`
						: "";
				commandText = `mu! run start ${prompt}${maxStepsSuffix}`;
				break;
			}
			case "run_resume": {
				const rootId = typeof body.root_issue_id === "string" ? body.root_issue_id.trim() : "";
				const maxSteps =
					typeof body.max_steps === "number" && Number.isFinite(body.max_steps)
						? ` ${Math.max(1, Math.trunc(body.max_steps))}`
						: "";
				commandText = `mu! run resume${rootId ? ` ${rootId}` : ""}${maxSteps}`;
				break;
			}
			case "run_interrupt": {
				const rootId = typeof body.root_issue_id === "string" ? body.root_issue_id.trim() : "";
				commandText = `mu! run interrupt${rootId ? ` ${rootId}` : ""}`;
				break;
			}
			case "reload":
				commandText = "/mu reload";
				break;
			case "update":
				commandText = "/mu update";
				break;
			case "status":
				commandText = "/mu status";
				break;
			case "issue_list":
				commandText = "/mu issue list";
				break;
			case "issue_get": {
				const issueId = typeof body.issue_id === "string" ? body.issue_id.trim() : "";
				commandText = `/mu issue get${issueId ? ` ${issueId}` : ""}`;
				break;
			}
			case "forum_read": {
				const topic = typeof body.topic === "string" ? body.topic.trim() : "";
				const limit =
					typeof body.limit === "number" && Number.isFinite(body.limit)
						? ` ${Math.max(1, Math.trunc(body.limit))}`
						: "";
				commandText = `/mu forum read${topic ? ` ${topic}` : ""}${limit}`;
				break;
			}
			case "run_list":
				commandText = "/mu run list";
				break;
			case "run_status": {
				const rootId = typeof body.root_issue_id === "string" ? body.root_issue_id.trim() : "";
				commandText = `/mu run status${rootId ? ` ${rootId}` : ""}`;
				break;
			}
			case "ready":
				commandText = "/mu ready";
				break;
			default:
				return Response.json({ error: `unknown command kind: ${kind}` }, { status: 400, headers });
		}

		try {
			if (!deps.controlPlaneProxy.submitTerminalCommand) {
				return Response.json({ error: "control plane not available" }, { status: 503, headers });
			}
			const result: CommandPipelineResult = await deps.controlPlaneProxy.submitTerminalCommand({
				commandText,
				repoRoot: deps.context.repoRoot,
			});
			return Response.json({ ok: true, result }, { headers });
		} catch (err) {
			return Response.json(
				{ error: `command failed: ${deps.describeError(err)}` },
				{ status: 500, headers },
			);
		}
	}

	if (path === "/api/runs" || path.startsWith("/api/runs/")) {
		return runRoutes(request, url, deps, headers);
	}

	if (path === "/api/cron" || path.startsWith("/api/cron/")) {
		return cronRoutes(request, url, deps, headers);
	}

	if (path === "/api/heartbeats" || path.startsWith("/api/heartbeats/")) {
		return heartbeatRoutes(request, url, deps, headers);
	}

	if (path === "/api/activities" || path.startsWith("/api/activities/")) {
		return activityRoutes(request, url, deps, headers);
	}

	if (path === "/api/identities" || path === "/api/identities/link" || path === "/api/identities/unlink") {
		return identityRoutes(request, url, deps, headers);
	}

	if (path.startsWith("/api/issues")) {
		const response = await issueRoutes(request, deps.context);
		headers.forEach((value, key) => {
			response.headers.set(key, value);
		});
		return response;
	}

	if (path.startsWith("/api/forum")) {
		const response = await forumRoutes(request, deps.context);
		headers.forEach((value, key) => {
			response.headers.set(key, value);
		});
		return response;
	}

	if (path.startsWith("/api/events")) {
		const response = await eventRoutes(request, deps.context);
		headers.forEach((value, key) => {
			response.headers.set(key, value);
		});
		return response;
	}

	if (path.startsWith("/webhooks/")) {
		const response = await deps.controlPlaneProxy.handleWebhook(path, request);
		if (response) {
			headers.forEach((value, key) => {
				response.headers.set(key, value);
			});
			return response;
		}
	}

	const filePath = resolve(publicDir, `.${path === "/" ? "/index.html" : path}`);
	if (!filePath.startsWith(publicDir)) {
		return new Response("Forbidden", { status: 403, headers });
	}

	const file = Bun.file(filePath);
	if (await file.exists()) {
		const ext = extname(filePath);
		const mime = mimeTypes[ext] ?? "application/octet-stream";
		headers.set("Content-Type", mime);
		return new Response(await file.arrayBuffer(), { status: 200, headers });
	}

	const indexPath = join(publicDir, "index.html");
	const indexFile = Bun.file(indexPath);
	if (await indexFile.exists()) {
		headers.set("Content-Type", "text/html; charset=utf-8");
		return new Response(await indexFile.arrayBuffer(), { status: 200, headers });
	}

	return new Response("Not Found", { status: 404, headers });
};
}
