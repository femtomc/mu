import { extname, join, resolve } from "node:path";
import {
	GenerationTelemetryRecorder,
	getControlPlanePaths,
	IdentityStore,
	type GenerationSupervisorSnapshot,
	type GenerationTelemetryCountersSnapshot,
	type ReloadableGenerationIdentity,
	type ReloadLifecycleReason,
	ROLE_SCOPES,
} from "@femtomc/mu-control-plane";
import type { EventEnvelope, ForumMessage, Issue, JsonlStore } from "@femtomc/mu-core";
import { currentRunId, EventLog, FsJsonlStore, getStorePaths, JsonlEventSink } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { type ControlPlaneActivityStatus, ControlPlaneActivitySupervisor } from "./activity_supervisor.js";
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
	bootstrapControlPlane,
	type ControlPlaneConfig,
	type ControlPlaneHandle,
	type TelegramGenerationReloadResult,
} from "./control_plane.js";
import { ControlPlaneGenerationSupervisor } from "./generation_supervisor.js";
import { HeartbeatProgramRegistry, type HeartbeatProgramTarget } from "./heartbeat_programs.js";
import { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";

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

type ControlPlaneStatus = ControlPlaneSummary & {
	generation: GenerationSupervisorSnapshot;
	observability: {
		counters: GenerationTelemetryCountersSnapshot;
	};
};

type ControlPlaneReloadResult = {
	ok: boolean;
	reason: string;
	previous_control_plane: ControlPlaneSummary;
	control_plane: ControlPlaneSummary;
	generation: {
		attempt_id: string;
		coalesced: boolean;
		from_generation: ReloadableGenerationIdentity | null;
		to_generation: ReloadableGenerationIdentity;
		active_generation: ReloadableGenerationIdentity | null;
		outcome: "success" | "failure";
	};
	telegram_generation?: TelegramGenerationReloadResult;
	error?: string;
};

type ControlPlaneReloader = (opts: {
	repoRoot: string;
	previous: ControlPlaneHandle | null;
	config: ControlPlaneConfig;
	generation: ReloadableGenerationIdentity;
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
	generationTelemetry?: GenerationTelemetryRecorder;
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
	const generationTelemetry = options.generationTelemetry ?? new GenerationTelemetryRecorder();
	const generationSupervisor = new ControlPlaneGenerationSupervisor({
		supervisorId: "control-plane",
		initialGeneration: controlPlaneCurrent
			? {
					generation_id: "control-plane-gen-0",
					generation_seq: 0,
				}
			: null,
	});
	const legacyGeneration: ReloadableGenerationIdentity = {
		generation_id: "control-plane-gen-legacy",
		generation_seq: -1,
	};
	const generationTagsFor = (generation: ReloadableGenerationIdentity, component: string) => ({
		generation_id: generation.generation_id,
		generation_seq: generation.generation_seq,
		supervisor: "control_plane",
		component,
	});

	const controlPlaneReloader: ControlPlaneReloader =
		options.controlPlaneReloader ??
		(async ({ repoRoot, config, generation }) => {
			return await bootstrapControlPlane({
				repoRoot,
				config,
				heartbeatScheduler,
				generation,
				telemetry: generationTelemetry,
			});
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

	const performControlPlaneReload = async (reason: ReloadLifecycleReason): Promise<ControlPlaneReloadResult> => {
		const startedAtMs = Date.now();
		const planned = generationSupervisor.beginReload(reason);
		const attempt = planned.attempt;
		const previous = controlPlaneCurrent;
		const previousSummary = summarizeControlPlane(previous);
		const tags = generationTagsFor(attempt.to_generation, "server.reload");
		const baseFields = {
			reason,
			attempt_id: attempt.attempt_id,
			coalesced: planned.coalesced,
			from_generation_id: attempt.from_generation?.generation_id ?? null,
		};
		const logLifecycle = (opts: {
			level: "debug" | "info" | "warn" | "error";
			stage: "warmup" | "cutover" | "drain" | "rollback";
			state: "start" | "complete" | "failed" | "skipped";
			extra?: Record<string, unknown>;
		}): void => {
			generationTelemetry.log({
				level: opts.level,
				message: `reload transition ${opts.stage}:${opts.state}`,
				fields: {
					...tags,
					...baseFields,
					...(opts.extra ?? {}),
				},
			});
		};

		let swapped = false;
		let failedStage: "warmup" | "cutover" | "drain" = "warmup";
		let drainDurationMs = 0;
		let drainStartedAtMs: number | null = null;

		try {
			logLifecycle({ level: "info", stage: "warmup", state: "start" });
			const latestConfig = await loadConfigFromDisk();

			const telegramGeneration =
				(await previous?.reloadTelegramGeneration?.({
					config: latestConfig.control_plane,
					reason,
				})) ?? null;
			if (telegramGeneration?.handled) {
				if (telegramGeneration.warmup) {
					logLifecycle({
						level: telegramGeneration.warmup.ok ? "info" : "error",
						stage: "warmup",
						state: telegramGeneration.warmup.ok ? "complete" : "failed",
						extra: {
							warmup_elapsed_ms: telegramGeneration.warmup.elapsed_ms,
							error: telegramGeneration.warmup.error,
							telegram_generation_id: telegramGeneration.to_generation?.generation_id ?? null,
						},
					});
				} else {
					logLifecycle({
						level: "info",
						stage: "warmup",
						state: "skipped",
						extra: {
							warmup_reason: "telegram_generation_no_warmup",
							telegram_generation_id: telegramGeneration.to_generation?.generation_id ?? null,
						},
					});
				}

				if (telegramGeneration.cutover) {
					logLifecycle({ level: "info", stage: "cutover", state: "start" });
					logLifecycle({
						level: telegramGeneration.cutover.ok ? "info" : "error",
						stage: "cutover",
						state: telegramGeneration.cutover.ok ? "complete" : "failed",
						extra: {
							cutover_elapsed_ms: telegramGeneration.cutover.elapsed_ms,
							error: telegramGeneration.cutover.error,
							active_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
						},
					});
				} else {
					logLifecycle({
						level: "info",
						stage: "cutover",
						state: "skipped",
						extra: {
							cutover_reason: "telegram_generation_no_cutover",
							active_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
						},
					});
				}

				if (telegramGeneration.drain) {
					logLifecycle({ level: "info", stage: "drain", state: "start" });
					drainDurationMs = Math.max(0, Math.trunc(telegramGeneration.drain.elapsed_ms));
					generationTelemetry.recordDrainDuration(tags, {
						durationMs: drainDurationMs,
						timedOut: telegramGeneration.drain.timed_out,
						metadata: {
							...baseFields,
							telegram_forced_stop: telegramGeneration.drain.forced_stop,
							telegram_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
						},
					});
					logLifecycle({
						level: telegramGeneration.drain.ok ? "info" : "warn",
						stage: "drain",
						state: telegramGeneration.drain.ok ? "complete" : "failed",
						extra: {
							drain_duration_ms: telegramGeneration.drain.elapsed_ms,
							drain_timed_out: telegramGeneration.drain.timed_out,
							forced_stop: telegramGeneration.drain.forced_stop,
							error: telegramGeneration.drain.error,
						},
					});
				} else {
					logLifecycle({
						level: "info",
						stage: "drain",
						state: "skipped",
						extra: {
							drain_reason: "telegram_generation_no_drain",
							telegram_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
						},
					});
				}

				const shouldLogRollbackStart =
					telegramGeneration.rollback.requested ||
					telegramGeneration.rollback.attempted ||
					telegramGeneration.rollback.trigger != null ||
					!telegramGeneration.ok;
				if (shouldLogRollbackStart) {
					logLifecycle({
						level: telegramGeneration.rollback.ok ? "warn" : "error",
						stage: "rollback",
						state: "start",
						extra: {
							rollback_requested: telegramGeneration.rollback.requested,
							rollback_trigger: telegramGeneration.rollback.trigger,
							rollback_attempted: telegramGeneration.rollback.attempted,
						},
					});
					logLifecycle({
						level: telegramGeneration.rollback.ok ? "info" : "error",
						stage: "rollback",
						state: telegramGeneration.rollback.ok ? "complete" : "failed",
						extra: {
							rollback_requested: telegramGeneration.rollback.requested,
							rollback_trigger: telegramGeneration.rollback.trigger,
							rollback_attempted: telegramGeneration.rollback.attempted,
							error: telegramGeneration.rollback.error,
						},
					});
				} else {
					logLifecycle({
						level: "debug",
						stage: "rollback",
						state: "skipped",
						extra: {
							rollback_reason: "not_requested",
						},
					});
				}

				if (telegramGeneration.ok) {
					swapped = generationSupervisor.markSwapInstalled(attempt.attempt_id);
					generationSupervisor.finishReload(attempt.attempt_id, "success");
					const elapsedMs = Math.max(0, Date.now() - startedAtMs);
					generationTelemetry.recordReloadSuccess(tags, {
						...baseFields,
						elapsed_ms: elapsedMs,
						drain_duration_ms: drainDurationMs,
						telegram_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
						telegram_rollback_attempted: telegramGeneration.rollback.attempted,
						telegram_rollback_trigger: telegramGeneration.rollback.trigger,
					});
					generationTelemetry.trace({
						name: "control_plane.reload",
						status: "ok",
						durationMs: elapsedMs,
						fields: {
							...tags,
							...baseFields,
							telegram_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
						},
					});
					return {
						ok: true,
						reason,
						previous_control_plane: previousSummary,
						control_plane: summarizeControlPlane(controlPlaneCurrent),
						generation: {
							attempt_id: attempt.attempt_id,
							coalesced: planned.coalesced,
							from_generation: attempt.from_generation,
							to_generation: attempt.to_generation,
							active_generation: generationSupervisor.activeGeneration(),
							outcome: "success",
						},
						telegram_generation: telegramGeneration,
					};
				}

				generationSupervisor.finishReload(attempt.attempt_id, "failure");
				const error = telegramGeneration.error ?? "telegram_generation_reload_failed";
				const elapsedMs = Math.max(0, Date.now() - startedAtMs);
				generationTelemetry.recordReloadFailure(tags, {
					...baseFields,
					elapsed_ms: elapsedMs,
					drain_duration_ms: drainDurationMs,
					error,
					telegram_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
					telegram_rollback_trigger: telegramGeneration.rollback.trigger,
				});
				generationTelemetry.trace({
					name: "control_plane.reload",
					status: "error",
					durationMs: elapsedMs,
					fields: {
						...tags,
						...baseFields,
						error,
						telegram_generation_id: telegramGeneration.active_generation?.generation_id ?? null,
						telegram_rollback_trigger: telegramGeneration.rollback.trigger,
					},
				});
				return {
					ok: false,
					reason,
					previous_control_plane: previousSummary,
					control_plane: summarizeControlPlane(controlPlaneCurrent),
					generation: {
						attempt_id: attempt.attempt_id,
						coalesced: planned.coalesced,
						from_generation: attempt.from_generation,
						to_generation: attempt.to_generation,
						active_generation: generationSupervisor.activeGeneration(),
						outcome: "failure",
					},
					telegram_generation: telegramGeneration,
					error,
				};
			}

			const next = await controlPlaneReloader({
				repoRoot: context.repoRoot,
				previous,
				config: latestConfig.control_plane,
				generation: attempt.to_generation,
			});
			logLifecycle({ level: "info", stage: "warmup", state: "complete" });

			failedStage = "cutover";
			logLifecycle({ level: "info", stage: "cutover", state: "start" });
			controlPlaneCurrent = next;
			swapped = generationSupervisor.markSwapInstalled(attempt.attempt_id);
			logLifecycle({
				level: "info",
				stage: "cutover",
				state: "complete",
				extra: {
					active_generation_id: generationSupervisor.activeGeneration()?.generation_id ?? null,
				},
			});

			failedStage = "drain";
			if (previous && previous !== next) {
				logLifecycle({ level: "info", stage: "drain", state: "start" });
				drainStartedAtMs = Date.now();
				await previous.stop();
				drainDurationMs = Math.max(0, Date.now() - drainStartedAtMs);
				generationTelemetry.recordDrainDuration(tags, {
					durationMs: drainDurationMs,
					metadata: {
						...baseFields,
					},
				});
				logLifecycle({
					level: "info",
					stage: "drain",
					state: "complete",
					extra: {
						drain_duration_ms: drainDurationMs,
					},
				});
			} else {
				logLifecycle({
					level: "info",
					stage: "drain",
					state: "skipped",
					extra: {
						drain_reason: "no_previous_generation",
					},
				});
			}

			logLifecycle({
				level: "debug",
				stage: "rollback",
				state: "skipped",
				extra: {
					rollback_reason: "not_requested",
				},
			});
			generationSupervisor.finishReload(attempt.attempt_id, "success");
			const elapsedMs = Math.max(0, Date.now() - startedAtMs);
			generationTelemetry.recordReloadSuccess(tags, {
				...baseFields,
				elapsed_ms: elapsedMs,
				drain_duration_ms: drainDurationMs,
			});
			generationTelemetry.trace({
				name: "control_plane.reload",
				status: "ok",
				durationMs: elapsedMs,
				fields: {
					...tags,
					...baseFields,
				},
			});
			return {
				ok: true,
				reason,
				previous_control_plane: previousSummary,
				control_plane: summarizeControlPlane(next),
				generation: {
					attempt_id: attempt.attempt_id,
					coalesced: planned.coalesced,
					from_generation: attempt.from_generation,
					to_generation: attempt.to_generation,
					active_generation: generationSupervisor.activeGeneration(),
					outcome: "success",
				},
			};
		} catch (err) {
			const error = describeError(err);
			if (failedStage === "drain" && drainStartedAtMs != null) {
				drainDurationMs = Math.max(0, Date.now() - drainStartedAtMs);
				generationTelemetry.recordDrainDuration(tags, {
					durationMs: drainDurationMs,
					metadata: {
						...baseFields,
						error,
					},
				});
			}
			logLifecycle({
				level: "error",
				stage: failedStage,
				state: "failed",
				extra: {
					error,
					drain_duration_ms: failedStage === "drain" ? drainDurationMs : undefined,
				},
			});

			if (swapped) {
				logLifecycle({
					level: "warn",
					stage: "rollback",
					state: "start",
					extra: {
						rollback_mode: "post_cutover_unavailable",
					},
				});
				logLifecycle({
					level: "warn",
					stage: "rollback",
					state: "failed",
					extra: {
						rollback_mode: "post_cutover_unavailable",
						rollback_reason: "manual_rollback_not_implemented",
					},
				});
			} else {
				logLifecycle({
					level: "warn",
					stage: "rollback",
					state: "start",
					extra: {
						rollback_mode: "pre_cutover_noop",
					},
				});
				logLifecycle({
					level: "info",
					stage: "rollback",
					state: "complete",
					extra: {
						rollback_mode: "pre_cutover_noop",
						active_generation_id: generationSupervisor.activeGeneration()?.generation_id ?? null,
					},
				});
			}

			generationSupervisor.finishReload(attempt.attempt_id, "failure");
			const elapsedMs = Math.max(0, Date.now() - startedAtMs);
			generationTelemetry.recordReloadFailure(tags, {
				...baseFields,
				elapsed_ms: elapsedMs,
				drain_duration_ms: drainDurationMs,
				error,
			});
			generationTelemetry.trace({
				name: "control_plane.reload",
				status: "error",
				durationMs: elapsedMs,
				fields: {
					...tags,
					...baseFields,
					error,
				},
			});
			return {
				ok: false,
				reason,
				previous_control_plane: previousSummary,
				control_plane: summarizeControlPlane(swapped ? controlPlaneCurrent : previous),
				generation: {
					attempt_id: attempt.attempt_id,
					coalesced: planned.coalesced,
					from_generation: attempt.from_generation,
					to_generation: attempt.to_generation,
					active_generation: generationSupervisor.activeGeneration(),
					outcome: "failure",
				},
				error,
			};
		}
	};

	const reloadControlPlane = async (reason: ReloadLifecycleReason): Promise<ControlPlaneReloadResult> => {
		if (reloadInFlight) {
			const pending = generationSupervisor.pendingReload();
			const generation = pending?.to_generation ?? generationSupervisor.activeGeneration() ?? legacyGeneration;
			generationTelemetry.recordDuplicateSignal(generationTagsFor(generation, "server.reload"), {
				source: "server_reload",
				signal: "coalesced_reload_request",
				dedupe_key: pending?.attempt_id ?? "reload_in_flight",
				record_id: pending?.attempt_id ?? "reload_in_flight",
				metadata: {
					reason,
					pending_reason: pending?.reason ?? null,
				},
			});
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

		if (path === "/api/control-plane/rollback") {
			if (request.method !== "POST") {
				return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
			}
			const result = await reloadControlPlane("rollback");
			return Response.json(result, { status: result.ok ? 200 : 500, headers });
		}

		if (path === "/api/status") {
			const issues = await context.issueStore.list();
			const openIssues = issues.filter((i) => i.status === "open");
			const readyIssues = await context.issueStore.ready();
			const controlPlane: ControlPlaneStatus = {
				...summarizeControlPlane(controlPlaneCurrent),
				generation: generationSupervisor.snapshot(),
				observability: {
					counters: generationTelemetry.counters(),
				},
			};

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
			const enabled = enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined;
			const targetKindRaw = url.searchParams.get("target_kind")?.trim().toLowerCase();
			const targetKind = targetKindRaw === "run" || targetKindRaw === "activity" ? targetKindRaw : undefined;
			const limitRaw = url.searchParams.get("limit");
			const limit =
				limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : undefined;
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
				statusRaw === "running" || statusRaw === "completed" || statusRaw === "failed" || statusRaw === "cancelled"
					? (statusRaw as ControlPlaneActivityStatus)
					: undefined;
			const kind = url.searchParams.get("kind")?.trim() || undefined;
			const limitRaw = url.searchParams.get("limit");
			const limit =
				limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : undefined;
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
				body.source === "api" || body.source === "command" || body.source === "system" ? body.source : "api";
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

		if (path === "/api/identities" || path === "/api/identities/link" || path === "/api/identities/unlink") {
			const cpPaths = getControlPlanePaths(context.repoRoot);
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
	const generationTelemetry = options.generationTelemetry ?? new GenerationTelemetryRecorder();
	const controlPlane = await bootstrapControlPlane({
		repoRoot,
		config: config.control_plane,
		heartbeatScheduler,
		generation: {
			generation_id: "control-plane-gen-0",
			generation_seq: 0,
		},
		telemetry: generationTelemetry,
	});
	const serverConfig = createServer({
		...options,
		heartbeatScheduler,
		controlPlane,
		config,
		generationTelemetry,
	});
	return {
		serverConfig,
		controlPlane: serverConfig.controlPlane,
	};
}
