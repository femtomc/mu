import { join } from "node:path";
import {
	type GenerationSupervisorSnapshot,
	type GenerationTelemetryCountersSnapshot,
	GenerationTelemetryRecorder,
	type ReloadableGenerationIdentity,
	type ReloadLifecycleReason,
} from "@femtomc/mu-control-plane";
import type { EventEnvelope, ForumMessage, Issue, JsonlStore } from "@femtomc/mu-core";
import { currentRunId, EventLog, FsJsonlStore, getStorePaths, JsonlEventSink } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { ControlPlaneActivitySupervisor } from "./activity_supervisor.js";
import {
	DEFAULT_MU_CONFIG,
	type MuConfig,
	readMuConfigFile,
	writeMuConfigFile,
} from "./config.js";
import { bootstrapControlPlane } from "./control_plane.js";
import type {
	ControlPlaneConfig,
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
	TelegramGenerationReloadResult,
} from "./control_plane_contract.js";
import { ControlPlaneGenerationSupervisor } from "./generation_supervisor.js";
import { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";
import { createProcessSessionLifecycle } from "./session_lifecycle.js";
import { createServerProgramOrchestration } from "./server_program_orchestration.js";
import { createServerRequestHandler } from "./server_routing.js";
import type { ServerRuntime } from "./server_runtime.js";

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

const DEFAULT_OPERATOR_WAKE_COALESCE_MS = 2_000;
const DEFAULT_AUTO_RUN_HEARTBEAT_EVERY_MS = 15_000;

function toNonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.trunc(value));
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Math.max(0, Number.parseInt(value, 10));
	}
	return Math.max(0, Math.trunc(fallback));
}

export { createProcessSessionLifecycle };

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
	operatorWakeCoalesceMs?: number;
	autoRunHeartbeatEveryMs?: number;
	config?: MuConfig;
	configReader?: ConfigReader;
	configWriter?: ConfigWriter;
	sessionLifecycle?: ControlPlaneSessionLifecycle;
};

export type ServerInstanceOptions = Omit<
	ServerOptions,
	"repoRoot" | "controlPlane" | "heartbeatScheduler" | "generationTelemetry" | "config" | "sessionLifecycle"
>;

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

