import {
	GenerationTelemetryRecorder,
	type ReloadableGenerationIdentity,
	type ReloadLifecycleReason,
} from "@femtomc/mu-control-plane";
import type { ControlPlaneConfig, ControlPlaneHandle, TelegramGenerationReloadResult } from "./control_plane_contract.js";
import { ControlPlaneGenerationSupervisor } from "./generation_supervisor.js";

export type ControlPlaneSummary = {
	active: boolean;
	adapters: string[];
	routes: Array<{ name: string; route: string }>;
};

export type ControlPlaneReloadResult = {
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

export type ControlPlaneReloader = (opts: {
	repoRoot: string;
	previous: ControlPlaneHandle | null;
	config: ControlPlaneConfig;
	generation: ReloadableGenerationIdentity;
}) => Promise<ControlPlaneHandle | null>;

export type ConfigReader = (repoRoot: string) => Promise<import("./config.js").MuConfig>;
export type ConfigWriter = (repoRoot: string, config: import("./config.js").MuConfig) => Promise<string>;

export function summarizeControlPlane(handle: ControlPlaneHandle | null): ControlPlaneSummary {
	if (!handle) {
		return { active: false, adapters: [], routes: [] };
	}
	return {
		active: handle.activeAdapters.length > 0,
		adapters: handle.activeAdapters.map((adapter) => adapter.name),
		routes: handle.activeAdapters.map((adapter) => ({ name: adapter.name, route: adapter.route })),
	};
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export type ReloadManagerDeps = {
	repoRoot: string;
	initialControlPlane: ControlPlaneHandle | null;
	controlPlaneReloader: ControlPlaneReloader;
	generationTelemetry: GenerationTelemetryRecorder;
	loadConfigFromDisk: () => Promise<import("./config.js").MuConfig>;
};

export type ReloadManager = {
	reloadControlPlane: (reason: ReloadLifecycleReason) => Promise<ControlPlaneReloadResult>;
	getControlPlaneStatus: () => {
		active: boolean;
		adapters: string[];
		routes: Array<{ name: string; route: string }>;
		generation: import("@femtomc/mu-control-plane").GenerationSupervisorSnapshot;
		observability: {
			counters: ReturnType<GenerationTelemetryRecorder["counters"]>;
		};
	};
	getControlPlaneCurrent: () => ControlPlaneHandle | null;
	setControlPlaneCurrent: (handle: ControlPlaneHandle | null) => void;
	generationSupervisor: ControlPlaneGenerationSupervisor;
	generationTelemetry: GenerationTelemetryRecorder;
};

export function createReloadManager(deps: ReloadManagerDeps): ReloadManager {
	let controlPlaneCurrent = deps.initialControlPlane;
	let reloadInFlight: Promise<ControlPlaneReloadResult> | null = null;
	const generationTelemetry = deps.generationTelemetry;
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
			const latestConfig = await deps.loadConfigFromDisk();

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

			const next = await deps.controlPlaneReloader({
				repoRoot: deps.repoRoot,
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

	return {
		reloadControlPlane,
		getControlPlaneStatus: () => ({
			...summarizeControlPlane(controlPlaneCurrent),
			generation: generationSupervisor.snapshot(),
			observability: {
				counters: generationTelemetry.counters(),
			},
		}),
		getControlPlaneCurrent: () => controlPlaneCurrent,
		setControlPlaneCurrent: (handle: ControlPlaneHandle | null) => {
			controlPlaneCurrent = handle;
		},
		generationSupervisor,
		generationTelemetry,
	};
}
