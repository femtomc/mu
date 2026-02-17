import { CommandContextResolver, type MessagingOperatorRuntime } from "@femtomc/mu-agent";
import { type ParsedCommand, parseSeriousWorkCommand } from "./command_parser.js";
import {
	applyCommandRecordTrace,
	type CommandRecord,
	type CommandRecordTraceUpdate,
	createAcceptedCommandRecord,
	transitionCommandRecord,
} from "./command_record.js";
import { ConfirmationManager } from "./confirmation_manager.js";
import { ChannelSchema, type IdentityBinding, IdentityStore } from "./identity_store.js";
import { type InboundEnvelope, InboundEnvelopeSchema } from "./models.js";
import { MuCliCommandSurface, MuCliRunner, type MuCliRunnerLike } from "./mu_cli_runner.js";
import { DEFAULT_CONTROL_PLANE_POLICY, PolicyEngine, type RequestedCommandMode } from "./policy.js";
import type { ControlPlaneRuntime } from "./runtime.js";

function defaultCommandIdFactory(): string {
	return `cmd-${crypto.randomUUID()}`;
}

function defaultCliInvocationIdFactory(): string {
	return `cli-${crypto.randomUUID()}`;
}

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
	operator?: MessagingOperatorRuntime | null;
	contextResolver?: CommandContextResolver;
	cliCommandSurface?: MuCliCommandSurface | null;
	cliRunner?: MuCliRunnerLike | null;
};

function idempotencyTtlMs(mutating: boolean): number {
	return mutating ? 30 * 24 * 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
}

function resolveOpsClass(record: CommandRecord, engine: PolicyEngine): string {
	const rule = engine.ruleForCommand(record.target_type);
	return rule?.ops_class ?? "default";
}

function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

function normalizeFingerprint(input: string): string {
	return `fp-${sha256Hex(input)}`;
}

function truncateText(value: string, maxLen: number = 4_000): string {
	if (value.length <= maxLen) {
		return value;
	}
	if (maxLen <= 3) {
		return value.slice(0, maxLen);
	}
	return `${value.slice(0, maxLen - 3)}...`;
}

export class ControlPlaneCommandPipeline {
	public readonly runtime: ControlPlaneRuntime;
	public readonly identities: IdentityStore;
	public readonly policy: PolicyEngine;
	public readonly confirmations: ConfirmationManager;
	readonly #confirmationTtlMs: number;
	readonly #nowMs: () => number;
	readonly #commandIdFactory: () => string;
	readonly #cliInvocationIdFactory: () => string;
	readonly #policyPath: string | null;
	readonly #mutationExecutor: MutationCommandExecutor | null;
	readonly #readonlyExecutor: ReadonlyCommandExecutor | null;
	readonly #operator: MessagingOperatorRuntime | null;
	readonly #contextResolver: CommandContextResolver;
	readonly #cliCommandSurface: MuCliCommandSurface | null;
	readonly #cliRunner: MuCliRunnerLike | null;
	#started = false;

