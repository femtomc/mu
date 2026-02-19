import { GenerationTelemetryRecorder } from "@femtomc/mu-control-plane";
import type { EventEnvelope, ForumMessage, Issue, JsonlStore } from "@femtomc/mu-core";
import { currentRunId, EventLog, FsJsonlStore, getStorePaths, JsonlEventSink } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { ControlPlaneActivitySupervisor } from "./activity_supervisor.js";
import {
	DEFAULT_MU_CONFIG,
	type MuConfig,
	type WakeTurnMode,
	readMuConfigFile,
	writeMuConfigFile,
} from "./config.js";
import { bootstrapControlPlane } from "./control_plane.js";
import type {
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
	NotifyOperatorsResult,
	WakeDeliveryEvent,
} from "./control_plane_contract.js";
import {
	type ConfigReader,
	type ConfigWriter,
	type ControlPlaneReloader,
	type ControlPlaneReloadResult,
	type ControlPlaneSummary,
	createReloadManager,
} from "./control_plane_reload.js";
import { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";
import { createProcessSessionLifecycle } from "./session_lifecycle.js";
import { createServerProgramOrchestration } from "./server_program_orchestration.js";
import { createServerRequestHandler } from "./server_routing.js";
import type { ServerRuntime } from "./server_runtime.js";
import { toNonNegativeInt } from "./server_types.js";

const DEFAULT_OPERATOR_WAKE_COALESCE_MS = 2_000;
const DEFAULT_AUTO_RUN_HEARTBEAT_EVERY_MS = 15_000;

export { createProcessSessionLifecycle };

export type {
	ConfigReader,
	ConfigWriter,
	ControlPlaneReloader,
	ControlPlaneReloadResult,
	ControlPlaneSummary,
};

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
	initiateShutdown?: () => Promise<void>;
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

type WakeDecisionOutcome = "triggered" | "skipped" | "fallback";

type WakeDecision = {
	outcome: WakeDecisionOutcome;
	reason: string;
	wakeTurnMode: WakeTurnMode;
	selectedWakeMode: string | null;
	turnRequestId: string | null;
	turnResultKind: string | null;
	error: string | null;
};

function emptyNotifyOperatorsResult(): NotifyOperatorsResult {
	return {
		queued: 0,
		duplicate: 0,
		skipped: 0,
		decisions: [],
	};
}

function normalizeWakeTurnMode(value: unknown): WakeTurnMode {
	if (typeof value !== "string") {
		return "off";
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "shadow") {
		return "shadow";
	}
	if (normalized === "active") {
		return "active";
	}
	return "off";
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
	const value = payload[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
	const value = payload[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return Math.trunc(value);
}

function computeWakeId(opts: { dedupeKey: string; payload: Record<string, unknown> }): string {
	const source = stringField(opts.payload, "wake_source") ?? "unknown";
	const programId = stringField(opts.payload, "program_id") ?? "unknown";
	const sourceTsMs = numberField(opts.payload, "source_ts_ms");
	const target = Object.hasOwn(opts.payload, "target") ? opts.payload.target : null;
	let targetFingerprint = "null";
	try {
		targetFingerprint = JSON.stringify(target) ?? "null";
	} catch {
		targetFingerprint = "[unserializable]";
	}
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${source}|${programId}|${sourceTsMs ?? "na"}|${opts.dedupeKey}|${targetFingerprint}`);
	return hasher.digest("hex").slice(0, 16);
}

function buildWakeTurnCommandText(opts: {
	wakeId: string;
	message: string;
	payload: Record<string, unknown>;
}): string {
	const wakeSource = stringField(opts.payload, "wake_source") ?? "unknown";
	const programId = stringField(opts.payload, "program_id") ?? "unknown";
	const wakeMode = stringField(opts.payload, "wake_mode") ?? "immediate";
	const targetKind = stringField(opts.payload, "target_kind") ?? "unknown";
	const reason = stringField(opts.payload, "reason") ?? "scheduled";
	let target = "null";
	try {
		target = JSON.stringify(Object.hasOwn(opts.payload, "target") ? opts.payload.target : null) ?? "null";
	} catch {
		target = "[unserializable]";
	}
	return [
		"Autonomous wake turn triggered by heartbeat/cron scheduler.",
		`wake_id=${opts.wakeId}`,
		`wake_source=${wakeSource}`,
		`program_id=${programId}`,
		`wake_mode=${wakeMode}`,
		`target_kind=${targetKind}`,
		`reason=${reason}`,
		`message=${opts.message}`,
		`target=${target}`,
		"",
		"If an action is needed, produce exactly one `/mu ...` command. If no action is needed, provide a short operator response.",
	].join("\n");
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

	const emitWakeDeliveryEvent = async (payload: Record<string, unknown>): Promise<void> => {
		await context.eventLog.emit("operator.wake.delivery", {
			source: "mu-server.operator-wake",
			payload,
		});
	};

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

		const wakeId = computeWakeId({ dedupeKey, payload: opts.payload });
		const selectedWakeMode = stringField(opts.payload, "wake_mode");
		const wakeSource = stringField(opts.payload, "wake_source");
		const programId = stringField(opts.payload, "program_id");
		const sourceTsMs = numberField(opts.payload, "source_ts_ms");

		let wakeTurnMode = normalizeWakeTurnMode(fallbackConfig.control_plane.operator.wake_turn_mode);
		let configReadError: string | null = null;
		try {
			const config = await loadConfigFromDisk();
			wakeTurnMode = normalizeWakeTurnMode(config.control_plane.operator.wake_turn_mode);
		} catch (err) {
			configReadError = describeError(err);
		}

		let decision: WakeDecision;
		if (wakeTurnMode === "off") {
			decision = {
				outcome: "skipped",
				reason: "feature_disabled",
				wakeTurnMode,
				selectedWakeMode,
				turnRequestId: null,
				turnResultKind: null,
				error: configReadError,
			};
		} else if (wakeTurnMode === "shadow") {
			decision = {
				outcome: "skipped",
				reason: "shadow_mode",
				wakeTurnMode,
				selectedWakeMode,
				turnRequestId: null,
				turnResultKind: null,
				error: configReadError,
			};
		} else if (typeof controlPlaneProxy.submitTerminalCommand !== "function") {
			decision = {
				outcome: "fallback",
				reason: "control_plane_unavailable",
				wakeTurnMode,
				selectedWakeMode,
				turnRequestId: null,
				turnResultKind: null,
				error: configReadError,
			};
		} else {
			const turnRequestId = `wake-turn-${wakeId}`;
			try {
				const turnResult = await controlPlaneProxy.submitTerminalCommand({
					commandText: buildWakeTurnCommandText({
						wakeId,
						message: opts.message,
						payload: opts.payload,
					}),
					repoRoot: context.repoRoot,
					requestId: turnRequestId,
				});
				if (turnResult.kind === "noop" || turnResult.kind === "invalid") {
					decision = {
						outcome: "fallback",
						reason: `turn_result_${turnResult.kind}`,
						wakeTurnMode,
						selectedWakeMode,
						turnRequestId,
						turnResultKind: turnResult.kind,
						error: configReadError,
					};
				} else {
					decision = {
						outcome: "triggered",
						reason: "turn_invoked",
						wakeTurnMode,
						selectedWakeMode,
						turnRequestId,
						turnResultKind: turnResult.kind,
						error: configReadError,
					};
				}
			} catch (err) {
				const error = describeError(err);
				decision = {
					outcome: "fallback",
					reason: error === "control_plane_unavailable" ? "control_plane_unavailable" : "turn_execution_failed",
					wakeTurnMode,
					selectedWakeMode,
					turnRequestId,
					turnResultKind: null,
					error,
				};
			}
		}

		await context.eventLog.emit("operator.wake.decision", {
			source: "mu-server.operator-wake",
			payload: {
				wake_id: wakeId,
				dedupe_key: dedupeKey,
				wake_source: wakeSource,
				program_id: programId,
				source_ts_ms: sourceTsMs,
				selected_wake_mode: selectedWakeMode,
				wake_turn_mode: decision.wakeTurnMode,
				wake_turn_feature_enabled: decision.wakeTurnMode === "active",
				outcome: decision.outcome,
				reason: decision.reason,
				turn_request_id: decision.turnRequestId,
				turn_result_kind: decision.turnResultKind,
				error: decision.error,
			},
		});

		let notifyResult = emptyNotifyOperatorsResult();
		let notifyError: string | null = null;
		if (typeof controlPlaneProxy.notifyOperators === "function") {
			try {
				notifyResult = await controlPlaneProxy.notifyOperators({
					message: opts.message,
					dedupeKey,
					wake: {
						wakeId,
						wakeSource,
						programId,
						sourceTsMs,
					},
					metadata: {
						wake_delivery_reason: "heartbeat_cron_wake",
						wake_turn_outcome: decision.outcome,
						wake_turn_reason: decision.reason,
					},
				});
			} catch (err) {
				notifyError = describeError(err);
			}
		}

		for (const deliveryDecision of notifyResult.decisions) {
			await emitWakeDeliveryEvent({
				state: deliveryDecision.state,
				reason_code: deliveryDecision.reason_code,
				wake_id: wakeId,
				dedupe_key: dedupeKey,
				binding_id: deliveryDecision.binding_id,
				channel: deliveryDecision.channel,
				outbox_id: deliveryDecision.outbox_id,
				outbox_dedupe_key: deliveryDecision.dedupe_key,
				attempt_count: null,
				wake_source: wakeSource,
				program_id: programId,
				source_ts_ms: sourceTsMs,
			});
		}

		await context.eventLog.emit("operator.wake", {
			source: "mu-server.operator-wake",
			payload: {
				message: opts.message,
				dedupe_key: dedupeKey,
				coalesce_ms: coalesceMs,
				...opts.payload,
				wake_id: wakeId,
				decision_outcome: decision.outcome,
				decision_reason: decision.reason,
				wake_turn_mode: decision.wakeTurnMode,
				selected_wake_mode: decision.selectedWakeMode,
				wake_turn_feature_enabled: decision.wakeTurnMode === "active",
				turn_request_id: decision.turnRequestId,
				turn_result_kind: decision.turnResultKind,
				decision_error: decision.error,
				delivery: {
					queued: notifyResult.queued,
					duplicate: notifyResult.duplicate,
					skipped: notifyResult.skipped,
				},
				delivery_summary_v2: {
					queued: notifyResult.queued,
					duplicate: notifyResult.duplicate,
					skipped: notifyResult.skipped,
					total: notifyResult.decisions.length,
				},
				delivery_error: notifyError,
			},
		});
		return true;
	};

	const generationTelemetry = options.generationTelemetry ?? new GenerationTelemetryRecorder();

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
				wakeDeliveryObserver: (event) => {
					void emitWakeDeliveryEvent({
						state: event.state,
						reason_code: event.reason_code,
						wake_id: event.wake_id,
						dedupe_key: event.dedupe_key,
						binding_id: event.binding_id,
						channel: event.channel,
						outbox_id: event.outbox_id,
						outbox_dedupe_key: event.outbox_dedupe_key,
						attempt_count: event.attempt_count,
					});
				},
				terminalEnabled: true,
			});
		});

	const reloadManager = createReloadManager({
		repoRoot: context.repoRoot,
		initialControlPlane: options.controlPlane ?? null,
		controlPlaneReloader,
		generationTelemetry,
		loadConfigFromDisk,
	});

	const applyWakeDeliveryObserver = (): void => {
		const handle = reloadManager.getControlPlaneCurrent();
		handle?.setWakeDeliveryObserver?.((event: WakeDeliveryEvent) => {
			void emitWakeDeliveryEvent({
				state: event.state,
				reason_code: event.reason_code,
				wake_id: event.wake_id,
				dedupe_key: event.dedupe_key,
				binding_id: event.binding_id,
				channel: event.channel,
				outbox_id: event.outbox_id,
				outbox_dedupe_key: event.outbox_dedupe_key,
				attempt_count: event.attempt_count,
			});
		});
	};
	applyWakeDeliveryObserver();

	const reloadControlPlane = async (
		reason: Parameters<typeof reloadManager.reloadControlPlane>[0],
	): Promise<ControlPlaneReloadResult> => {
		const result = await reloadManager.reloadControlPlane(reason);
		applyWakeDeliveryObserver();
		return result;
	};

	const controlPlaneProxy: ControlPlaneHandle = {
		get activeAdapters() {
			return reloadManager.getControlPlaneCurrent()?.activeAdapters ?? [];
		},
		async handleWebhook(path, req) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle) return null;
			return await handle.handleWebhook(path, req);
		},
		async notifyOperators(opts): Promise<NotifyOperatorsResult> {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.notifyOperators) {
				return emptyNotifyOperatorsResult();
			}
			return await handle.notifyOperators(opts);
		},
		setWakeDeliveryObserver(observer) {
			const handle = reloadManager.getControlPlaneCurrent();
			handle?.setWakeDeliveryObserver?.(observer ?? null);
		},
		async listRuns(opts) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.listRuns) return [];
			return await handle.listRuns(opts);
		},
		async getRun(idOrRoot) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.getRun) return null;
			return await handle.getRun(idOrRoot);
		},
		async startRun(opts) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.startRun) {
				throw new Error("run_supervisor_unavailable");
			}
			return await handle.startRun(opts);
		},
		async resumeRun(opts) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.resumeRun) {
				throw new Error("run_supervisor_unavailable");
			}
			return await handle.resumeRun(opts);
		},
		async interruptRun(opts) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.interruptRun) {
				return { ok: false, reason: "not_found", run: null };
			}
			return await handle.interruptRun(opts);
		},
		async heartbeatRun(opts) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.heartbeatRun) {
				return { ok: false, reason: "not_found", run: null };
			}
			return await handle.heartbeatRun(opts);
		},
		async traceRun(opts) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.traceRun) return null;
			return await handle.traceRun(opts);
		},
		async submitTerminalCommand(opts) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle?.submitTerminalCommand) {
				throw new Error("control_plane_unavailable");
			}
			return await handle.submitTerminalCommand(opts);
		},
		async stop() {
			const handle = reloadManager.getControlPlaneCurrent();
			handle?.setWakeDeliveryObserver?.(null);
			reloadManager.setControlPlaneCurrent(null);
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

	const handleRequest = createServerRequestHandler({
		context,
		controlPlaneProxy,
		activitySupervisor,
		heartbeatPrograms,
		cronPrograms,
		loadConfigFromDisk,
		writeConfig,
		reloadControlPlane,
		getControlPlaneStatus: reloadManager.getControlPlaneStatus,
		registerAutoRunHeartbeatProgram,
		disableAutoRunHeartbeatProgram,
		describeError,
		initiateShutdown: options.initiateShutdown,
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
