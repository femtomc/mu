import { extname, join, resolve } from "node:path";
import {
	type CommandPipelineResult,
	getControlPlanePaths,
	IdentityStore,
	ROLE_SCOPES,
} from "@femtomc/mu-control-plane";
import { type ControlPlaneActivityStatus, type ControlPlaneActivitySupervisor } from "./activity_supervisor.js";
import { eventRoutes } from "./api/events.js";
import { forumRoutes } from "./api/forum.js";
import { issueRoutes } from "./api/issues.js";
import {
	applyMuConfigPatch,
	getMuConfigPath,
	type MuConfig,
	muConfigPresence,
	redactMuConfigSecrets,
} from "./config.js";
import type { ControlPlaneHandle } from "./control_plane_contract.js";
import {
	cronScheduleInputFromBody,
	hasCronScheduleInput,
	parseCronTarget,
} from "./cron_request.js";
import type { CronProgramRegistry, CronProgramTarget } from "./cron_programs.js";
import type { HeartbeatProgramRegistry, HeartbeatProgramTarget } from "./heartbeat_programs.js";
import type { AutoHeartbeatRunSnapshot } from "./server_program_orchestration.js";
import { normalizeWakeMode } from "./server_types.js";
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

	if (path === "/api/config") {
		if (request.method === "GET") {
			try {
				const config = await deps.loadConfigFromDisk();
				return Response.json(
					{
						repo_root: deps.context.repoRoot,
						config_path: getMuConfigPath(deps.context.repoRoot),
						config: redactMuConfigSecrets(config),
						presence: muConfigPresence(config),
					},
					{ headers },
				);
			} catch (err) {
				return Response.json(
					{ error: `failed to read config: ${deps.describeError(err)}` },
					{ status: 500, headers },
				);
			}
		}

		if (request.method === "POST") {
			let body: { patch?: unknown };
			try {
				body = (await request.json()) as { patch?: unknown };
			} catch {
				return Response.json({ error: "invalid json body" }, { status: 400, headers });
			}

			if (!body || !("patch" in body)) {
				return Response.json({ error: "missing patch payload" }, { status: 400, headers });
			}

			try {
				const base = await deps.loadConfigFromDisk();
				const next = applyMuConfigPatch(base, body.patch);
				const configPath = await deps.writeConfig(deps.context.repoRoot, next);
				return Response.json(
					{
						ok: true,
						repo_root: deps.context.repoRoot,
						config_path: configPath,
						config: redactMuConfigSecrets(next),
						presence: muConfigPresence(next),
					},
					{ headers },
				);
			} catch (err) {
				return Response.json(
					{ error: `failed to write config: ${deps.describeError(err)}` },
					{ status: 500, headers },
				);
			}
		}

		return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
	}

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

	if (path === "/api/activities") {
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

	if (path === "/api/activities/start") {
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

	if (path === "/api/activities/progress") {
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

	if (path === "/api/activities/heartbeat") {
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

	if (path === "/api/activities/complete" || path === "/api/activities/fail" || path === "/api/activities/cancel") {
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
			path === "/api/activities/complete"
				? deps.activitySupervisor.complete({ activityId, message })
				: path === "/api/activities/fail"
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

	if (path.startsWith("/api/activities/")) {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const rest = path.slice("/api/activities/".length);
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

	if (path === "/api/identities" || path === "/api/identities/link" || path === "/api/identities/unlink") {
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
			if (!channel || (channel !== "slack" && channel !== "discord" && channel !== "telegram")) {
				return Response.json(
					{ error: "channel is required (slack, discord, telegram)" },
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
				channel: channel as "slack" | "discord" | "telegram",
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
