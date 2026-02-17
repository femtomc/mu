import type { MutationCommandExecutionResult } from "./command_pipeline.js";
import type { CommandRecord } from "./command_record.js";
import type { ControlPlaneOutbox, OutboxRecord } from "./outbox.js";
import type { ControlPlaneRuntime } from "./runtime.js";

function serializeOutboxRecord(record: OutboxRecord): Record<string, unknown> {
	return {
		outbox_id: record.outbox_id,
		dedupe_key: record.dedupe_key,
		state: record.state,
		attempt_count: record.attempt_count,
		max_attempts: record.max_attempts,
		next_attempt_at_ms: record.next_attempt_at_ms,
		last_error: record.last_error,
		dead_letter_reason: record.dead_letter_reason,
		replay_of_outbox_id: record.replay_of_outbox_id,
		replay_requested_by_command_id: record.replay_requested_by_command_id,
		envelope: record.envelope,
	};
}

export class ControlPlaneOperatorTooling {
	readonly #runtime: ControlPlaneRuntime;
	readonly #outbox: ControlPlaneOutbox;
	readonly #nowMs: () => number;
	readonly #dlqListDefaultLimit: number;

	public constructor(opts: {
		runtime: ControlPlaneRuntime;
		outbox: ControlPlaneOutbox;
		nowMs?: () => number;
		dlqListDefaultLimit?: number;
	}) {
		this.#runtime = opts.runtime;
		this.#outbox = opts.outbox;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#dlqListDefaultLimit = Math.max(1, Math.trunc(opts.dlqListDefaultLimit ?? 100));
	}

	public async auditLookupByCommandId(commandId: string): Promise<Record<string, unknown>> {
		const command = this.#runtime.journal.get(commandId);
		if (!command) {
			return {
				ok: false,
				command_id: commandId,
				error: "command_not_found",
			};
		}

		return {
			ok: true,
			command_id: commandId,
			command,
			lifecycle: this.#runtime.journal.lifecycleEvents(commandId),
			mutating_events: this.#runtime.journal.mutatingEvents(commandId),
		};
	}

	public async dlqList(limit?: number): Promise<Record<string, unknown>> {
		const resolvedLimit = Math.max(1, Math.trunc(limit ?? this.#dlqListDefaultLimit));
		const deadLetters = this.#outbox.listDeadLetters(resolvedLimit).map((record) => serializeOutboxRecord(record));
		return {
			ok: true,
			count: deadLetters.length,
			dead_letters: deadLetters,
		};
	}

	public async dlqInspect(outboxId: string): Promise<Record<string, unknown>> {
		const record = this.#outbox.inspectDeadLetter(outboxId);
		if (!record) {
			return {
				ok: false,
				outbox_id: outboxId,
				error: "dlq_not_found",
			};
		}
		return {
			ok: true,
			outbox_id: outboxId,
			entry: serializeOutboxRecord(record),
		};
	}

	public async executeReadonly(record: CommandRecord): Promise<Record<string, unknown> | null> {
		switch (record.target_type) {
			case "audit get":
				return await this.auditLookupByCommandId(record.target_id);
			case "dlq list":
				return await this.dlqList();
			case "dlq inspect":
				return await this.dlqInspect(record.target_id);
			default:
				return null;
		}
	}

	public async executeMutation(record: CommandRecord): Promise<MutationCommandExecutionResult | null> {
		switch (record.target_type) {
			case "dlq replay": {
				const decision = await this.#outbox.replayDeadLetter({
					outboxId: record.target_id,
					nowMs: Math.trunc(this.#nowMs()),
					replayRequestedByCommandId: record.command_id,
				});
				if (decision.kind === "not_found") {
					return {
						terminalState: "failed",
						errorCode: "dlq_not_found",
					};
				}
				if (decision.kind === "not_dead_letter") {
					return {
						terminalState: "failed",
						errorCode: "dlq_not_dead_letter",
					};
				}
				return {
					terminalState: "completed",
					result: {
						ok: true,
						action: "dlq_replay",
						source_outbox_id: decision.original.outbox_id,
						replay_outbox_id: decision.replay.outbox_id,
						preserved_command_id: decision.replay.envelope.correlation.command_id,
					},
					mutatingEvents: [
						{
							eventType: "dlq.replay",
							payload: {
								source_outbox_id: decision.original.outbox_id,
								replay_outbox_id: decision.replay.outbox_id,
								requested_by_command_id: record.command_id,
								preserved_command_id: decision.replay.envelope.correlation.command_id,
							},
						},
					],
				};
			}
			default:
				return null;
		}
	}
}
