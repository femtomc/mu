import { GenerationTelemetryRecorder } from "@femtomc/mu-control-plane";
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
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
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

	const controlPlaneProxy: ControlPlaneHandle = {
		get activeAdapters() {
			return reloadManager.getControlPlaneCurrent()?.activeAdapters ?? [];
		},
		async handleWebhook(path, req) {
			const handle = reloadManager.getControlPlaneCurrent();
			if (!handle) return null;
			return await handle.handleWebhook(path, req);
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
		reloadControlPlane: reloadManager.reloadControlPlane,
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
