import { CommandJournal } from "./command_journal.js";
import { type CommandRecord, transitionCommandRecord } from "./command_record.js";
import { canTransition, isTerminalCommandState } from "./command_state.js";
import { type IdempotencyClaimDecision, type IdempotencyClaimRecord, IdempotencyLedger } from "./idempotency_ledger.js";
import { type ControlPlanePaths, getControlPlanePaths } from "./paths.js";
import { SerializedMutationExecutor } from "./serialized_mutation_executor.js";
import { WriterLock } from "./writer_lock.js";

export type ReplayAction =
	| { kind: "terminal" }
	| { kind: "completed_reconciled" }
	| { kind: "expired" }
	| { kind: "awaiting_confirmation" }
	| { kind: "deferred" }
	| { kind: "requeue" }
	| { kind: "dead_letter"; reason: string };

export function decideReplayAction(
	record: CommandRecord,
	opts: { hasMutatingEvents: boolean; nowMs: number },
): ReplayAction {
	if (isTerminalCommandState(record.state)) {
		return { kind: "terminal" };
	}

	if (opts.hasMutatingEvents) {
		if (canTransition(record.state, "completed")) {
			return { kind: "completed_reconciled" };
		}
		return { kind: "dead_letter", reason: "reconcile_ambiguous" };
	}

	switch (record.state) {
		case "accepted":
		case "queued":
		case "in_progress":
			return { kind: "requeue" };
		case "awaiting_confirmation":
			if (record.confirmation_expires_at_ms != null && record.confirmation_expires_at_ms <= opts.nowMs) {
				return { kind: "expired" };
			}
			return { kind: "awaiting_confirmation" };
		case "deferred":
			if (record.retry_at_ms != null && record.retry_at_ms > opts.nowMs) {
				return { kind: "deferred" };
			}
			return { kind: "requeue" };
		default:
			return { kind: "dead_letter", reason: `unsupported_non_terminal_state:${record.state}` };
	}
}

export type ReplayMutationEvent = {
	eventType: string;
	payload: Record<string, unknown>;
};

export type ReplayMutationResult =
	| {
			terminalState: "completed";
			result?: Record<string, unknown> | null;
			errorCode?: string | null;
			mutatingEvents?: readonly ReplayMutationEvent[];
	  }
	| {
			terminalState: "failed";
			errorCode: string;
			mutatingEvents?: readonly ReplayMutationEvent[];
	  }
	| {
			terminalState: "cancelled";
			errorCode?: string | null;
			mutatingEvents?: readonly ReplayMutationEvent[];
	  }
	| {
			terminalState: "deferred";
			retryAtMs: number;
			errorCode?: string | null;
			mutatingEvents?: readonly ReplayMutationEvent[];
	  };

export type ReplayMutationHandler = (record: CommandRecord) => Promise<ReplayMutationResult>;

export type ControlPlaneRuntimeOpts = {
	repoRoot: string;
	ownerId?: string;
	nowMs?: () => number;
	journal?: CommandJournal;
	idempotency?: IdempotencyLedger;
	executor?: SerializedMutationExecutor;
};

export class ControlPlaneRuntime {
	public readonly paths: ControlPlanePaths;
	public readonly journal: CommandJournal;
	public readonly idempotency: IdempotencyLedger;
	readonly #executor: SerializedMutationExecutor;
	readonly #ownerId: string | undefined;
	readonly #nowMs: () => number;
	#writerLock: WriterLock | null = null;
	#started = false;