	public constructor(opts: ControlPlaneCommandPipelineOpts) {
		this.runtime = opts.runtime;
		this.identities = opts.identityStore ?? new IdentityStore(this.runtime.paths.identitiesPath);
		this.policy = opts.policyEngine ?? new PolicyEngine(DEFAULT_CONTROL_PLANE_POLICY);
		this.#policyPath = opts.policyPath ?? (opts.policyEngine === undefined ? this.runtime.paths.policyPath : null);
		this.#confirmationTtlMs = Math.trunc(opts.confirmationTtlMs ?? 10 * 60 * 1_000);
		if (this.#confirmationTtlMs <= 0) {
			throw new Error(`confirmationTtlMs must be positive, got ${opts.confirmationTtlMs}`);
		}
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#commandIdFactory = opts.commandIdFactory ?? defaultCommandIdFactory;
		this.#cliInvocationIdFactory = opts.cliInvocationIdFactory ?? defaultCliInvocationIdFactory;
		this.#mutationExecutor = opts.mutationExecutor ?? null;
		this.#readonlyExecutor = opts.readonlyExecutor ?? null;
		this.#operator = opts.operator ?? null;
		this.#contextResolver =
			opts.contextResolver ?? new CommandContextResolver({ allowedRepoRoots: [this.runtime.paths.repoRoot] });
		this.#cliCommandSurface = opts.cliCommandSurface ?? new MuCliCommandSurface();
		this.#cliRunner = opts.cliRunner ?? new MuCliRunner();
		this.confirmations = new ConfirmationManager(this.runtime.journal, { nowMs: this.#nowMs });
	}

	public async start(): Promise<void> {
		if (this.#started) {
			return;
		}
		await this.runtime.start();
		await this.identities.load();
		if (this.#policyPath) {
			await this.policy.reloadFromFile(this.#policyPath);
		}
		this.#started = true;
	}

	public async stop(): Promise<void> {
		if (!this.#started) {
			return;
		}
		this.#started = false;
		try {
			const operator = this.#operator as { stop?: () => Promise<void> } | null;
			await operator?.stop?.();
		} finally {
			await this.runtime.stop();
		}
	}

	#assertStarted(): void {
		if (!this.#started) {
			throw new Error("control-plane command pipeline not started");
		}
	}

	#resolveBinding(inbound: InboundEnvelope): IdentityBinding | null {
		const channel = ChannelSchema.safeParse(inbound.channel);
		if (!channel.success) {
			return null;
		}
		const binding = this.identities.resolveActive({
			channel: channel.data,
			channelTenantId: inbound.channel_tenant_id,
			channelActorId: inbound.actor_id,
		});
		if (!binding) {
			return null;
		}
		if (binding.binding_id !== inbound.actor_binding_id) {
			return null;
		}
		return binding;
	}

	#normalizeInboundForCommand(opts: {
		inbound: InboundEnvelope;
		binding: IdentityBinding;
		commandKey: string;
		targetId: string;
		effectiveScope: string;
		normalizedText: string;
	}): InboundEnvelope {
		return InboundEnvelopeSchema.parse({
			...opts.inbound,
			actor_binding_id: opts.binding.binding_id,
			assurance_tier: opts.binding.assurance_tier,
			command_text: opts.normalizedText,
			scope_required: opts.effectiveScope,
			scope_effective: opts.effectiveScope,
			target_type: opts.commandKey,
			target_id: opts.targetId,
			fingerprint: normalizeFingerprint(opts.normalizedText.toLowerCase()),
		});
	}

	#traceFromOutcome(outcome: MutationCommandExecutionResult): CommandRecordTraceUpdate {
		return {
			operatorSessionId: outcome.trace?.operatorSessionId,
			operatorTurnId: outcome.trace?.operatorTurnId,
			cliInvocationId: outcome.trace?.cliInvocationId,
			cliCommandKind: outcome.trace?.cliCommandKind,
			runRootId: outcome.trace?.runRootId,
		};
	}

	async #applyMutationExecutionOutcome(
		inProgress: CommandRecord,
		outcome: MutationCommandExecutionResult,
	): Promise<CommandPipelineResult> {
		const trace = this.#traceFromOutcome(outcome);
		const tracedInProgress = applyCommandRecordTrace(inProgress, trace);
		const events = outcome.mutatingEvents ?? [];
		for (const event of events) {
			await this.runtime.journal.appendMutatingDomainEvent({
				eventType: event.eventType,
				command: tracedInProgress,
				state: "in_progress",
				payload: event.payload,
			});
		}

		switch (outcome.terminalState) {
			case "completed": {
				const completed = transitionCommandRecord(tracedInProgress, {
					nextState: "completed",
					nowMs: Math.trunc(this.#nowMs()),
					result: outcome.result ?? null,
					errorCode: outcome.errorCode ?? null,
					...trace,
				});
				await this.runtime.journal.appendLifecycle(completed);
				return { kind: "completed", command: completed };
			}
			case "deferred": {
				const deferred = transitionCommandRecord(tracedInProgress, {
					nextState: "deferred",
					nowMs: Math.trunc(this.#nowMs()),
					retryAtMs: Math.trunc(outcome.retryAtMs),
					errorCode: outcome.errorCode ?? null,
					...trace,
				});
				await this.runtime.journal.appendLifecycle(deferred);
				return { kind: "deferred", command: deferred };
			}
			case "cancelled": {
				const cancelled = transitionCommandRecord(tracedInProgress, {
					nextState: "cancelled",
					nowMs: Math.trunc(this.#nowMs()),
					errorCode: outcome.errorCode ?? null,
					...trace,
				});
				await this.runtime.journal.appendLifecycle(cancelled);
				return { kind: "cancelled", command: cancelled };
			}
			case "failed": {
				const failed = transitionCommandRecord(tracedInProgress, {
					nextState: "failed",
					nowMs: Math.trunc(this.#nowMs()),
					errorCode: outcome.errorCode,
					...trace,
				});
				await this.runtime.journal.appendLifecycle(failed);
				return { kind: "failed", command: failed, reason: outcome.errorCode };
			}
		}
	}

	#resolveCommandArgsForCli(record: CommandRecord): string[] {
		if ((record.command_args?.length ?? 0) > 0) {
			return [...record.command_args];
		}

		if (record.command_text) {
			const tokens = record.command_text
				.split(/\s+/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0);
			const keyTokens = record.target_type
				.toLowerCase()
				.split(/\s+/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0);
			const normalized =
				tokens[0]?.toLowerCase() === "/mu" ||
				tokens[0]?.toLowerCase() === "mu!" ||
				tokens[0]?.toLowerCase() === "mu?"
					? tokens.slice(1)
					: tokens;
			const lowerNormalized = normalized.map((token) => token.toLowerCase());
			const startsWithCommandKey =
				keyTokens.length <= lowerNormalized.length &&
				keyTokens.every((token, idx) => lowerNormalized[idx] === token);
			if (startsWithCommandKey) {
				return normalized.slice(keyTokens.length);
			}
		}

		switch (record.target_type) {
			case "issue get":
			case "issue update":
			case "issue claim":
			case "issue close":
			case "forum read":
			case "audit get":
			case "dlq inspect":
			case "dlq replay":
			case "run resume":
			case "run status":
			case "run interrupt":
				return [record.target_id];
			default:
				return [];
		}
	}

	async #executeAllowlistedCliCommand(opts: {
		record: CommandRecord;
		expectedMutating: boolean;
	}): Promise<MutationCommandExecutionResult | null> {
		if (!this.#cliCommandSurface || !this.#cliRunner) {
			return null;
		}

		const commandArgs = this.#resolveCommandArgsForCli(opts.record);
		const invocationId = this.#cliInvocationIdFactory();
		const planDecision = this.#cliCommandSurface.build({
			commandKey: opts.record.target_type,
			args: commandArgs,
			invocationId,
		});

		if (planDecision.kind === "skip") {
			return null;
		}
		if (planDecision.kind === "reject") {
			return {
				terminalState: "failed",
				errorCode: planDecision.reason,
				trace: {
					cliInvocationId: invocationId,
					cliCommandKind: null,
					runRootId: null,
				},
				mutatingEvents: [
					{
						eventType: "cli.invocation.rejected",
						payload: {
							invocation_id: invocationId,
							reason: planDecision.reason,
							details: planDecision.details ?? null,
							command_key: opts.record.target_type,
							command_args: commandArgs,
						},
					},
				],
			};
		}

		const plan = planDecision.plan;
		if (plan.mutating !== opts.expectedMutating) {
			return {
				terminalState: "failed",
				errorCode: "cli_validation_failed",
				trace: {
					cliInvocationId: plan.invocationId,
					cliCommandKind: plan.commandKind,
					runRootId: plan.runRootId,
				},
				mutatingEvents: [
					{
						eventType: "cli.invocation.rejected",
						payload: {
							invocation_id: plan.invocationId,
							reason: "mutating_mismatch",
							expected_mutating: opts.expectedMutating,
							plan_mutating: plan.mutating,
							command_key: opts.record.target_type,
							command_args: commandArgs,
						},
					},
				],
			};
		}

		const startEvent: MutationCommandExecutionEvent = {
			eventType: "cli.invocation.started",
			payload: {
				invocation_id: plan.invocationId,
				command_kind: plan.commandKind,
				argv: plan.argv,
				timeout_ms: plan.timeoutMs,
				command_args: commandArgs,
			},
		};
		const runResult = await this.#cliRunner.run({
			plan,
			repoRoot: opts.record.repo_root,
		});

		if (runResult.kind === "failed") {
			return {
				terminalState: "failed",
				errorCode: runResult.errorCode,
				trace: {
					cliInvocationId: plan.invocationId,
					cliCommandKind: plan.commandKind,
					runRootId: runResult.runRootId,
				},
				mutatingEvents: [
					startEvent,
					{
						eventType: "cli.invocation.failed",
						payload: {
							invocation_id: plan.invocationId,
							command_kind: plan.commandKind,
							error_code: runResult.errorCode,
							exit_code: runResult.exitCode,
							stdout: truncateText(runResult.stdout),
							stderr: truncateText(runResult.stderr),
							run_root_id: runResult.runRootId,
						},
					},
				],
			};
		}

		return {
			terminalState: "completed",
			result: {
				ok: true,
				cli_invocation_id: plan.invocationId,
				cli_command_kind: plan.commandKind,
				exit_code: runResult.exitCode,
				stdout: truncateText(runResult.stdout),
				stderr: truncateText(runResult.stderr),
				run_root_id: runResult.runRootId,
			},
			trace: {
				cliInvocationId: plan.invocationId,
				cliCommandKind: plan.commandKind,
				runRootId: runResult.runRootId,
			},
			mutatingEvents: [
				startEvent,
				{
					eventType: "cli.invocation.completed",
					payload: {
						invocation_id: plan.invocationId,
						command_kind: plan.commandKind,
						exit_code: runResult.exitCode,
						run_root_id: runResult.runRootId,
					},
				},
			],
		};
	}

	async #handleConfirmedQueuedMutation(record: CommandRecord): Promise<CommandPipelineResult> {
		const nowMs = Math.trunc(this.#nowMs());
		const opsClass = resolveOpsClass(record, this.policy);
		const safetyDecision = this.policy.evaluateMutationSafety({
			channel: record.channel,
			actorBindingId: record.actor_binding_id,
			opsClass,
			nowMs,
		});

		if (safetyDecision.kind === "deny") {
			const failed = transitionCommandRecord(record, {
				nextState: "failed",
				nowMs,
				errorCode: safetyDecision.reason,
			});
			await this.runtime.journal.appendLifecycle(failed);
			return { kind: "failed", command: failed, reason: safetyDecision.reason };
		}

		const inProgress = transitionCommandRecord(record, {
			nextState: "in_progress",
			nowMs,
			errorCode: null,
		});
		await this.runtime.journal.appendLifecycle(inProgress);

		if (safetyDecision.kind === "defer") {
			const deferred = transitionCommandRecord(inProgress, {
				nextState: "deferred",
				nowMs: Math.trunc(this.#nowMs()),
				retryAtMs: Math.trunc(safetyDecision.retryAtMs),
				errorCode: safetyDecision.reason,
			});
			await this.runtime.journal.appendLifecycle(deferred);
			return { kind: "deferred", command: deferred };
		}

		if (this.#mutationExecutor) {
			const customOutcome = await this.#mutationExecutor(inProgress);
			if (customOutcome) {
				return await this.#applyMutationExecutionOutcome(inProgress, customOutcome);
			}
		}

		const cliOutcome = await this.#executeAllowlistedCliCommand({
			record: inProgress,
			expectedMutating: true,
		});
		if (cliOutcome) {
			return await this.#applyMutationExecutionOutcome(inProgress, cliOutcome);
		}

		return await this.#applyMutationExecutionOutcome(inProgress, {
			terminalState: "completed",
			result: {
				ok: true,
				command_key: inProgress.target_type,
			},
			mutatingEvents: [
				{
					eventType: "command.mutation.execute",
					payload: {
						command_key: inProgress.target_type,
						target_id: inProgress.target_id,
					},
				},
			],
		});
	}

	#normalizeRequestedMode(mode: RequestedCommandMode): RequestedCommandMode {
		if (mode === "auto" || mode === "mutation" || mode === "readonly") {
			return mode;
		}
		return "auto";
	}

	async #resolveParsedCommand(
		parsed: ParsedCommand,
		inbound: InboundEnvelope,
		binding: IdentityBinding,
	): Promise<
		| {
				kind: "ok";
				parsedCommand: Extract<ParsedCommand, { kind: "command" }>;
				operatorTrace: { operatorSessionId: string; operatorTurnId: string } | null;
		  }
		| { kind: "result"; result: CommandPipelineResult }
	> {
		if (parsed.kind !== "noop") {
			if (parsed.kind === "invalid") {
				return { kind: "result", result: { kind: "invalid", reason: parsed.reason } };
			}
			if (parsed.kind === "command") {
				return { kind: "ok", parsedCommand: parsed, operatorTrace: null };
			}
			return { kind: "result", result: { kind: "invalid", reason: "empty_command" } };
		}

		if (!this.#operator) {
			return { kind: "result", result: { kind: "noop", reason: parsed.reason } };
		}

		const operatorDecision = await this.#operator.handleInbound({ inbound, binding });
		switch (operatorDecision.kind) {
			case "response":
				return {
					kind: "result",
					result: {
						kind: "operator_response",
						message: operatorDecision.message,
					},
				};
			case "reject":
				return {
					kind: "result",
					result: {
						kind: "denied",
						reason: operatorDecision.reason,
					},
				};
			case "command": {
				const reparsed = parseSeriousWorkCommand(operatorDecision.commandText);
				if (reparsed.kind !== "command") {
					return {
						kind: "result",
						result: {
							kind: "denied",
							reason: "operator_invalid_output",
						},
					};
				}
				return {
					kind: "ok",
					parsedCommand: reparsed,
					operatorTrace: {
						operatorSessionId: operatorDecision.operatorSessionId,
						operatorTurnId: operatorDecision.operatorTurnId,
					},
				};
			}
		}
	}

	public async handleInbound(inboundInput: InboundEnvelope): Promise<CommandPipelineResult> {
		this.#assertStarted();
		const inbound = InboundEnvelopeSchema.parse(inboundInput);
		const initiallyParsed = parseSeriousWorkCommand(inbound.command_text);

		if (initiallyParsed.kind === "invalid") {
			return { kind: "invalid", reason: initiallyParsed.reason };
		}

		const binding = this.#resolveBinding(inbound);
		if (!binding) {
			if (initiallyParsed.kind === "noop") {
				return { kind: "denied", reason: "identity_not_linked" };
			}
			return { kind: "denied", reason: "identity_not_linked" };
		}

		if (initiallyParsed.kind === "confirm") {
			return await this.runtime.executeSerializedMutation(async () => {
				const decision = await this.confirmations.confirm({
					commandId: initiallyParsed.commandId,
					actorBindingId: binding.binding_id,
					nowMs: Math.trunc(this.#nowMs()),
				});

				switch (decision.kind) {
					case "not_found":
						return { kind: "denied", reason: "confirmation_not_found" };
					case "invalid_actor":
						return { kind: "denied", reason: "confirmation_invalid_actor" };
					case "invalid_state":
						return { kind: "denied", reason: "confirmation_invalid_state" };
					case "expired":
						return { kind: "expired", command: decision.command };
					case "queued":
						return await this.#handleConfirmedQueuedMutation(decision.command);
				}
			});
		}

		if (initiallyParsed.kind === "cancel") {
			return await this.runtime.executeSerializedMutation(async () => {
				const decision = await this.confirmations.cancel({
					commandId: initiallyParsed.commandId,
					actorBindingId: binding.binding_id,
					nowMs: Math.trunc(this.#nowMs()),
				});

				switch (decision.kind) {
					case "not_found":
						return { kind: "denied", reason: "confirmation_not_found" };
					case "invalid_actor":
						return { kind: "denied", reason: "confirmation_invalid_actor" };
					case "invalid_state":
						return { kind: "denied", reason: "confirmation_invalid_state" };
					case "cancelled":
						return { kind: "cancelled", command: decision.command };
				}
			});
		}

		const resolvedParsed = await this.#resolveParsedCommand(initiallyParsed, inbound, binding);
		if (resolvedParsed.kind === "result") {
			return resolvedParsed.result;
		}

		let parsed = resolvedParsed.parsedCommand;
		let operatorTrace = resolvedParsed.operatorTrace;
		let requestedMode = this.#normalizeRequestedMode(parsed.requestedMode);
		let auth = this.policy.authorizeCommand({
			commandKey: parsed.commandKey,
			binding,
			requestedMode,
		});

		if (auth.kind === "deny" && auth.reason === "unmapped_command" && this.#operator && operatorTrace == null) {
			const fallback = await this.#operator.handleInbound({ inbound, binding });
			switch (fallback.kind) {
				case "response":
					return { kind: "operator_response", message: fallback.message };
				case "reject":
					return { kind: "denied", reason: fallback.reason };
				case "command": {
					const reparsed = parseSeriousWorkCommand(fallback.commandText);
					if (reparsed.kind !== "command") {
						return { kind: "denied", reason: "operator_invalid_output" };
					}
					parsed = reparsed;
					operatorTrace = {
						operatorSessionId: fallback.operatorSessionId,
						operatorTurnId: fallback.operatorTurnId,
					};
					requestedMode = this.#normalizeRequestedMode(parsed.requestedMode);
					auth = this.policy.authorizeCommand({
						commandKey: parsed.commandKey,
						binding,
						requestedMode,
					});
					break;
				}
			}
		}

		if (auth.kind === "deny") {
			return { kind: "denied", reason: auth.reason };
		}

		const context = this.#contextResolver.resolve({
			repoRoot: inbound.repo_root,
			commandKey: parsed.commandKey,
			args: parsed.args,
			inboundTargetType: inbound.target_type,
			inboundTargetId: inbound.target_id,
			metadata: inbound.metadata,
		});
		if (context.kind === "reject") {
			return { kind: "denied", reason: context.reason };
		}

		const commandId = this.#commandIdFactory();
		const nowMs = Math.trunc(this.#nowMs());
		const normalizedInbound = this.#normalizeInboundForCommand({
			inbound,
			binding,
			commandKey: context.commandKey,
			targetId: context.targetId,
			effectiveScope: auth.effectiveScope,
			normalizedText: context.normalizedText,
		});

		const claim = await this.runtime.claimIdempotency({
			key: normalizedInbound.idempotency_key,
			fingerprint: normalizedInbound.fingerprint,
			commandId,
			ttlMs: idempotencyTtlMs(auth.rule.mutating),
			nowMs,
		});

		if (claim.kind === "conflict") {
			return { kind: "denied", reason: "idempotency_conflict" };
		}
		if (claim.kind === "duplicate") {
			const existing = this.runtime.journal.get(claim.record.command_id);
			if (existing) {
				switch (existing.state) {
					case "awaiting_confirmation":
						return { kind: "awaiting_confirmation", command: existing };
					case "completed":
						return { kind: "completed", command: existing };
					case "cancelled":
						return { kind: "cancelled", command: existing };
					case "expired":
						return { kind: "expired", command: existing };
					case "deferred":
						return { kind: "deferred", command: existing };
					case "failed":
					case "dead_letter":
						return { kind: "failed", command: existing, reason: existing.error_code ?? existing.state };
					default:
						return { kind: "denied", reason: "duplicate_in_flight" };
				}
			}
			return { kind: "denied", reason: "duplicate_missing_command" };
		}

		return await this.runtime.executeSerializedMutation(async () => {
			let record = createAcceptedCommandRecord({
				commandId,
				inbound: normalizedInbound,
				nowMs,
				operatorSessionId: operatorTrace?.operatorSessionId ?? null,
				operatorTurnId: operatorTrace?.operatorTurnId ?? null,
			});
			await this.runtime.journal.appendLifecycle(record);

			if (auth.rule.mutating) {
				record = await this.confirmations.requestAwaitingConfirmation({
					record,
					confirmationTtlMs: this.#confirmationTtlMs,
					nowMs,
				});
				return { kind: "awaiting_confirmation", command: record };
			}

			record = transitionCommandRecord(record, {
				nextState: "queued",
				nowMs,
				errorCode: null,
			});
			await this.runtime.journal.appendLifecycle(record);
			record = transitionCommandRecord(record, {
				nextState: "in_progress",
				nowMs: Math.trunc(this.#nowMs()),
				errorCode: null,
			});
			await this.runtime.journal.appendLifecycle(record);

			let readonlyResult: Record<string, unknown> | null = null;
			if (this.#readonlyExecutor) {
				readonlyResult = await this.#readonlyExecutor(record);
			}

			if (readonlyResult == null && record.operator_session_id) {
				const cliOutcome = await this.#executeAllowlistedCliCommand({
					record,
					expectedMutating: false,
				});
				if (cliOutcome) {
					return await this.#applyMutationExecutionOutcome(record, cliOutcome);
				}
			}

			const completed = transitionCommandRecord(record, {
				nextState: "completed",
				nowMs: Math.trunc(this.#nowMs()),
				result: readonlyResult ?? { ok: true, read_only: true, command_key: context.commandKey },
				errorCode: null,
			});
			await this.runtime.journal.appendLifecycle(completed);
			return { kind: "completed", command: completed };
		});
	}

	public async expirePendingConfirmations(nowMs?: number): Promise<CommandRecord[]> {
		this.#assertStarted();
		return await this.runtime.executeSerializedMutation(
			async () => await this.confirmations.expireDueConfirmations({ nowMs: nowMs ?? Math.trunc(this.#nowMs()) }),
		);
	}
}
