import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { z } from "zod";
import { type OutboundEnvelope, OutboundEnvelopeSchema } from "./models.js";

function defaultOutboxIdFactory(): string {
	return `out-${crypto.randomUUID()}`;
}

function defaultResponseIdFactory(): string {
	return `resp-${crypto.randomUUID()}`;
}

function cloneRecord(record: OutboxRecord): OutboxRecord {
	return OutboxRecordSchema.parse(record);
}

export const OutboxStateSchema = z.enum(["pending", "delivered", "dead_letter"]);
export type OutboxState = z.infer<typeof OutboxStateSchema>;

export const OutboxRecordSchema = z.object({
	outbox_id: z.string().min(1),
	dedupe_key: z.string().min(1),
	state: OutboxStateSchema,
	envelope: OutboundEnvelopeSchema,
	created_at_ms: z.number().int(),
	updated_at_ms: z.number().int(),
	next_attempt_at_ms: z.number().int(),
	attempt_count: z.number().int().nonnegative(),
	max_attempts: z.number().int().positive(),
	last_error: z.string().nullable().default(null),
	dead_letter_reason: z.string().nullable().default(null),
	replay_of_outbox_id: z.string().nullable().default(null),
	replay_requested_by_command_id: z.string().nullable().default(null),
});
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;

export const OutboxJournalEntrySchema = z.object({
	kind: z.literal("outbox.state"),
	ts_ms: z.number().int(),
	record: OutboxRecordSchema,
});
export type OutboxJournalEntry = z.infer<typeof OutboxJournalEntrySchema>;

export type EnqueueOutboxOpts = {
	dedupeKey: string;
	envelope: OutboundEnvelope;
	nowMs?: number;
	maxAttempts?: number;
	nextAttemptAtMs?: number;
	outboxId?: string;
	replayOfOutboxId?: string | null;
	replayRequestedByCommandId?: string | null;
};

export type EnqueueOutboxDecision =
	| { kind: "enqueued"; record: OutboxRecord }
	| { kind: "duplicate"; record: OutboxRecord };

export type ReplayDeadLetterDecision =
	| { kind: "replayed"; original: OutboxRecord; replay: OutboxRecord }
	| { kind: "not_found" }
	| { kind: "not_dead_letter"; record: OutboxRecord };

export type MarkFailureOpts = {
	error: string;
	nowMs?: number;
	retryDelayMs?: number;
};

export class ControlPlaneOutbox {
	readonly #path: string;
	readonly #nowMs: () => number;
	readonly #outboxIdFactory: () => string;
	readonly #responseIdFactory: () => string;
	#loaded = false;
	readonly #recordsById = new Map<string, OutboxRecord>();
	readonly #recordIdByDedupeKey = new Map<string, string>();