function createServer(options: ServerOptions = {}) {
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

	const operatorWakeCoalesceMs = toNonNegativeInt(options.operatorWakeCoalesceMs, DEFAULT_OPERATOR_WAKE_COALESCE_MS);
	const autoRunHeartbeatEveryMs = Math.max(
		1_000,
		toNonNegativeInt(options.autoRunHeartbeatEveryMs, DEFAULT_AUTO_RUN_HEARTBEAT_EVERY_MS),
	);
	const operatorWakeLastByKey = new Map<string, number>();
	const sessionLifecycle = options.sessionLifecycle ?? createProcessSessionLifecycle({ repoRoot });

	const emitOperatorWake = async (opts: {
		dedupeKey: string;
		message: string;
		payload: Record<string, unknown>;
		coalesceMs?: number;
	}): Promise<boolean> => {
		const dedupeKey = opts.dedupeKey.trim();
		if (!dedupeKey) {
			return false;
		}
		const nowMs = Date.now();
		const coalesceMs = Math.max(0, Math.trunc(opts.coalesceMs ?? operatorWakeCoalesceMs));
		const previous = operatorWakeLastByKey.get(dedupeKey);
		if (typeof previous === "number" && nowMs - previous < coalesceMs) {
			return false;
		}
		operatorWakeLastByKey.set(dedupeKey, nowMs);
		await context.eventLog.emit("operator.wake", {
			source: "mu-server.operator-wake",
			payload: {
				message: opts.message,
				dedupe_key: dedupeKey,
				coalesce_ms: coalesceMs,
				...opts.payload,
			},
		});
		return true;
	};

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
				sessionLifecycle,
				terminalEnabled: true,
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
		async submitTerminalCommand(opts) {
			const handle = controlPlaneCurrent;
			if (!handle?.submitTerminalCommand) {
				throw new Error("control_plane_unavailable");
			}
			return await handle.submitTerminalCommand(opts);
		},
		async stop() {
			const handle = controlPlaneCurrent;
			controlPlaneCurrent = null;
			await handle?.stop();
		},
	};

	const {
		heartbeatPrograms,
		cronPrograms,
		registerAutoRunHeartbeatProgram,
		disableAutoRunHeartbeatProgram,
	} = createServerProgramOrchestration({
		repoRoot,
		heartbeatScheduler,
		controlPlaneProxy,
		activitySupervisor,
		eventLog: context.eventLog,
		autoRunHeartbeatEveryMs,
		emitOperatorWake,
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
		let nextHandle: ControlPlaneHandle | null = null;

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
			nextHandle = next;
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
						rollback_reason: "reload_failed_after_cutover",
						rollback_target_generation_id: attempt.from_generation?.generation_id ?? null,
						rollback_source_generation_id: attempt.to_generation.generation_id,
					},
				});

				if (!previous) {
					logLifecycle({
						level: "error",
						stage: "rollback",
						state: "failed",
						extra: {
							rollback_reason: "no_previous_generation",
							rollback_source_generation_id: attempt.to_generation.generation_id,
						},
					});
				} else {
					try {
						const restored = generationSupervisor.rollbackSwapInstalled(attempt.attempt_id);
						if (!restored) {
							throw new Error("generation_rollback_state_mismatch");
						}
						controlPlaneCurrent = previous;
						if (nextHandle && nextHandle !== previous) {
							await nextHandle.stop();
						}
						logLifecycle({
							level: "info",
							stage: "rollback",
							state: "complete",
							extra: {
								active_generation_id: generationSupervisor.activeGeneration()?.generation_id ?? null,
								rollback_target_generation_id: attempt.from_generation?.generation_id ?? null,
							},
						});
					} catch (rollbackErr) {
						logLifecycle({
							level: "error",
							stage: "rollback",
							state: "failed",
							extra: {
								error: describeError(rollbackErr),
								active_generation_id: generationSupervisor.activeGeneration()?.generation_id ?? null,
								rollback_target_generation_id: attempt.from_generation?.generation_id ?? null,
								rollback_source_generation_id: attempt.to_generation.generation_id,
							},
						});
					}
				}
			} else {
				logLifecycle({
					level: "debug",
					stage: "rollback",
					state: "skipped",
					extra: {
						rollback_reason: "cutover_not_installed",
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
				control_plane: summarizeControlPlane(controlPlaneCurrent),
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
			const fallbackGeneration =
				generationSupervisor.activeGeneration() ??
				generationSupervisor.snapshot().last_reload?.to_generation ??
				null;
			const generation = pending?.to_generation ?? fallbackGeneration;
			if (generation) {
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
			}
			return await reloadInFlight;
		}
		reloadInFlight = performControlPlaneReload(reason).finally(() => {
			reloadInFlight = null;
		});
		return await reloadInFlight;
	};

	const handleRequest = createServerRequestHandler({
		context,
		controlPlaneProxy,
		activitySupervisor,
		heartbeatPrograms,
		cronPrograms,
		loadConfigFromDisk,
		writeConfig,
		reloadControlPlane,
		getControlPlaneStatus: () => ({
			...summarizeControlPlane(controlPlaneCurrent),
			generation: generationSupervisor.snapshot(),
			observability: {
				counters: generationTelemetry.counters(),
			},
		}),
		registerAutoRunHeartbeatProgram,
		disableAutoRunHeartbeatProgram,
		describeError,
		publicDir: PUBLIC_DIR,
		mimeTypes: MIME_TYPES,
	});

	const server = {
		port: options.port || 3000,
		fetch: handleRequest,
		hostname: "0.0.0.0",
		controlPlane: controlPlaneProxy,
		activitySupervisor,
		heartbeatPrograms,
		cronPrograms,
	};

	return server;
}

export type { ServerRuntime, ServerRuntimeCapabilities, ServerRuntimeOptions } from "./server_runtime.js";
export { composeServerRuntime } from "./server_runtime.js";

export function createServerFromRuntime(runtime: ServerRuntime, options: ServerInstanceOptions = {}) {
	return createServer({
		...options,
		repoRoot: runtime.repoRoot,
		config: runtime.config,
		heartbeatScheduler: runtime.heartbeatScheduler,
		generationTelemetry: runtime.generationTelemetry,
		sessionLifecycle: runtime.sessionLifecycle,
		controlPlane: runtime.controlPlane,
	});
}

