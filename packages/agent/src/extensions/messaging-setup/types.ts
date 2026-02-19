/**
 * Type definitions for mu-messaging-setup adapter configuration.
 */

export type AdapterSupport = "available" | "planned";
export type AdapterId = "slack" | "discord" | "telegram";
export type SetupAction = "check" | "preflight" | "guide" | "plan" | "apply" | "verify";

export type AdapterField = {
	key: string;
	required: boolean;
	description: string;
};

export type AdapterConfig = {
	id: AdapterId;
	name: string;
	support: AdapterSupport;
	fields: AdapterField[];
	providerSetupSteps: string[];
	notes?: string[];
};

export type RuntimeState = {
	repoRoot: string | null;
	configPath: string | null;
	runtimeActive: boolean;
	routesByAdapter: Map<string, string>;
	configPresence: ConfigPresence | null;
	fetchError: string | null;
};

export type AdapterCheck = {
	id: AdapterId;
	name: string;
	support: AdapterSupport;
	configured: boolean;
	missing: string[];
	active: boolean;
	route: string | null;
	state: "active" | "configured_not_active" | "missing_config" | "planned";
	next_step: string;
	notes: string[];
};

export type AdapterPlan = {
	id: AdapterId;
	name: string;
	support: AdapterSupport;
	state: AdapterCheck["state"];
	route: string;
	webhook_url: string | null;
	required_fields: string[];
	missing_required_fields: string[];
	steps: string[];
	commands: {
		apply: string;
		verify: string;
	};
};

export type ApplyOutcome =
	| {
			ok: true;
			adapter: AdapterId;
			updated_fields: string[];
			config_path: string | null;
			reload: ControlPlaneReloadOutcome;
	  }
	| {
			ok: false;
			adapter: AdapterId;
			reason: string;
			missing_required_fields: string[];
			reload?: ControlPlaneReloadOutcome;
	  };

export type VerifyOutcome = {
	ok: boolean;
	targets: AdapterCheck[];
	public_base_url: string | null;
};

export type ConfigPresence = {
	control_plane: {
		adapters: {
			slack: {
				signing_secret: boolean;
			};
			discord: {
				signing_secret: boolean;
			};
			telegram: {
				webhook_secret: boolean;
				bot_token: boolean;
				bot_username: boolean;
			};
		};
		operator: {
			enabled: boolean;
			run_triggers_enabled: boolean;
			provider: boolean;
			model: boolean;
		};
	};
};

export type ConfigReadResponse = {
	repo_root: string;
	config_path: string;
	presence: ConfigPresence;
};

export type ConfigWriteResponse = {
	ok: boolean;
	repo_root: string;
	config_path: string;
	presence: ConfigPresence;
};

export type ControlPlaneGenerationIdentity = { generation_id: string; generation_seq: number };

export type ControlPlaneReloadGenerationSummary = {
	attempt_id: string;
	coalesced: boolean;
	from_generation: ControlPlaneGenerationIdentity | null;
	to_generation: ControlPlaneGenerationIdentity;
	active_generation: ControlPlaneGenerationIdentity | null;
	outcome: "success" | "failure";
};

export type ControlPlaneReloadApiResponse = {
	ok: boolean;
	reason: string;
	previous_control_plane?: {
		active: boolean;
		adapters: string[];
		routes: Array<{ name: string; route: string }>;
	};
	control_plane?: {
		active: boolean;
		adapters: string[];
		routes: Array<{ name: string; route: string }>;
	};
	generation: ControlPlaneReloadGenerationSummary;
	telegram_generation: {
		handled: boolean;
		ok: boolean;
		rollback: {
			requested: boolean;
			trigger: string | null;
			attempted: boolean;
			ok: boolean;
			error?: string;
		};
	} | null;
	error?: string;
};

export type ControlPlaneReloadOutcome = {
	ok: boolean;
	response: ControlPlaneReloadApiResponse | null;
	error: string | null;
};