	public constructor(
		path: string,
		opts: {
			nowMs?: () => number;
			outboxIdFactory?: () => string;
			responseIdFactory?: () => string;
		} = {},
	) {
		this.#path = path;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#outboxIdFactory = opts.outboxIdFactory ?? defaultOutboxIdFactory;
		this.#responseIdFactory = opts.responseIdFactory ?? defaultResponseIdFactory;
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		this.#recordsById.clear();
		this.#recordIdByDedupeKey.clear();

		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = OutboxJournalEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid outbox row ${idx}: ${parsed.error.message}`);
			}
			this.#applyRecord(parsed.data.record);
		}

		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	#applyRecord(record: OutboxRecord): void {
		const cloned = cloneRecord(record);
		this.#recordsById.set(cloned.outbox_id, cloned);
		this.#recordIdByDedupeKey.set(cloned.dedupe_key, cloned.outbox_id);
	}

	async #appendRecord(record: OutboxRecord): Promise<void> {
		const parsed = cloneRecord(record);
		const entry = OutboxJournalEntrySchema.parse({
			kind: "outbox.state",
			ts_ms: parsed.updated_at_ms,
			record: parsed,
		});
		await appendJsonl(this.#path, entry);
		this.#applyRecord(parsed);
	}

	public get(outboxId: string): OutboxRecord | null {
		const record = this.#recordsById.get(outboxId);
		return record ? cloneRecord(record) : null;
	}

	public getByDedupeKey(dedupeKey: string): OutboxRecord | null {
		const outboxId = this.#recordIdByDedupeKey.get(dedupeKey);
		if (!outboxId) {
			return null;
		}
		const record = this.#recordsById.get(outboxId);
		return record ? cloneRecord(record) : null;
	}

	public records(opts: { state?: OutboxState | null } = {}): OutboxRecord[] {
		const out: OutboxRecord[] = [];
		for (const record of this.#recordsById.values()) {
			if (opts.state && record.state !== opts.state) {
				continue;
			}
			out.push(cloneRecord(record));
		}
		out.sort((a, b) => {
			if (a.created_at_ms !== b.created_at_ms) {
				return a.created_at_ms - b.created_at_ms;
			}
			return a.outbox_id.localeCompare(b.outbox_id);
		});
		return out;
	}

	public pendingDue(nowMs: number = Math.trunc(this.#nowMs()), limit: number = 100): OutboxRecord[] {
		const due = this.records({ state: "pending" })
			.filter((record) => record.next_attempt_at_ms <= nowMs)
			.sort((a, b) => {
				if (a.next_attempt_at_ms !== b.next_attempt_at_ms) {
					return a.next_attempt_at_ms - b.next_attempt_at_ms;
				}
				if (a.created_at_ms !== b.created_at_ms) {
					return a.created_at_ms - b.created_at_ms;
				}
				return a.outbox_id.localeCompare(b.outbox_id);
			});
		return due.slice(0, Math.max(0, limit));
	}

	public listDeadLetters(limit: number = 100): OutboxRecord[] {
		return this.records({ state: "dead_letter" }).slice(0, Math.max(0, limit));
	}

	public inspectDeadLetter(outboxId: string): OutboxRecord | null {
		const record = this.get(outboxId);
		if (!record || record.state !== "dead_letter") {
			return null;
		}
		return record;
	}

	public async enqueue(opts: EnqueueOutboxOpts): Promise<EnqueueOutboxDecision> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const dedupeKey = opts.dedupeKey.trim();
		if (dedupeKey.length === 0) {
			throw new Error("dedupeKey must be non-empty");
		}

		const existing = this.getByDedupeKey(dedupeKey);
		if (existing) {
			return { kind: "duplicate", record: existing };
		}

		const envelope = OutboundEnvelopeSchema.parse(opts.envelope);
		const record = OutboxRecordSchema.parse({
			outbox_id: opts.outboxId ?? this.#outboxIdFactory(),
			dedupe_key: dedupeKey,
			state: "pending",
			envelope,
			created_at_ms: nowMs,
			updated_at_ms: nowMs,
			next_attempt_at_ms: Math.trunc(opts.nextAttemptAtMs ?? nowMs),
			attempt_count: 0,
			max_attempts: Math.max(1, Math.trunc(opts.maxAttempts ?? 3)),
			last_error: null,
			dead_letter_reason: null,
			replay_of_outbox_id: opts.replayOfOutboxId ?? null,
			replay_requested_by_command_id: opts.replayRequestedByCommandId ?? null,
		});
		await this.#appendRecord(record);
		return { kind: "enqueued", record };
	}

	public async markDelivered(
		outboxId: string,
		nowMs: number = Math.trunc(this.#nowMs()),
	): Promise<OutboxRecord | null> {
		await this.#ensureLoaded();
		const current = this.#recordsById.get(outboxId);
		if (!current) {
			return null;
		}
		if (current.state === "delivered") {
			return cloneRecord(current);
		}
		const updated = OutboxRecordSchema.parse({
			...current,
			state: "delivered",
			updated_at_ms: nowMs,
			next_attempt_at_ms: nowMs,
			last_error: null,
			dead_letter_reason: null,
		});
		await this.#appendRecord(updated);
		return updated;
	}

	public async markFailure(outboxId: string, opts: MarkFailureOpts): Promise<OutboxRecord | null> {
		await this.#ensureLoaded();
		const current = this.#recordsById.get(outboxId);
		if (!current) {
			return null;
		}
		if (current.state !== "pending") {
			return cloneRecord(current);
		}

		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const attemptCount = current.attempt_count + 1;
		if (attemptCount >= current.max_attempts) {
			const deadLetter = OutboxRecordSchema.parse({
				...current,
				state: "dead_letter",
				updated_at_ms: nowMs,
				next_attempt_at_ms: nowMs,
				attempt_count: attemptCount,
				last_error: opts.error,
				dead_letter_reason: opts.error,
			});
			await this.#appendRecord(deadLetter);
			return deadLetter;
		}

		const fallbackDelayMs = Math.min(60_000, 250 * 2 ** Math.max(0, attemptCount - 1));
		const retryDelayMs = Math.max(0, Math.trunc(opts.retryDelayMs ?? fallbackDelayMs));
		const retried = OutboxRecordSchema.parse({
			...current,
			state: "pending",
			updated_at_ms: nowMs,
			next_attempt_at_ms: nowMs + retryDelayMs,
			attempt_count: attemptCount,
			last_error: opts.error,
			dead_letter_reason: null,
		});
		await this.#appendRecord(retried);
		return retried;
	}

	public async replayDeadLetter(opts: {
		outboxId: string;
		nowMs?: number;
		replayRequestedByCommandId?: string | null;
		dedupeKey?: string;
	}): Promise<ReplayDeadLetterDecision> {
		await this.#ensureLoaded();
		const current = this.#recordsById.get(opts.outboxId);
		if (!current) {
			return { kind: "not_found" };
		}
		if (current.state !== "dead_letter") {
			return { kind: "not_dead_letter", record: cloneRecord(current) };
		}

		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const replayEnvelope = OutboundEnvelopeSchema.parse({
			...current.envelope,
			ts_ms: nowMs,
			response_id: this.#responseIdFactory(),
			metadata: {
				...current.envelope.metadata,
				replayed_from_outbox_id: current.outbox_id,
				replay_requested_by_command_id: opts.replayRequestedByCommandId ?? null,
			},
		});
		const dedupeKey =
			opts.dedupeKey ??
			`replay:${current.outbox_id}:${replayEnvelope.response_id}:${opts.replayRequestedByCommandId ?? "unknown"}`;
		const decision = await this.enqueue({
			dedupeKey,
			envelope: replayEnvelope,
			nowMs,
			maxAttempts: current.max_attempts,
			replayOfOutboxId: current.outbox_id,
			replayRequestedByCommandId: opts.replayRequestedByCommandId ?? null,
		});
		return {
			kind: "replayed",
			original: cloneRecord(current),
			replay: cloneRecord(decision.record),
		};
	}
}

export type OutboxDeliveryHandlerResult =
	| { kind: "delivered" }
	| {
			kind: "retry";
			error: string;
			retryDelayMs?: number;
	  };

export type OutboxDeliveryHandler = (record: OutboxRecord) => Promise<undefined | OutboxDeliveryHandlerResult>;

export type OutboxDispatchOutcome =
	| { kind: "delivered"; record: OutboxRecord }
	| { kind: "retried"; record: OutboxRecord }
	| { kind: "dead_letter"; record: OutboxRecord };

export class ControlPlaneOutboxDispatcher {
	readonly #outbox: ControlPlaneOutbox;
	readonly #deliver: OutboxDeliveryHandler;
	readonly #nowMs: () => number;
	readonly #defaultLimit: number;

	public constructor(opts: {
		outbox: ControlPlaneOutbox;
		deliver: OutboxDeliveryHandler;
		nowMs?: () => number;
		limitPerDrain?: number;
	}) {
		this.#outbox = opts.outbox;
		this.#deliver = opts.deliver;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#defaultLimit = Math.max(1, Math.trunc(opts.limitPerDrain ?? 50));
	}

	public async drainDue(opts: { limit?: number; nowMs?: number } = {}): Promise<OutboxDispatchOutcome[]> {
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const limit = Math.max(1, Math.trunc(opts.limit ?? this.#defaultLimit));
		const due = this.#outbox.pendingDue(nowMs, limit);

		const outcomes: OutboxDispatchOutcome[] = [];
		for (const record of due) {
			let deliveryResult: undefined | OutboxDeliveryHandlerResult;
			try {
				deliveryResult = await this.#deliver(record);
			} catch (err) {
				deliveryResult = {
					kind: "retry",
					error: err instanceof Error && err.message.length > 0 ? err.message : "outbox_delivery_error",
				};
			}

			if (deliveryResult == null || deliveryResult.kind === "delivered") {
				const delivered = await this.#outbox.markDelivered(record.outbox_id, nowMs);
				if (delivered) {
					outcomes.push({ kind: "delivered", record: delivered });
				}
				continue;
			}

			const failed = await this.#outbox.markFailure(record.outbox_id, {
				error: deliveryResult.error,
				nowMs,
				retryDelayMs: deliveryResult.retryDelayMs,
			});
			if (!failed) {
				continue;
			}
			if (failed.state === "dead_letter") {
				outcomes.push({ kind: "dead_letter", record: failed });
			} else {
				outcomes.push({ kind: "retried", record: failed });
			}
		}

		return outcomes;
	}
}
