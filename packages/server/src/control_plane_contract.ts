import type { Channel, CommandPipelineResult, ReloadableGenerationIdentity } from "@femtomc/mu-control-plane";
import type {
	ControlPlaneRunHeartbeatResult,
	ControlPlaneRunInterruptResult,
	ControlPlaneRunSnapshot,
	ControlPlaneRunTrace,
} from "./run_supervisor.js";
import type { MuConfig } from "./config.js";

/**
 * Boundary contracts for server/control-plane composition.
 *
 * Dependency direction:
 * - Domain/application code should depend on these contracts.
 * - Interface adapters in `control_plane.ts` implement these seams.
 */

// Domain seam: immutable runtime configuration shape consumed by control-plane bootstrap/reload.
export type ControlPlaneConfig = MuConfig["control_plane"];

// Application seam: server-visible adapter/routing surface.
export type ActiveAdapter = {
	name: Channel;
	route: string;
};

// Interface seam: generation lifecycle payload used for status/reload responses.
export type TelegramGenerationRollbackTrigger =
	| "manual"
	| "warmup_failed"
	| "health_gate_failed"
	| "cutover_failed"
	| "post_cutover_health_failed"
	| "rollback_unavailable"
	| "rollback_failed";

export type TelegramGenerationReloadResult = {
	handled: boolean;
	ok: boolean;
	reason: string;
	route: string;
	from_generation: ReloadableGenerationIdentity | null;
	to_generation: ReloadableGenerationIdentity | null;
	active_generation: ReloadableGenerationIdentity | null;
	warmup: {
		ok: boolean;
		elapsed_ms: number;
		error?: string;
	} | null;
	cutover: {
		ok: boolean;
		elapsed_ms: number;
		error?: string;
	} | null;
	drain: {
		ok: boolean;
		elapsed_ms: number;
		timed_out: boolean;
		forced_stop: boolean;
		error?: string;
	} | null;
	rollback: {
		requested: boolean;
		trigger: TelegramGenerationRollbackTrigger | null;
		attempted: boolean;
		ok: boolean;
		error?: string;
	};
	error?: string;
};

export type ControlPlaneGenerationContext = ReloadableGenerationIdentity;

export type TelegramGenerationSwapHooks = {
	onWarmup?: (ctx: { generation: ReloadableGenerationIdentity; reason: string }) => void | Promise<void>;
	onCutover?: (ctx: {
		from_generation: ReloadableGenerationIdentity | null;
		to_generation: ReloadableGenerationIdentity;
		reason: string;
	}) => void | Promise<void>;
	onDrain?: (ctx: {
		generation: ReloadableGenerationIdentity;
		reason: string;
		timeout_ms: number;
	}) => void | Promise<void>;
};

export type ControlPlaneSessionMutationAction = "reload" | "update";

export type ControlPlaneSessionMutationResult = {
	ok: boolean;
	action: ControlPlaneSessionMutationAction;
	message: string;
	details?: Record<string, unknown>;
};

export type ControlPlaneSessionLifecycle = {
	reload: () => Promise<ControlPlaneSessionMutationResult>;
	update: () => Promise<ControlPlaneSessionMutationResult>;
};

export type ControlPlaneHandle = {
	activeAdapters: ActiveAdapter[];
	handleWebhook(path: string, req: Request): Promise<Response | null>;
	reloadTelegramGeneration?(opts: {
		config: ControlPlaneConfig;
		reason: string;
	}): Promise<TelegramGenerationReloadResult>;
	listRuns?(opts?: { status?: string; limit?: number }): Promise<ControlPlaneRunSnapshot[]>;
	getRun?(idOrRoot: string): Promise<ControlPlaneRunSnapshot | null>;
	startRun?(opts: { prompt: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot>;
	resumeRun?(opts: { rootIssueId: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot>;
	interruptRun?(opts: { jobId?: string | null; rootIssueId?: string | null }): Promise<ControlPlaneRunInterruptResult>;
	heartbeatRun?(opts: {
		jobId?: string | null;
		rootIssueId?: string | null;
		reason?: string | null;
		wakeMode?: string | null;
	}): Promise<ControlPlaneRunHeartbeatResult>;
	traceRun?(opts: { idOrRoot: string; limit?: number }): Promise<ControlPlaneRunTrace | null>;
	submitTerminalCommand?(opts: {
		commandText: string;
		repoRoot: string;
		requestId?: string;
	}): Promise<CommandPipelineResult>;
	stop(): Promise<void>;
};
