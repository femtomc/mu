import { extname, join, resolve } from "node:path";
import type { CommandPipelineResult } from "@femtomc/mu-control-plane";
import type { ControlPlaneActivitySupervisor } from "./activity_supervisor.js";
import { activityRoutes } from "./api/activities.js";
import { configRoutes } from "./api/config.js";
import { contextRoutes } from "./api/context.js";
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
import { cronScheduleInputFromBody, hasCronScheduleInput, parseCronTarget } from "./cron_request.js";
import type { CronProgramRegistry, CronProgramTarget } from "./cron_programs.js";
import type { HeartbeatProgramRegistry, HeartbeatProgramTarget } from "./heartbeat_programs.js";
import type { AutoHeartbeatRunSnapshot } from "./server_program_orchestration.js";
import type { ServerContext } from "./server.js";
import { normalizeWakeMode } from "./server_types.js";

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

function readTrimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function readIntOrNull(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
		return null;
	}
	return Math.trunc(value);
}

function readFiniteNumberOrNull(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function parseOptionalBoolean(value: unknown): { ok: boolean; value: boolean | null } {
	if (value == null) {
		return { ok: true, value: null };
	}
	if (typeof value === "boolean") {
		return { ok: true, value };
	}
	return { ok: false, value: null };
}

function readCommaList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter((item) => item.length > 0);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	return [];
}

function parseHeartbeatTarget(body: Record<string, unknown>): {
	target: HeartbeatProgramTarget | null;
	error: string | null;
} {
	const targetKind = readTrimmedString(body.target_kind).toLowerCase();
	if (targetKind === "run") {
		const jobId = readTrimmedString(body.run_job_id);
		const rootIssueId = readTrimmedString(body.run_root_issue_id);
		if (!jobId && !rootIssueId) {
			return {
				target: null,
				error: "run target requires run_job_id or run_root_issue_id",
			};
		}
		return {
			target: {
				kind: "run",
				job_id: jobId || null,
				root_issue_id: rootIssueId || null,
			},
			error: null,
		};
	}
	if (targetKind === "activity") {
		const activityId = readTrimmedString(body.activity_id);
		if (!activityId) {
			return {
				target: null,
				error: "activity target requires activity_id",
			};
		}
		return {
			target: {
				kind: "activity",
				activity_id: activityId,
			},
			error: null,
		};
	}
	return {
		target: null,
		error: "target_kind must be run or activity",
	};
}

function commandProgramFailureStatus(reason: string | null): number {
	if (reason === "not_found") {
		return 404;
	}
	if (reason === "missing_target" || reason === "invalid_target" || reason === "invalid_schedule") {
		return 400;
	}
	if (reason === "not_running" || reason === "failed") {
		return 409;
	}
	return 400;
}

