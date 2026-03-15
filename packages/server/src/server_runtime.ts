import { GenerationTelemetryRecorder } from "@femtomc/mu-control-plane";
import type { MuConfig } from "./config.js";
import { readMuConfigFile } from "./config.js";
import { bootstrapControlPlane } from "./control_plane.js";
import type {
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
	ControlPlaneSessionMutationAction,
} from "./control_plane_contract.js";
import { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";
import { createProcessSessionLifecycle } from "./session_lifecycle.js";
import { type DaemonSessionAdapter, createDaemonSessionAdapter } from "./daemon_session_adapter.js";
import {
	DAEMON_THIN_BOUNDARY,
	DaemonHostHealthReporter,
	type DaemonBoundaryDescriptor,
} from "./daemon_thin_host.js";

type ConfigReader = (repoRoot: string) => Promise<MuConfig>;

export type ServerRuntimeOptions = {
	repoRoot?: string;
	controlPlane?: ControlPlaneHandle | null;
	heartbeatScheduler?: ActivityHeartbeatScheduler;
	generationTelemetry?: GenerationTelemetryRecorder;
	config?: MuConfig;
	configReader?: ConfigReader;
	sessionLifecycle?: ControlPlaneSessionLifecycle;
	/** Optional pre-created session adapter for Syndicate-delegated session domain. */
	sessionAdapter?: DaemonSessionAdapter;
};

export type ServerRuntimeCapabilities = {
	session_lifecycle_actions: readonly ControlPlaneSessionMutationAction[];
	control_plane_bootstrapped: boolean;
	control_plane_adapters: string[];
	/** Daemon boundary descriptor: host-only vs delegated responsibilities. */
	boundary: DaemonBoundaryDescriptor;
};

export type ServerRuntime = {
	repoRoot: string;
	config: MuConfig;
	heartbeatScheduler: ActivityHeartbeatScheduler;
	generationTelemetry: GenerationTelemetryRecorder;
	sessionLifecycle: ControlPlaneSessionLifecycle;
	controlPlane: ControlPlaneHandle | null;
	/** Syndicate-delegated session adapter. Domain state lives here, not in daemon. */
	sessionAdapter: DaemonSessionAdapter;
	/** Host health reporter reading adapter-projected service state. */
	hostHealthReporter: DaemonHostHealthReporter;
	capabilities: ServerRuntimeCapabilities;
};

function computeServerRuntimeCapabilities(controlPlane: ControlPlaneHandle | null): ServerRuntimeCapabilities {
	return {
		session_lifecycle_actions: ["reload", "update"] as const,
		control_plane_bootstrapped: controlPlane !== null,
		control_plane_adapters: controlPlane?.activeAdapters.map((adapter) => adapter.name) ?? [],
		boundary: DAEMON_THIN_BOUNDARY,
	};
}

export async function composeServerRuntime(options: ServerRuntimeOptions = {}): Promise<ServerRuntime> {
	const repoRoot = options.repoRoot || process.cwd();
	const readConfig: ConfigReader = options.configReader ?? readMuConfigFile;
	const config = options.config ?? (await readConfig(repoRoot));
	const heartbeatScheduler = options.heartbeatScheduler ?? new ActivityHeartbeatScheduler();
	const generationTelemetry = options.generationTelemetry ?? new GenerationTelemetryRecorder();
	const sessionLifecycle = options.sessionLifecycle ?? createProcessSessionLifecycle({ repoRoot });
	const sessionAdapter = options.sessionAdapter ?? createDaemonSessionAdapter();
	const hostHealthReporter = new DaemonHostHealthReporter({
		sessionAdapter,
	});
	const controlPlane =
		options.controlPlane !== undefined
			? options.controlPlane
			: await bootstrapControlPlane({
				repoRoot,
				config: config.control_plane,
				generation: {
					generation_id: "control-plane-gen-0",
					generation_seq: 0,
				},
				telemetry: generationTelemetry,
				sessionLifecycle,
				terminalEnabled: true,
			});
	return {
		repoRoot,
		config,
		heartbeatScheduler,
		generationTelemetry,
		sessionLifecycle,
		controlPlane,
		sessionAdapter,
		hostHealthReporter,
		capabilities: computeServerRuntimeCapabilities(controlPlane),
	};
}
