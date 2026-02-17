import type { CommandJournal } from "./command_journal.js";
import { type CommandRecord, transitionCommandRecord } from "./command_record.js";

export type ConfirmationDecision =
	| { kind: "queued"; command: CommandRecord }
	| { kind: "not_found" }
	| { kind: "invalid_state"; command: CommandRecord }
	| { kind: "invalid_actor"; command: CommandRecord }
	| { kind: "expired"; command: CommandRecord };

export type CancellationDecision =
	| { kind: "cancelled"; command: CommandRecord }
	| { kind: "not_found" }
	| { kind: "invalid_state"; command: CommandRecord }
	| { kind: "invalid_actor"; command: CommandRecord };

export class ConfirmationManager {
	readonly #journal: CommandJournal;
	readonly #nowMs: () => number;

	public constructor(journal: CommandJournal, opts: { nowMs?: () => number } = {}) {
		this.#journal = journal;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	public async requestAwaitingConfirmation(opts: {
		record: CommandRecord;
		confirmationTtlMs: number;
		nowMs?: number;
	}): Promise<CommandRecord> {
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const confirmationTtlMs = Math.trunc(opts.confirmationTtlMs);
		if (confirmationTtlMs <= 0) {
			throw new Error(`confirmationTtlMs must be positive, got ${opts.confirmationTtlMs}`);
		}

		const awaiting = transitionCommandRecord(opts.record, {
			nextState: "awaiting_confirmation",
			nowMs,
			confirmationExpiresAtMs: nowMs + confirmationTtlMs,
			errorCode: null,
		});
		await this.#journal.appendLifecycle(awaiting);
		return awaiting;
	}

	public async confirm(opts: {
		commandId: string;
		actorBindingId: string;
		nowMs?: number;
	}): Promise<ConfirmationDecision> {
		const current = this.#journal.get(opts.commandId);
		if (!current) {
			return { kind: "not_found" };
		}
		if (current.state !== "awaiting_confirmation") {
			return { kind: "invalid_state", command: current };
		}

		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		if (current.confirmation_expires_at_ms != null && current.confirmation_expires_at_ms <= nowMs) {
			const expired = transitionCommandRecord(current, {
				nextState: "expired",
				nowMs,
				errorCode: "confirmation_expired",
			});
			await this.#journal.appendLifecycle(expired);
			return { kind: "expired", command: expired };
		}

		if (current.actor_binding_id !== opts.actorBindingId) {
			return { kind: "invalid_actor", command: current };
		}

		const queued = transitionCommandRecord(current, {
			nextState: "queued",
			nowMs,
			errorCode: null,
			retryAtMs: null,
		});
		await this.#journal.appendLifecycle(queued);
		return { kind: "queued", command: queued };
	}

	public async cancel(opts: {
		commandId: string;
		actorBindingId: string;
		nowMs?: number;
	}): Promise<CancellationDecision> {
		const current = this.#journal.get(opts.commandId);
		if (!current) {
			return { kind: "not_found" };
		}
		if (current.state !== "awaiting_confirmation") {
			return { kind: "invalid_state", command: current };
		}
		if (current.actor_binding_id !== opts.actorBindingId) {
			return { kind: "invalid_actor", command: current };
		}

		const cancelled = transitionCommandRecord(current, {
			nextState: "cancelled",
			nowMs: Math.trunc(opts.nowMs ?? this.#nowMs()),
			errorCode: "confirmation_cancelled",
		});
		await this.#journal.appendLifecycle(cancelled);
		return { kind: "cancelled", command: cancelled };
	}

	public async expireDueConfirmations(opts: { nowMs?: number } = {}): Promise<CommandRecord[]> {
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const expired: CommandRecord[] = [];

		for (const record of this.#journal.nonTerminalCommands()) {
			if (record.state !== "awaiting_confirmation") {
				continue;
			}
			if (record.confirmation_expires_at_ms == null || record.confirmation_expires_at_ms > nowMs) {
				continue;
			}

			const next = transitionCommandRecord(record, {
				nextState: "expired",
				nowMs,
				errorCode: "confirmation_expired",
			});
			await this.#journal.appendLifecycle(next);
			expired.push(next);
		}

		expired.sort((a, b) => {
			if (a.updated_at_ms !== b.updated_at_ms) {
				return a.updated_at_ms - b.updated_at_ms;
			}
			return a.command_id.localeCompare(b.command_id);
		});
		return expired;
	}
}