	public constructor(opts: ControlPlaneRuntimeOpts) {
		this.paths = getControlPlanePaths(opts.repoRoot);
		this.journal = opts.journal ?? new CommandJournal(this.paths.commandsPath);
		this.idempotency = opts.idempotency ?? new IdempotencyLedger(this.paths.idempotencyPath);
		this.#executor = opts.executor ?? new SerializedMutationExecutor();
		this.#ownerId = opts.ownerId;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	public async start(): Promise<void> {
		if (this.#started) {
			return;
		}
		this.#writerLock = await WriterLock.acquire(this.paths.writerLockPath, {
			ownerId: this.#ownerId,
			repoRoot: this.paths.repoRoot,
			nowMs: Math.trunc(this.#nowMs()),
		});
		await this.journal.load();
		await this.idempotency.load();
		this.#started = true;
	}

	public async stop(): Promise<void> {
		if (!this.#started) {
			return;
		}
		if (this.#writerLock) {
			await this.#writerLock.release();
			this.#writerLock = null;
		}
		this.#started = false;
	}

	#assertStarted(): void {
		if (!this.#started) {
			throw new Error("control-plane runtime not started");
		}
	}

	public async executeSerializedMutation<T>(fn: () => Promise<T> | T): Promise<T> {
		this.#assertStarted();
		return await this.#executor.run(fn);
	}

	public async claimIdempotency(opts: {
		key: string;
		fingerprint: string;
		commandId: string;
		ttlMs: number;
		nowMs?: number;
	}): Promise<IdempotencyClaimDecision> {
		this.#assertStarted();
		return await this.idempotency.claim(opts);
	}

	public async lookupIdempotency(key: string, opts: { nowMs?: number } = {}): Promise<IdempotencyClaimRecord | null> {
		this.#assertStarted();
		return await this.idempotency.lookup(key, opts);
	}

	async #markDeadLetter(record: CommandRecord, reason: string): Promise<CommandRecord> {
		if (!canTransition(record.state, "dead_letter")) {
			return record;
		}
		const deadLetter = transitionCommandRecord(record, {
			nextState: "dead_letter",
			nowMs: Math.trunc(this.#nowMs()),
			errorCode: reason,
		});
		await this.journal.appendLifecycle(deadLetter);
		return deadLetter;
	}

	async #prepareQueuedForReplay(record: CommandRecord): Promise<CommandRecord> {
		let current = record;
		if (current.state === "in_progress") {
			current = transitionCommandRecord(current, {
				nextState: "deferred",
				nowMs: Math.trunc(this.#nowMs()),
				retryAtMs: Math.trunc(this.#nowMs()),
				errorCode: "replay_resume",
			});
			await this.journal.appendLifecycle(current, { eventType: "command.deferred" });
		}
		if (current.state === "queued") {
			return current;
		}
		if (!canTransition(current.state, "queued")) {
			return await this.#markDeadLetter(current, "cannot_requeue");
		}
		const queued = transitionCommandRecord(current, {
			nextState: "queued",
			nowMs: Math.trunc(this.#nowMs()),
			retryAtMs: null,
			errorCode: null,
		});
		await this.journal.appendLifecycle(queued, { eventType: "command.queued" });
		return queued;
	}

	async #runReplayMutation(record: CommandRecord, handler: ReplayMutationHandler): Promise<CommandRecord> {
		const queued = await this.#prepareQueuedForReplay(record);
		if (queued.state !== "queued") {
			return queued;
		}

		const inProgress = transitionCommandRecord(queued, {
			nextState: "in_progress",
			nowMs: Math.trunc(this.#nowMs()),
			errorCode: null,
		});
		await this.journal.appendLifecycle(inProgress);

		let outcome: ReplayMutationResult;
		try {
			outcome = await handler(inProgress);
		} catch (err) {
			const failed = transitionCommandRecord(inProgress, {
				nextState: "failed",
				nowMs: Math.trunc(this.#nowMs()),
				errorCode: err instanceof Error && err.message.length > 0 ? err.message : "replay_handler_error",
			});
			await this.journal.appendLifecycle(failed);
			return failed;
		}

		const events = outcome.mutatingEvents ?? [];
		for (const event of events) {
			await this.journal.appendMutatingDomainEvent({
				eventType: event.eventType,
				command: inProgress,
				payload: event.payload,
				state: "in_progress",
			});
		}

		switch (outcome.terminalState) {
			case "deferred": {
				const deferred = transitionCommandRecord(inProgress, {
					nextState: "deferred",
					nowMs: Math.trunc(this.#nowMs()),
					retryAtMs: Math.trunc(outcome.retryAtMs),
					errorCode: outcome.errorCode ?? null,
				});
				await this.journal.appendLifecycle(deferred);
				return deferred;
			}
			case "completed": {
				const completed = transitionCommandRecord(inProgress, {
					nextState: "completed",
					nowMs: Math.trunc(this.#nowMs()),
					errorCode: outcome.errorCode ?? null,
					result: outcome.result ?? null,
				});
				await this.journal.appendLifecycle(completed);
				return completed;
			}
			case "failed": {
				const failed = transitionCommandRecord(inProgress, {
					nextState: "failed",
					nowMs: Math.trunc(this.#nowMs()),
					errorCode: outcome.errorCode,
				});
				await this.journal.appendLifecycle(failed);
				return failed;
			}
			case "cancelled": {
				const cancelled = transitionCommandRecord(inProgress, {
					nextState: "cancelled",
					nowMs: Math.trunc(this.#nowMs()),
					errorCode: outcome.errorCode ?? null,
				});
				await this.journal.appendLifecycle(cancelled);
				return cancelled;
			}
		}
	}

	public async startupReplay(handler?: ReplayMutationHandler): Promise<CommandRecord[]> {
		this.#assertStarted();

		const out: CommandRecord[] = [];
		const nonTerminal = this.journal.nonTerminalCommands();
		for (const record of nonTerminal) {
			const decision = decideReplayAction(record, {
				hasMutatingEvents: this.journal.hasMutatingEvents(record.command_id),
				nowMs: Math.trunc(this.#nowMs()),
			});

			switch (decision.kind) {
				case "terminal":
					out.push(record);
					break;
				case "completed_reconciled": {
					const completed = transitionCommandRecord(record, {
						nextState: "completed",
						nowMs: Math.trunc(this.#nowMs()),
						result: { reconciled: true, reason: "mutating_event_present" },
						errorCode: null,
					});
					await this.journal.appendLifecycle(completed, { eventType: "command.reconciled" });
					out.push(completed);
					break;
				}
				case "expired": {
					const expired = transitionCommandRecord(record, {
						nextState: "expired",
						nowMs: Math.trunc(this.#nowMs()),
						errorCode: "confirmation_expired",
					});
					await this.journal.appendLifecycle(expired);
					out.push(expired);
					break;
				}
				case "awaiting_confirmation":
				case "deferred":
					out.push(record);
					break;
				case "requeue":
					if (handler) {
						out.push(
							await this.executeSerializedMutation(async () => await this.#runReplayMutation(record, handler)),
						);
					} else {
						out.push(await this.#prepareQueuedForReplay(record));
					}
					break;
				case "dead_letter": {
					out.push(await this.#markDeadLetter(record, decision.reason));
					break;
				}
			}
		}
		return out;
	}
}
