import { extname, join, resolve } from "node:path";

import type { EventEnvelope, ForumMessage, Issue, JsonlStore } from "@femtomc/mu-core";
import { currentRunId, EventLog, FsJsonlStore, getStorePaths, JsonlEventSink } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { eventRoutes } from "./api/events.js";
import { forumRoutes } from "./api/forum.js";
import { issueRoutes } from "./api/issues.js";
import {
	applyMuConfigPatch,
	DEFAULT_MU_CONFIG,
	getMuConfigPath,
	type MuConfig,
	muConfigPresence,
	readMuConfigFile,
	redactMuConfigSecrets,
	writeMuConfigFile,
} from "./config.js";
import {
	ControlPlaneActivitySupervisor,
	type ControlPlaneActivityStatus,
} from "./activity_supervisor.js";
import { bootstrapControlPlane, type ControlPlaneConfig, type ControlPlaneHandle } from "./control_plane.js";
import { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";
import { HeartbeatProgramRegistry, type HeartbeatProgramTarget } from "./heartbeat_programs.js";

const MIME_TYPES: Record<string, string> = {
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

// Resolve public/ dir relative to this file (works in npm global installs)
const PUBLIC_DIR = join(new URL(".", import.meta.url).pathname, "..", "public");

type ControlPlaneSummary = {
	active: boolean;
	adapters: string[];
	routes: Array<{ name: string; route: string }>;
};

type ControlPlaneReloadResult = {
	ok: boolean;
	reason: string;
	previous_control_plane: ControlPlaneSummary;
	control_plane: ControlPlaneSummary;
	error?: string;
};

type ControlPlaneReloader = (opts: {
	repoRoot: string;
	previous: ControlPlaneHandle | null;
	config: ControlPlaneConfig;
}) => Promise<ControlPlaneHandle | null>;

type ConfigReader = (repoRoot: string) => Promise<MuConfig>;
type ConfigWriter = (repoRoot: string, config: MuConfig) => Promise<string>;

export type ServerOptions = {
	repoRoot?: string;
	port?: number;
	controlPlane?: ControlPlaneHandle | null;
	heartbeatScheduler?: ActivityHeartbeatScheduler;
	activitySupervisor?: ControlPlaneActivitySupervisor;
	controlPlaneReloader?: ControlPlaneReloader;
	config?: MuConfig;
	configReader?: ConfigReader;
	configWriter?: ConfigWriter;
};

export type ServerContext = {
	repoRoot: string;
	issueStore: IssueStore;
	forumStore: ForumStore;
	eventLog: EventLog;
	eventsStore: JsonlStore<EventEnvelope>;
};

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function summarizeControlPlane(handle: ControlPlaneHandle | null): ControlPlaneSummary {
	if (!handle) {
		return { active: false, adapters: [], routes: [] };
	}
	return {
		active: handle.activeAdapters.length > 0,
		adapters: handle.activeAdapters.map((adapter) => adapter.name),
		routes: handle.activeAdapters.map((adapter) => ({ name: adapter.name, route: adapter.route })),
	};
}

export function createContext(repoRoot: string): ServerContext {
	const paths = getStorePaths(repoRoot);
	const eventsStore = new FsJsonlStore<EventEnvelope>(paths.eventsPath);
	const eventLog = new EventLog(new JsonlEventSink(eventsStore), {
		runIdProvider: currentRunId,
	});

	const issueStore = new IssueStore(new FsJsonlStore<Issue>(paths.issuesPath), { events: eventLog });

	const forumStore = new ForumStore(new FsJsonlStore<ForumMessage>(paths.forumPath), { events: eventLog });

	return { repoRoot, issueStore, forumStore, eventLog, eventsStore };
}

export function createServer(options: ServerOptions = {}) {
	const repoRoot = options.repoRoot || process.cwd();
	const context = createContext(repoRoot);

	const readConfig: ConfigReader = options.configReader ?? readMuConfigFile;
	const writeConfig: ConfigWriter = options.configWriter ?? writeMuConfigFile;
	const fallbackConfig = options.config ?? DEFAULT_MU_CONFIG;
	const heartbeatScheduler = options.heartbeatScheduler ?? new ActivityHeartbeatScheduler();

	const activitySupervisor =
		options.activitySupervisor ??
		new ControlPlaneActivitySupervisor({
			heartbeatScheduler,
			onEvent: async (event) => {
				await context.eventLog.emit(`activity.${event.kind}`, {
					source: "mu-server.activity-supervisor",
					payload: {
						seq: event.seq,
						message: event.message,
						activity_id: event.activity.activity_id,
						kind: event.activity.kind,
						status: event.activity.status,
						heartbeat_count: event.activity.heartbeat_count,
						last_progress: event.activity.last_progress,
					},
				});
			},
		});

	let controlPlaneCurrent = options.controlPlane ?? null;
	let reloadInFlight: Promise<ControlPlaneReloadResult> | null = null;

	const controlPlaneReloader: ControlPlaneReloader =
		options.controlPlaneReloader ??
		(async ({ repoRoot, config }) => {
			return await bootstrapControlPlane({ repoRoot, config, heartbeatScheduler });
		});

	const controlPlaneProxy: ControlPlaneHandle = {
		get activeAdapters() {
			return controlPlaneCurrent?.activeAdapters ?? [];
		},
		async handleWebhook(path, req) {
			const handle = controlPlaneCurrent;
			if (!handle) return null;
			return await handle.handleWebhook(path, req);
		},
		async listRuns(opts) {
			const handle = controlPlaneCurrent;
			if (!handle?.listRuns) return [];
			return await handle.listRuns(opts);
		},
		async getRun(idOrRoot) {
			const handle = controlPlaneCurrent;
			if (!handle?.getRun) return null;
			return await handle.getRun(idOrRoot);
		},
		async startRun(opts) {
			const handle = controlPlaneCurrent;
			if (!handle?.startRun) {
				throw new Error("run_supervisor_unavailable");
			}
			return await handle.startRun(opts);
		},
		async resumeRun(opts) {
			const handle = controlPlaneCurrent;
			if (!handle?.resumeRun) {
				throw new Error("run_supervisor_unavailable");
			}
			return await handle.resumeRun(opts);
		},
		async interruptRun(opts) {
			const handle = controlPlaneCurrent;
			if (!handle?.interruptRun) {
				return { ok: false, reason: "not_found", run: null };
			}
			return await handle.interruptRun(opts);
		},
		async heartbeatRun(opts) {
			const handle = controlPlaneCurrent;
			if (!handle?.heartbeatRun) {
				return { ok: false, reason: "not_found", run: null };
			}
			return await handle.heartbeatRun(opts);
		},
		async traceRun(opts) {
			const handle = controlPlaneCurrent;
			if (!handle?.traceRun) return null;
			return await handle.traceRun(opts);
		},
		async stop() {
			const handle = controlPlaneCurrent;
			controlPlaneCurrent = null;
			await handle?.stop();
		},
	};

	const heartbeatPrograms = new HeartbeatProgramRegistry({
		repoRoot,
		heartbeatScheduler,
		runHeartbeat: async (opts) => {
			const result = await controlPlaneProxy.heartbeatRun?.({
				jobId: opts.jobId ?? null,
				rootIssueId: opts.rootIssueId ?? null,
				reason: opts.reason ?? null,
			});
			return result ?? { ok: false, reason: "not_found" };
		},
		activityHeartbeat: async (opts) => {
			return activitySupervisor.heartbeat({
				activityId: opts.activityId ?? null,
				reason: opts.reason ?? null,
			});
		},
		onTickEvent: async (event) => {
			await context.eventLog.emit("heartbeat_program.tick", {
				source: "mu-server.heartbeat-programs",
				payload: {
					program_id: event.program_id,
					status: event.status,
					reason: event.reason,
					message: event.message,
					program: event.program,
				},
			});
		},
	});

	const loadConfigFromDisk = async (): Promise<MuConfig> => {
		try {
			return await readConfig(context.repoRoot);
		} catch (err) {
			if ((err as { code?: string })?.code === "ENOENT") {
				return fallbackConfig;
			}
			throw err;
		}
	};

	const performControlPlaneReload = async (reason: string): Promise<ControlPlaneReloadResult> => {
		const previous = controlPlaneCurrent;
		const previousSummary = summarizeControlPlane(previous);
		try {
			const latestConfig = await loadConfigFromDisk();
			const next = await controlPlaneReloader({
				repoRoot: context.repoRoot,
				previous,
				config: latestConfig.control_plane,
			});
			controlPlaneCurrent = next;
			if (previous && previous !== next) {
				await previous.stop();
			}
			return {
				ok: true,
				reason,
				previous_control_plane: previousSummary,
				control_plane: summarizeControlPlane(next),
			};
		} catch (err) {
			return {
				ok: false,
				reason,
				previous_control_plane: previousSummary,
				control_plane: summarizeControlPlane(previous),
				error: describeError(err),
			};
		}
	};

	const reloadControlPlane = async (reason: string): Promise<ControlPlaneReloadResult> => {
		if (reloadInFlight) {
			return await reloadInFlight;
		}
		reloadInFlight = performControlPlaneReload(reason).finally(() => {
			reloadInFlight = null;
		});
		return await reloadInFlight;
	};

	const handleRequest = async (request: Request): Promise<Response> => {
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
					const config = await loadConfigFromDisk();
					return Response.json(
						{
							repo_root: context.repoRoot,
							config_path: getMuConfigPath(context.repoRoot),
							config: redactMuConfigSecrets(config),
							presence: muConfigPresence(config),
						},
						{ headers },
					);
				} catch (err) {
					return Response.json(
						{ error: `failed to read config: ${describeError(err)}` },
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
					const base = await loadConfigFromDisk();
					const next = applyMuConfigPatch(base, body.patch);
					const configPath = await writeConfig(context.repoRoot, next);
					return Response.json(
						{
							ok: true,
							repo_root: context.repoRoot,
							config_path: configPath,
							config: redactMuConfigSecrets(next),
							presence: muConfigPresence(next),
						},
						{ headers },
					);
				} catch (err) {
					return Response.json(
						{ error: `failed to write config: ${describeError(err)}` },
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

			const result = await reloadControlPlane(reason);
			return Response.json(result, { status: result.ok ? 200 : 500, headers });
		}

		if (path === "/api/status") {
			const issues = await context.issueStore.list();
			const openIssues = issues.filter((i) => i.status === "open");
			const readyIssues = await context.issueStore.ready();
			const controlPlane = summarizeControlPlane(controlPlaneCurrent);

			return Response.json(
				{
					repo_root: context.repoRoot,
					open_count: openIssues.length,
					ready_count: readyIssues.length,
					control_plane: controlPlane,
				},
				{ headers },
			);
		}

		if (path === "/api/runs") {
			if (request.method !== "GET") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}
			const status = url.searchParams.get("status")?.trim() || undefined;
			const limitRaw = url.searchParams.get("limit");
			const limit =
				limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : undefined;
			const runs = await controlPlaneProxy.listRuns?.({ status, limit });
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
				const run = await controlPlaneProxy.startRun?.({ prompt, maxSteps });
				if (!run) {
					return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
				}
				return Response.json({ ok: true, run }, { status: 201, headers });
			} catch (err) {
				return Response.json({ error: describeError(err) }, { status: 500, headers });
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
				const run = await controlPlaneProxy.resumeRun?.({ rootIssueId, maxSteps });
				if (!run) {
					return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
				}
				return Response.json({ ok: true, run }, { status: 201, headers });
			} catch (err) {
				return Response.json({ error: describeError(err) }, { status: 500, headers });
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
			const result = await controlPlaneProxy.interruptRun?.({
				rootIssueId,
				jobId,
			});
			if (!result) {
				return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
			}
			return Response.json(result, { status: result.ok ? 200 : 404, headers });
		}

		if (path === "/api/runs/heartbeat") {
			if (request.method !== "POST") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}
			let body: { root_issue_id?: unknown; job_id?: unknown; reason?: unknown };
			try {
				body = (await request.json()) as { root_issue_id?: unknown; job_id?: unknown; reason?: unknown };
			} catch {
				return Response.json({ error: "invalid json body" }, { status: 400, headers });
			}
			const rootIssueId = typeof body.root_issue_id === "string" ? body.root_issue_id.trim() : null;
			const jobId = typeof body.job_id === "string" ? body.job_id.trim() : null;
			const reason = typeof body.reason === "string" ? body.reason.trim() : null;
			const result = await controlPlaneProxy.heartbeatRun?.({
				rootIssueId,
				jobId,
				reason,
			});
			if (!result) {
				return Response.json({ error: "run supervisor unavailable" }, { status: 503, headers });
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
				const trace = await controlPlaneProxy.traceRun?.({ idOrRoot, limit });
				if (!trace) {
					return Response.json({ error: "run trace not found" }, { status: 404, headers });
				}
				return Response.json(trace, { headers });
			}
			if (request.method !== "GET") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}
			const run = await controlPlaneProxy.getRun?.(idOrRoot);
			if (!run) {
				return Response.json({ error: "run not found" }, { status: 404, headers });
			}
			return Response.json(run, { headers });
		}

		if (path === "/api/heartbeats") {
			if (request.method !== "GET") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}
			const enabledRaw = url.searchParams.get("enabled")?.trim().toLowerCase();
			const enabled =
				enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined;
			const targetKindRaw = url.searchParams.get("target_kind")?.trim().toLowerCase();
			const targetKind = targetKindRaw === "run" || targetKindRaw === "activity" ? targetKindRaw : undefined;
			const limitRaw = url.searchParams.get("limit");
			const limit =
				limitRaw && /^\d+$/.test(limitRaw)
					? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10)))
					: undefined;
			const programs = await heartbeatPrograms.list({ enabled, targetKind, limit });
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
			const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
			try {
				const program = await heartbeatPrograms.create({
					title,
					target,
					everyMs,
					reason,
					enabled,
					metadata:
						body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
							? (body.metadata as Record<string, unknown>)
							: undefined,
				});
				return Response.json({ ok: true, program }, { status: 201, headers });
			} catch (err) {
				return Response.json({ error: describeError(err) }, { status: 400, headers });
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
			try {
				const result = await heartbeatPrograms.update({
					programId,
					title: typeof body.title === "string" ? body.title : undefined,
					target,
					everyMs:
						typeof body.every_ms === "number" && Number.isFinite(body.every_ms)
							? Math.max(0, Math.trunc(body.every_ms))
							: undefined,
					reason: typeof body.reason === "string" ? body.reason : undefined,
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
				return Response.json({ error: describeError(err) }, { status: 400, headers });
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
			const result = await heartbeatPrograms.remove(programId);
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
			const result = await heartbeatPrograms.trigger({
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
			const program = await heartbeatPrograms.get(id);
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
				statusRaw === "running" ||
				statusRaw === "completed" ||
				statusRaw === "failed" ||
				statusRaw === "cancelled"
					? (statusRaw as ControlPlaneActivityStatus)
					: undefined;
			const kind = url.searchParams.get("kind")?.trim() || undefined;
			const limitRaw = url.searchParams.get("limit");
			const limit =
				limitRaw && /^\d+$/.test(limitRaw)
					? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10)))
					: undefined;
			const activities = activitySupervisor.list({ status, kind, limit });
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
				body.source === "api" || body.source === "command" || body.source === "system"
					? body.source
					: "api";
			try {
				const activity = activitySupervisor.start({
					title,
					kind,
					heartbeatEveryMs,
					metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
					source,
				});
				return Response.json({ ok: true, activity }, { status: 201, headers });
			} catch (err) {
				return Response.json({ error: describeError(err) }, { status: 400, headers });
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
			const result = activitySupervisor.progress({
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
			const result = activitySupervisor.heartbeat({
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
					? activitySupervisor.complete({ activityId, message })
					: path === "/api/activities/fail"
						? activitySupervisor.fail({ activityId, message })
						: activitySupervisor.cancel({ activityId, message });
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
				const events = activitySupervisor.events(activityId, { limit });
				if (!events) {
					return Response.json({ error: "activity not found" }, { status: 404, headers });
				}
				return Response.json({ count: events.length, events }, { headers });
			}
			const activity = activitySupervisor.get(activityId);
			if (!activity) {
				return Response.json({ error: "activity not found" }, { status: 404, headers });
			}
			return Response.json(activity, { headers });
		}

		if (path.startsWith("/api/issues")) {
			const response = await issueRoutes(request, context);
			headers.forEach((value, key) => {
				response.headers.set(key, value);
			});
			return response;
		}

		if (path.startsWith("/api/forum")) {
			const response = await forumRoutes(request, context);
			headers.forEach((value, key) => {
				response.headers.set(key, value);
			});
			return response;
		}

		if (path.startsWith("/api/events")) {
			const response = await eventRoutes(request, context);
			headers.forEach((value, key) => {
				response.headers.set(key, value);
			});
			return response;
		}

		if (path.startsWith("/webhooks/")) {
			const response = await controlPlaneProxy.handleWebhook(path, request);
			if (response) {
				headers.forEach((value, key) => {
					response.headers.set(key, value);
				});
				return response;
			}
		}

		const filePath = resolve(PUBLIC_DIR, `.${path === "/" ? "/index.html" : path}`);
		if (!filePath.startsWith(PUBLIC_DIR)) {
			return new Response("Forbidden", { status: 403, headers });
		}

		const file = Bun.file(filePath);
		if (await file.exists()) {
			const ext = extname(filePath);
			const mime = MIME_TYPES[ext] ?? "application/octet-stream";
			headers.set("Content-Type", mime);
			return new Response(await file.arrayBuffer(), { status: 200, headers });
		}

		const indexPath = join(PUBLIC_DIR, "index.html");
		const indexFile = Bun.file(indexPath);
		if (await indexFile.exists()) {
			headers.set("Content-Type", "text/html; charset=utf-8");
			return new Response(await indexFile.arrayBuffer(), { status: 200, headers });
		}

		return new Response("Not Found", { status: 404, headers });
	};

	const server = {
		port: options.port || 3000,
		fetch: handleRequest,
		hostname: "0.0.0.0",
		controlPlane: controlPlaneProxy,
		activitySupervisor,
		heartbeatPrograms,
	};

	return server;
}

export type ServerWithControlPlane = {
	serverConfig: ReturnType<typeof createServer>;
	controlPlane: ControlPlaneHandle | null;
};

export async function createServerAsync(
	options: Omit<ServerOptions, "controlPlane"> = {},
): Promise<ServerWithControlPlane> {
	const repoRoot = options.repoRoot || process.cwd();
	const config = options.config ?? (await readMuConfigFile(repoRoot));
	const heartbeatScheduler = options.heartbeatScheduler ?? new ActivityHeartbeatScheduler();
	const controlPlane = await bootstrapControlPlane({
		repoRoot,
		config: config.control_plane,
		heartbeatScheduler,
	});
	const serverConfig = createServer({ ...options, heartbeatScheduler, controlPlane, config });
	return {
		serverConfig,
		controlPlane: serverConfig.controlPlane,
	};
}
