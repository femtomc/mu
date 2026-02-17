export type ReloadLifecycleReason =
	| "startup"
	| "api_control_plane_reload"
	| "config_changed"
	| "rollback"
	| "shutdown"
	| (string & {});

export type ReloadableGenerationIdentity = {
	generation_id: string;
	generation_seq: number;
};

export type ReloadableModuleInitArgs<InitConfig, KernelDeps, Checkpoint = unknown> = {
	generation: ReloadableGenerationIdentity;
	config: InitConfig;
	deps: KernelDeps;
	restore_from?: Checkpoint | null;
};

export type ReloadableModuleDrainArgs = {
	timeout_ms: number;
	reason: ReloadLifecycleReason;
};

export type ReloadableModuleDrainResult = {
	ok: boolean;
	drained: boolean;
	in_flight_at_start: number;
	in_flight_at_end: number;
	elapsed_ms: number;
	timed_out: boolean;
};

export type ReloadableModuleShutdownArgs = {
	reason: ReloadLifecycleReason;
	force: boolean;
};

export interface ReloadableModuleLifecycle<InitConfig, KernelDeps, Event, Reply, Checkpoint = unknown> {
	init(args: ReloadableModuleInitArgs<InitConfig, KernelDeps, Checkpoint>): Promise<void>;
	handle(event: Event): Promise<Reply>;
	drain(args: ReloadableModuleDrainArgs): Promise<ReloadableModuleDrainResult>;
	checkpoint?(): Promise<Checkpoint | null>;
	shutdown(args: ReloadableModuleShutdownArgs): Promise<void>;
}

export type GenerationReloadAttemptState = "planned" | "swapped" | "completed" | "failed";

export type GenerationReloadAttempt = {
	attempt_id: string;
	reason: ReloadLifecycleReason;
	state: GenerationReloadAttemptState;
	requested_at_ms: number;
	swapped_at_ms: number | null;
	finished_at_ms: number | null;
	from_generation: ReloadableGenerationIdentity | null;
	to_generation: ReloadableGenerationIdentity;
};

export type GenerationSupervisorSnapshot = {
	supervisor_id: string;
	active_generation: ReloadableGenerationIdentity | null;
	pending_reload: GenerationReloadAttempt | null;
	last_reload: GenerationReloadAttempt | null;
};

export type GenerationSupervisorWiring<InitConfig, KernelDeps, Event, Reply, Checkpoint = unknown> = {
	supervisor_id: string;
	module_name: string;
	current_generation: ReloadableGenerationIdentity | null;
	build_module: (
		generation: ReloadableGenerationIdentity,
	) => ReloadableModuleLifecycle<InitConfig, KernelDeps, Event, Reply, Checkpoint>;
};
