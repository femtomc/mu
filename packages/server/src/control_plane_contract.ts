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

/**
 * Durable orchestration queue contract (default-on path).
 */
export type { InterRootQueuePolicy, OrchestrationQueueState } from "./orchestration_queue.js";
export {
	DEFAULT_INTER_ROOT_QUEUE_POLICY,
	normalizeInterRootQueuePolicy,
	ORCHESTRATION_QUEUE_ALLOWED_TRANSITIONS,
	ORCHESTRATION_QUEUE_INVARIANTS,
} from "./orchestration_queue.js";

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

export type WakeDeliveryState = "queued" | "duplicate" | "skipped" | "delivered" | "retried" | "dead_letter";

export type WakeNotifyDecision = {
	state: "queued" | "duplicate" | "skipped";
	reason_code: string;
	binding_id: string;
	channel: Channel;
	dedupe_key: string;
	outbox_id: string | null;
};

export type WakeNotifyContext = {
	wakeId: string;
	wakeSource?: string | null;
	programId?: string | null;
	sourceTsMs?: number | null;
};

export type NotifyOperatorsOpts = {
	message: string;
	dedupeKey: string;
	wake?: WakeNotifyContext | null;
	metadata?: Record<string, unknown>;
};

export type NotifyOperatorsResult = {
	queued: number;
	duplicate: number;
	skipped: number;
	decisions: WakeNotifyDecision[];
};

export type WakeDeliveryEvent = {
	state: "delivered" | "retried" | "dead_letter";
	reason_code: string;
	wake_id: string;
	dedupe_key: string;
	binding_id: string;
	channel: Channel;
	outbox_id: string;
	outbox_dedupe_key: string;
	attempt_count: number;
};

export type WakeDeliveryObserver = (event: WakeDeliveryEvent) => void | Promise<void>;

export type ControlPlaneHandle = {
	activeAdapters: ActiveAdapter[];
	handleWebhook(path: string, req: Request): Promise<Response | null>;
	notifyOperators?(opts: NotifyOperatorsOpts): Promise<NotifyOperatorsResult>;
	setWakeDeliveryObserver?(observer: WakeDeliveryObserver | null): void;
	reloadTelegramGeneration?(opts: {
		config: ControlPlaneConfig;
		reason: string;
	}): Promise<TelegramGenerationReloadResult>;
	listRuns?(opts?: { status?: string; limit?: number }): Promise<ControlPlaneRunSnapshot[]>;
	getRun?(idOrRoot: string): Promise<ControlPlaneRunSnapshot | null>;
	/**
	 * Run lifecycle boundary: accepts start intent into the default queue/reconcile path.
	 * Compatibility adapters may dispatch immediately after enqueue, but must preserve queue invariants.
	 */
	startRun?(opts: { prompt: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot>;
	/**
	 * Run lifecycle boundary: accepts resume intent into the default queue/reconcile path.
	 * No flag-based alternate path is allowed.
	 */
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
