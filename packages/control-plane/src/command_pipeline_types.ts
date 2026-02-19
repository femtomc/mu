import type { CommandContextResolverLike } from "./command_context.js";
import type { CommandRecord, CommandRecordTraceUpdate } from "./command_record.js";
import type { IdentityStore } from "./identity_store.js";
import type { MuCliCommandSurface, MuCliRunnerLike } from "./mu_cli_runner.js";
import type { MessagingOperatorRuntimeLike } from "./operator_contract.js";
import type { PolicyEngine } from "./policy.js";
import type { ControlPlaneRuntime } from "./runtime.js";

export type CommandPipelineResult =
	| { kind: "noop"; reason: string }
	| { kind: "invalid"; reason: string }
	| { kind: "operator_response"; message: string }
	| { kind: "denied"; reason: string }
	| { kind: "awaiting_confirmation"; command: CommandRecord }
	| { kind: "completed"; command: CommandRecord }
	| { kind: "cancelled"; command: CommandRecord }
	| { kind: "expired"; command: CommandRecord }
	| { kind: "deferred"; command: CommandRecord }
	| { kind: "failed"; command: CommandRecord; reason: string };

export type MutationCommandExecutionEvent = {
	eventType: string;
	payload: Record<string, unknown>;
};

export type CommandExecutionTrace = Pick<
	CommandRecordTraceUpdate,
	"operatorSessionId" | "operatorTurnId" | "cliInvocationId" | "cliCommandKind" | "runRootId"
>;

export type MutationCommandExecutionResult =
	| {
			terminalState: "completed";
			result?: Record<string, unknown> | null;
			errorCode?: string | null;
			mutatingEvents?: readonly MutationCommandExecutionEvent[];
			trace?: CommandExecutionTrace;
	  }
	| {
			terminalState: "failed";
			errorCode: string;
			mutatingEvents?: readonly MutationCommandExecutionEvent[];
			trace?: CommandExecutionTrace;
	  }
	| {
			terminalState: "cancelled";
			errorCode?: string | null;
			mutatingEvents?: readonly MutationCommandExecutionEvent[];
			trace?: CommandExecutionTrace;
	  }
	| {
			terminalState: "deferred";
			retryAtMs: number;
			errorCode?: string | null;
			mutatingEvents?: readonly MutationCommandExecutionEvent[];
			trace?: CommandExecutionTrace;
	  };

export type MutationCommandExecutor = (record: CommandRecord) => Promise<MutationCommandExecutionResult | null>;

export type ReadonlyCommandExecutor = (record: CommandRecord) => Promise<Record<string, unknown> | null>;

export type ControlPlaneCommandPipelineOpts = {
	runtime: ControlPlaneRuntime;
	identityStore?: IdentityStore;
	policyEngine?: PolicyEngine;
	policyPath?: string;
	confirmationTtlMs?: number;
	nowMs?: () => number;
	commandIdFactory?: () => string;
	cliInvocationIdFactory?: () => string;
	mutationExecutor?: MutationCommandExecutor;
	readonlyExecutor?: ReadonlyCommandExecutor;
	operator?: MessagingOperatorRuntimeLike | null;
	contextResolver?: CommandContextResolverLike;
	cliCommandSurface?: MuCliCommandSurface | null;
	cliRunner?: MuCliRunnerLike | null;
};