function commandCompletedResponse(headers: Headers, targetType: string, result: Record<string, unknown>): Response {
	return Response.json(
		{
			ok: true,
			result: {
				kind: "completed",
				command: {
					target_type: targetType,
					result,
				},
			},
		},
		{ headers },
	);
}

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

		let commandText: string | null = null;
		switch (kind) {
			case "run_start": {
				const prompt = readTrimmedString(body.prompt);
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
				const rootId = readTrimmedString(body.root_issue_id);
				const maxSteps =
					typeof body.max_steps === "number" && Number.isFinite(body.max_steps)
						? ` ${Math.max(1, Math.trunc(body.max_steps))}`
						: "";
				commandText = `mu! run resume${rootId ? ` ${rootId}` : ""}${maxSteps}`;
				break;
			}
			case "run_interrupt": {
				const rootId = readTrimmedString(body.root_issue_id);
				commandText = `mu! run interrupt${rootId ? ` ${rootId}` : ""}`;
				break;
			}
			case "reload":
				commandText = "/mu reload";
				break;
			case "update":
				commandText = "/mu update";
				break;
			case "issue_create": {
				const title = readTrimmedString(body.title);
				if (!title) {
					return Response.json({ error: "title is required for issue_create" }, { status: 400, headers });
				}
				const issueBody = typeof body.body === "string" ? body.body : undefined;
				const tags = readCommaList(body.tags);
				const priority = readIntOrNull(body.priority);
				if (body.priority != null && priority == null) {
					return Response.json({ error: "priority must be an integer" }, { status: 400, headers });
				}
				const created = await deps.context.issueStore.create(title, {
					body: issueBody,
					tags: tags.length > 0 ? tags : undefined,
					priority: priority ?? undefined,
				});
				const parentId = readTrimmedString(body.parent_id);
				if (parentId) {
					await deps.context.issueStore.add_dep(created.id, "parent", parentId);
				}
				const issue = parentId ? ((await deps.context.issueStore.get(created.id)) ?? created) : created;
				return commandCompletedResponse(headers, "issue create", { issue });
			}
			case "issue_update": {
				const id = readTrimmedString(body.id);
				if (!id) {
					return Response.json({ error: "id is required for issue_update" }, { status: 400, headers });
				}
				const current = await deps.context.issueStore.get(id);
				if (!current) {
					return Response.json({ error: "issue not found" }, { status: 404, headers });
				}
				const patch: Record<string, unknown> = {};
				if (typeof body.title === "string") patch.title = body.title;
				if (typeof body.body === "string") patch.body = body.body;
				if (typeof body.status === "string") patch.status = body.status;
				if (typeof body.outcome === "string") patch.outcome = body.outcome;
				if (body.priority != null) {
					const priority = readIntOrNull(body.priority);
					if (priority == null) {
						return Response.json({ error: "priority must be an integer" }, { status: 400, headers });
					}
					patch.priority = priority;
				}
				if (body.tags != null) {
					patch.tags = readCommaList(body.tags);
				}
				const addTags = readCommaList(body.add_tags);
				const removeTags = readCommaList(body.remove_tags);
				if (addTags.length > 0 || removeTags.length > 0) {
					const baseTags = Array.isArray(patch.tags)
						? ((patch.tags as string[]) ?? [])
						: Array.isArray(current.tags)
							? [...current.tags]
							: [];
					const next = new Set(baseTags);
					for (const tag of addTags) next.add(tag);
					for (const tag of removeTags) next.delete(tag);
					patch.tags = [...next];
				}
				if (Object.keys(patch).length === 0) {
					return Response.json({ error: "issue_update requires at least one patch field" }, { status: 400, headers });
				}
				const issue = await deps.context.issueStore.update(id, patch);
				return commandCompletedResponse(headers, "issue update", { issue });
			}
			case "issue_claim": {
				const id = readTrimmedString(body.id);
				if (!id) {
					return Response.json({ error: "id is required for issue_claim" }, { status: 400, headers });
				}
				const claimed = await deps.context.issueStore.claim(id);
				if (!claimed) {
					return Response.json({ error: "failed to claim issue" }, { status: 409, headers });
				}
				const issue = await deps.context.issueStore.get(id);
				if (!issue) {
					return Response.json({ error: "issue not found" }, { status: 404, headers });
				}
				return commandCompletedResponse(headers, "issue claim", { issue });
			}
			case "issue_open": {
				const id = readTrimmedString(body.id);
				if (!id) {
					return Response.json({ error: "id is required for issue_open" }, { status: 400, headers });
				}
				const issue = await deps.context.issueStore.update(id, { status: "open", outcome: null });
				return commandCompletedResponse(headers, "issue open", { issue });
			}
			case "issue_close": {
				const id = readTrimmedString(body.id);
				if (!id) {
					return Response.json({ error: "id is required for issue_close" }, { status: 400, headers });
				}
				const outcome = readTrimmedString(body.outcome) || "success";
				const issue = await deps.context.issueStore.close(id, outcome);
				return commandCompletedResponse(headers, "issue close", { issue });
			}
			case "issue_dep": {
				const srcId = readTrimmedString(body.src_id);
				const dstId = readTrimmedString(body.dst_id);
				const depType = readTrimmedString(body.dep_type) || "blocks";
				if (!srcId || !dstId) {
					return Response.json({ error: "src_id and dst_id are required for issue_dep" }, { status: 400, headers });
				}
				if (depType !== "blocks" && depType !== "parent") {
					return Response.json({ error: "dep_type must be blocks or parent" }, { status: 400, headers });
				}
				await deps.context.issueStore.add_dep(srcId, depType, dstId);
				return commandCompletedResponse(headers, "issue dep", {
					src_id: srcId,
					dst_id: dstId,
					dep_type: depType,
				});
			}
			case "issue_undep": {
				const srcId = readTrimmedString(body.src_id);
				const dstId = readTrimmedString(body.dst_id);
				const depType = readTrimmedString(body.dep_type) || "blocks";
				if (!srcId || !dstId) {
					return Response.json({ error: "src_id and dst_id are required for issue_undep" }, { status: 400, headers });
				}
				if (depType !== "blocks" && depType !== "parent") {
					return Response.json({ error: "dep_type must be blocks or parent" }, { status: 400, headers });
				}
				const ok = await deps.context.issueStore.remove_dep(srcId, depType, dstId);
				return commandCompletedResponse(headers, "issue undep", {
					src_id: srcId,
					dst_id: dstId,
					dep_type: depType,
					ok,
				});
			}
			case "forum_post": {
				const topic = readTrimmedString(body.topic);
				const messageBody = readTrimmedString(body.body);
				if (!topic) {
					return Response.json({ error: "topic is required for forum_post" }, { status: 400, headers });
				}
				if (!messageBody) {
					return Response.json({ error: "body is required for forum_post" }, { status: 400, headers });
				}
				const author = readTrimmedString(body.author) || "operator";
				const message = await deps.context.forumStore.post(topic, messageBody, author);
				return commandCompletedResponse(headers, "forum post", { message });
			}
			case "heartbeat_create": {
				const title = readTrimmedString(body.title);
				if (!title) {
					return Response.json({ error: "title is required for heartbeat_create" }, { status: 400, headers });
				}
				const parsedTarget = parseHeartbeatTarget(body);
				if (!parsedTarget.target) {
					return Response.json({ error: parsedTarget.error ?? "invalid target" }, { status: 400, headers });
				}
				const everyMsRaw = readFiniteNumberOrNull(body.every_ms);
				if (body.every_ms != null && everyMsRaw == null) {
					return Response.json({ error: "every_ms must be a finite number" }, { status: 400, headers });
				}
				if (body.reason != null && typeof body.reason !== "string") {
					return Response.json({ error: "reason must be a string" }, { status: 400, headers });
				}
				if (body.wake_mode != null && typeof body.wake_mode !== "string") {
					return Response.json({ error: "wake_mode must be a string" }, { status: 400, headers });
				}
				const enabled = parseOptionalBoolean(body.enabled);
				if (!enabled.ok) {
					return Response.json({ error: "enabled must be boolean" }, { status: 400, headers });
				}
				if (
					body.metadata != null &&
					(typeof body.metadata !== "object" || Array.isArray(body.metadata))
				) {
					return Response.json({ error: "metadata must be an object" }, { status: 400, headers });
				}
				try {
					const program = await deps.heartbeatPrograms.create({
						title,
						target: parsedTarget.target,
						everyMs: everyMsRaw == null ? undefined : Math.max(0, Math.trunc(everyMsRaw)),
						reason: typeof body.reason === "string" ? body.reason : undefined,
						wakeMode: body.wake_mode == null ? undefined : normalizeWakeMode(body.wake_mode),
						enabled: enabled.value ?? undefined,
						metadata: body.metadata as Record<string, unknown> | undefined,
					});
					return commandCompletedResponse(headers, "heartbeat create", { program });
				} catch (err) {
					return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
				}
			}
			case "heartbeat_update": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json({ error: "program_id is required for heartbeat_update" }, { status: 400, headers });
				}
				let target: HeartbeatProgramTarget | undefined;
				if (body.target_kind != null) {
					const parsedTarget = parseHeartbeatTarget(body);
					if (!parsedTarget.target) {
						return Response.json({ error: parsedTarget.error ?? "invalid target" }, { status: 400, headers });
					}
					target = parsedTarget.target;
				}
				const everyMsRaw = readFiniteNumberOrNull(body.every_ms);
				if (body.every_ms != null && everyMsRaw == null) {
					return Response.json({ error: "every_ms must be a finite number" }, { status: 400, headers });
				}
				if (body.reason != null && typeof body.reason !== "string") {
					return Response.json({ error: "reason must be a string" }, { status: 400, headers });
				}
				if (body.wake_mode != null && typeof body.wake_mode !== "string") {
					return Response.json({ error: "wake_mode must be a string" }, { status: 400, headers });
				}
				const enabled = parseOptionalBoolean(body.enabled);
				if (!enabled.ok) {
					return Response.json({ error: "enabled must be boolean" }, { status: 400, headers });
				}
				if (
					body.metadata != null &&
					(typeof body.metadata !== "object" || Array.isArray(body.metadata))
				) {
					return Response.json({ error: "metadata must be an object" }, { status: 400, headers });
				}
				try {
					const result = await deps.heartbeatPrograms.update({
						programId,
						title: typeof body.title === "string" ? body.title : undefined,
						target,
						everyMs: everyMsRaw == null ? undefined : Math.max(0, Math.trunc(everyMsRaw)),
						reason: typeof body.reason === "string" ? body.reason : undefined,
						wakeMode: body.wake_mode == null ? undefined : normalizeWakeMode(body.wake_mode),
						enabled: enabled.value ?? undefined,
						metadata: body.metadata as Record<string, unknown> | undefined,
					});
					if (!result.ok) {
						return Response.json(
							{ error: `heartbeat update failed: ${result.reason ?? "unknown"}` },
							{ status: commandProgramFailureStatus(result.reason), headers },
						);
					}
					return commandCompletedResponse(headers, "heartbeat update", { program: result.program });
				} catch (err) {
					return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
				}
			}
			case "heartbeat_delete": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json({ error: "program_id is required for heartbeat_delete" }, { status: 400, headers });
				}
				const result = await deps.heartbeatPrograms.remove(programId);
				if (!result.ok) {
					return Response.json(
						{ error: `heartbeat delete failed: ${result.reason ?? "unknown"}` },
						{ status: commandProgramFailureStatus(result.reason), headers },
					);
				}
				return commandCompletedResponse(headers, "heartbeat delete", { program: result.program });
			}
			case "heartbeat_trigger": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json({ error: "program_id is required for heartbeat_trigger" }, { status: 400, headers });
				}
				if (body.reason != null && typeof body.reason !== "string") {
					return Response.json({ error: "reason must be a string" }, { status: 400, headers });
				}
				const result = await deps.heartbeatPrograms.trigger({
					programId,
					reason: typeof body.reason === "string" ? body.reason : null,
				});
				if (!result.ok) {
					return Response.json(
						{ error: `heartbeat trigger failed: ${result.reason ?? "unknown"}` },
						{ status: commandProgramFailureStatus(result.reason), headers },
					);
				}
				return commandCompletedResponse(headers, "heartbeat trigger", { program: result.program });
			}
			case "heartbeat_enable":
			case "heartbeat_disable": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json(
						{ error: `program_id is required for ${kind}` },
						{ status: 400, headers },
					);
				}
				const result = await deps.heartbeatPrograms.update({
					programId,
					enabled: kind === "heartbeat_enable",
				});
				if (!result.ok) {
					return Response.json(
						{ error: `${kind} failed: ${result.reason ?? "unknown"}` },
						{ status: commandProgramFailureStatus(result.reason), headers },
					);
				}
				return commandCompletedResponse(headers, kind.replaceAll("_", " "), { program: result.program });
			}
			case "cron_create": {
				const title = readTrimmedString(body.title);
				if (!title) {
					return Response.json({ error: "title is required for cron_create" }, { status: 400, headers });
				}
				const parsedTarget = parseCronTarget(body);
				if (!parsedTarget.target) {
					return Response.json({ error: parsedTarget.error ?? "invalid target" }, { status: 400, headers });
				}
				if (!hasCronScheduleInput(body)) {
					return Response.json({ error: "schedule is required for cron_create" }, { status: 400, headers });
				}
				if (body.reason != null && typeof body.reason !== "string") {
					return Response.json({ error: "reason must be a string" }, { status: 400, headers });
				}
				if (body.wake_mode != null && typeof body.wake_mode !== "string") {
					return Response.json({ error: "wake_mode must be a string" }, { status: 400, headers });
				}
				const enabled = parseOptionalBoolean(body.enabled);
				if (!enabled.ok) {
					return Response.json({ error: "enabled must be boolean" }, { status: 400, headers });
				}
				if (
					body.metadata != null &&
					(typeof body.metadata !== "object" || Array.isArray(body.metadata))
				) {
					return Response.json({ error: "metadata must be an object" }, { status: 400, headers });
				}
				try {
					const program = await deps.cronPrograms.create({
						title,
						target: parsedTarget.target,
						schedule: cronScheduleInputFromBody(body),
						reason: typeof body.reason === "string" ? body.reason : undefined,
						wakeMode: body.wake_mode == null ? undefined : normalizeWakeMode(body.wake_mode),
						enabled: enabled.value ?? undefined,
						metadata: body.metadata as Record<string, unknown> | undefined,
					});
					return commandCompletedResponse(headers, "cron create", { program });
				} catch (err) {
					return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
				}
			}
			case "cron_update": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json({ error: "program_id is required for cron_update" }, { status: 400, headers });
				}
				let target: CronProgramTarget | undefined;
				if (body.target_kind != null) {
					const parsedTarget = parseCronTarget(body);
					if (!parsedTarget.target) {
						return Response.json({ error: parsedTarget.error ?? "invalid target" }, { status: 400, headers });
					}
					target = parsedTarget.target;
				}
				if (body.reason != null && typeof body.reason !== "string") {
					return Response.json({ error: "reason must be a string" }, { status: 400, headers });
				}
				if (body.wake_mode != null && typeof body.wake_mode !== "string") {
					return Response.json({ error: "wake_mode must be a string" }, { status: 400, headers });
				}
				const enabled = parseOptionalBoolean(body.enabled);
				if (!enabled.ok) {
					return Response.json({ error: "enabled must be boolean" }, { status: 400, headers });
				}
				if (
					body.metadata != null &&
					(typeof body.metadata !== "object" || Array.isArray(body.metadata))
				) {
					return Response.json({ error: "metadata must be an object" }, { status: 400, headers });
				}
				try {
					const result = await deps.cronPrograms.update({
						programId,
						title: typeof body.title === "string" ? body.title : undefined,
						reason: typeof body.reason === "string" ? body.reason : undefined,
						wakeMode: body.wake_mode == null ? undefined : normalizeWakeMode(body.wake_mode),
						enabled: enabled.value ?? undefined,
						target,
						schedule: hasCronScheduleInput(body) ? cronScheduleInputFromBody(body) : undefined,
						metadata: body.metadata as Record<string, unknown> | undefined,
					});
					if (!result.ok) {
						return Response.json(
							{ error: `cron update failed: ${result.reason ?? "unknown"}` },
							{ status: commandProgramFailureStatus(result.reason), headers },
						);
					}
					return commandCompletedResponse(headers, "cron update", { program: result.program });
				} catch (err) {
					return Response.json({ error: deps.describeError(err) }, { status: 400, headers });
				}
			}
			case "cron_delete": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json({ error: "program_id is required for cron_delete" }, { status: 400, headers });
				}
				const result = await deps.cronPrograms.remove(programId);
				if (!result.ok) {
					return Response.json(
						{ error: `cron delete failed: ${result.reason ?? "unknown"}` },
						{ status: commandProgramFailureStatus(result.reason), headers },
					);
				}
				return commandCompletedResponse(headers, "cron delete", { program: result.program });
			}
			case "cron_trigger": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json({ error: "program_id is required for cron_trigger" }, { status: 400, headers });
				}
				if (body.reason != null && typeof body.reason !== "string") {
					return Response.json({ error: "reason must be a string" }, { status: 400, headers });
				}
				const result = await deps.cronPrograms.trigger({
					programId,
					reason: typeof body.reason === "string" ? body.reason : null,
				});
				if (!result.ok) {
					return Response.json(
						{ error: `cron trigger failed: ${result.reason ?? "unknown"}` },
						{ status: commandProgramFailureStatus(result.reason), headers },
					);
				}
				return commandCompletedResponse(headers, "cron trigger", { program: result.program });
			}
			case "cron_enable":
			case "cron_disable": {
				const programId = readTrimmedString(body.program_id);
				if (!programId) {
					return Response.json({ error: `program_id is required for ${kind}` }, { status: 400, headers });
				}
				const result = await deps.cronPrograms.update({
					programId,
					enabled: kind === "cron_enable",
				});
				if (!result.ok) {
					return Response.json(
						{ error: `${kind} failed: ${result.reason ?? "unknown"}` },
						{ status: commandProgramFailureStatus(result.reason), headers },
					);
				}
				return commandCompletedResponse(headers, kind.replaceAll("_", " "), { program: result.program });
			}
			default:
				return Response.json({ error: `unknown command kind: ${kind}` }, { status: 400, headers });
		}

		try {
			if (!commandText) {
				return Response.json({ error: `unknown command kind: ${kind}` }, { status: 400, headers });
			}
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

	if (path === "/api/context" || path.startsWith("/api/context/")) {
		return contextRoutes(request, url, { context: deps.context, describeError: deps.describeError }, headers);
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
