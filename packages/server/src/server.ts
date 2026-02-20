import {
	GenerationTelemetryRecorder,
	presentPipelineResultMessage,
	type CommandPipelineResult,
} from "@femtomc/mu-control-plane";
import type { EventEnvelope, JsonlStore } from "@femtomc/mu-core";
import { currentRunId, EventLog, FsJsonlStore, getStorePaths, JsonlEventSink } from "@femtomc/mu-core/node";
import { DEFAULT_MU_CONFIG, type MuConfig, readMuConfigFile, writeMuConfigFile } from "./config.js";
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
	controlPlaneReloader?: ControlPlaneReloader;
	generationTelemetry?: GenerationTelemetryRecorder;
	operatorWakeCoalesceMs?: number;
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
	eventLog: EventLog;
	eventsStore: JsonlStore<EventEnvelope>;
};

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

type WakeDecisionOutcome = "triggered" | "fallback";

type WakeDecision = {
	outcome: WakeDecisionOutcome;
	reason: string;
	turnRequestId: string | null;
	turnResultKind: string | null;
	turnReply: string | null;
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

function stablePayloadSnapshot(payload: Record<string, unknown>): string {
	try {
		return JSON.stringify(payload) ?? "{}";
	} catch {
		return "[unserializable]";
	}
}

function computeWakeId(opts: { dedupeKey: string; payload: Record<string, unknown> }): string {
	const source = stringField(opts.payload, "wake_source") ?? "unknown";
	const programId = stringField(opts.payload, "program_id") ?? "unknown";
	const sourceTsMs = numberField(opts.payload, "source_ts_ms");
	const payloadSnapshot = stablePayloadSnapshot(opts.payload);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${source}|${programId}|${sourceTsMs ?? "na"}|${opts.dedupeKey}|${payloadSnapshot}`);
	return hasher.digest("hex").slice(0, 16);
}

function extractWakeTurnReply(turnResult: CommandPipelineResult): string | null {
	if (turnResult.kind === "operator_response") {
		const message = turnResult.message.trim();
		return message.length > 0 ? message : null;
	}
	const presented = presentPipelineResultMessage(turnResult);
	const payload = presented.message.payload as Record<string, unknown>;
	const payloadMessage = typeof payload.message === "string" ? payload.message.trim() : "";
	if (payloadMessage.length > 0) {
		return payloadMessage;
	}
	const compact = presented.compact.trim();
	return compact.length > 0 ? compact : null;
}

function buildWakeTurnCommandText(opts: {
	wakeId: string;
	message: string;
	payload: Record<string, unknown>;
}): string {
	const wakeSource = stringField(opts.payload, "wake_source") ?? "unknown";
	const programId = stringField(opts.payload, "program_id") ?? "unknown";
	const reason = stringField(opts.payload, "reason") ?? "scheduled";
	const payloadSnapshot = stablePayloadSnapshot(opts.payload);
	return [
		"Autonomous wake turn triggered by heartbeat/cron scheduler.",
		`wake_id=${opts.wakeId}`,
		`wake_source=${wakeSource}`,
		`program_id=${programId}`,
		`reason=${reason}`,
		`trigger_message=${opts.message}`,
		`payload=${payloadSnapshot}`,
		"",
		"If action is needed, produce exactly one `/mu ...` command. If no action is needed, return a short operator response that can be broadcast verbatim.",
	].join("\n");
}

export function createContext(repoRoot: string): ServerContext {
	const paths = getStorePaths(repoRoot);
	const eventsStore = new FsJsonlStore<EventEnvelope>(paths.eventsPath);
	const eventLog = new EventLog(new JsonlEventSink(eventsStore), {
		runIdProvider: currentRunId,
	});

	return { repoRoot, eventLog, eventsStore };
}

function createServer(options: ServerOptions = {}) {
	const repoRoot = options.repoRoot || process.cwd();
	const context = createContext(repoRoot);

	const readConfig: ConfigReader = options.configReader ?? readMuConfigFile;
	const writeConfig: ConfigWriter = options.configWriter ?? writeMuConfigFile;
	const fallbackConfig = options.config ?? DEFAULT_MU_CONFIG;
	const heartbeatScheduler = options.heartbeatScheduler ?? new ActivityHeartbeatScheduler();

	const operatorWakeCoalesceMs = toNonNegativeInt(options.operatorWakeCoalesceMs, DEFAULT_OPERATOR_WAKE_COALESCE_MS);
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
	}): Promise<{ status: "dispatched" | "coalesced" | "failed"; reason: string }> => {
		const dedupeKey = opts.dedupeKey.trim();
		if (!dedupeKey) {
			return { status: "failed", reason: "missing_dedupe_key" };
		}
		const nowMs = Date.now();
		const coalesceMs = Math.max(0, Math.trunc(opts.coalesceMs ?? operatorWakeCoalesceMs));
		const previous = operatorWakeLastByKey.get(dedupeKey);
		if (typeof previous === "number" && nowMs - previous < coalesceMs) {
			return { status: "coalesced", reason: "coalesced_window" };
		}
		operatorWakeLastByKey.set(dedupeKey, nowMs);

		const wakeId = computeWakeId({ dedupeKey, payload: opts.payload });
		const wakeSource = stringField(opts.payload, "wake_source");
		const programId = stringField(opts.payload, "program_id");
		const sourceTsMs = numberField(opts.payload, "source_ts_ms");

		let decision: WakeDecision;
		if (typeof controlPlaneProxy.submitTerminalCommand !== "function") {
			decision = {
				outcome: "fallback",
				reason: "control_plane_unavailable",
				turnRequestId: null,
				turnResultKind: null,
				turnReply: null,
				error: null,
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
						turnRequestId,
						turnResultKind: turnResult.kind,
						turnReply: null,
						error: null,
					};
				} else {
					const turnReply = extractWakeTurnReply(turnResult);
					if (!turnReply) {
						decision = {
							outcome: "fallback",
							reason: "turn_reply_empty",
							turnRequestId,
							turnResultKind: turnResult.kind,
							turnReply: null,
							error: null,
						};
					} else {
						decision = {
							outcome: "triggered",
							reason: "turn_invoked",
							turnRequestId,
							turnResultKind: turnResult.kind,
							turnReply,
							error: null,
						};
					}
				}
			} catch (err) {
				const error = describeError(err);
				decision = {
					outcome: "fallback",
					reason: error === "control_plane_unavailable" ? "control_plane_unavailable" : "turn_execution_failed",
					turnRequestId,
					turnResultKind: null,
					turnReply: null,
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
				wake_turn_outcome: decision.outcome,
				wake_turn_reason: decision.reason,
				turn_request_id: decision.turnRequestId,
				turn_result_kind: decision.turnResultKind,
				turn_reply_present: decision.turnReply != null,
				wake_turn_error: decision.error,
			},
		});

		let notifyResult = emptyNotifyOperatorsResult();
		let notifyError: string | null = null;
		let deliverySkippedReason: string | null = null;
		if (!decision.turnReply) {
			deliverySkippedReason = "no_turn_reply";
		} else if (typeof controlPlaneProxy.notifyOperators !== "function") {
			deliverySkippedReason = "notify_operators_unavailable";
		} else {
			try {
				notifyResult = await controlPlaneProxy.notifyOperators({
					message: decision.turnReply,
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
						wake_turn_result_kind: decision.turnResultKind,
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
				trigger_message: opts.message,
				broadcast_message: decision.turnReply,
				broadcast_message_present: decision.turnReply != null,
				dedupe_key: dedupeKey,
				coalesce_ms: coalesceMs,
				...opts.payload,
				wake_id: wakeId,
				wake_turn_outcome: decision.outcome,
				wake_turn_reason: decision.reason,
				turn_request_id: decision.turnRequestId,
				turn_result_kind: decision.turnResultKind,
				wake_turn_error: decision.error,
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
				delivery_skipped_reason: deliverySkippedReason,
				delivery_error: notifyError,
			},
		});

		if (decision.outcome !== "triggered") {
			return { status: "failed", reason: decision.reason };
		}
		if (!decision.turnReply) {
			return { status: "failed", reason: "no_turn_reply" };
		}
		if (notifyError) {
			return { status: "failed", reason: "notify_failed" };
		}
		if (deliverySkippedReason === "notify_operators_unavailable") {
			return { status: "failed", reason: deliverySkippedReason };
		}
		return { status: "dispatched", reason: "operator_reply_broadcast" };
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

	const { heartbeatPrograms, cronPrograms } = createServerProgramOrchestration({
		repoRoot,
		heartbeatScheduler,
		eventLog: context.eventLog,
		emitOperatorWake,
	});

	const handleRequest = createServerRequestHandler({
		context,
		controlPlaneProxy,
		heartbeatPrograms,
		cronPrograms,
		loadConfigFromDisk,
		writeConfig,
		reloadControlPlane,
		getControlPlaneStatus: reloadManager.getControlPlaneStatus,
		describeError,
		initiateShutdown: options.initiateShutdown,
	});

	const server = {
		port: options.port || 3000,
		fetch: handleRequest,
		hostname: "0.0.0.0",
		controlPlane: controlPlaneProxy,
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
