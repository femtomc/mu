import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { z } from "zod";
import { type InboundEnvelope, InboundEnvelopeSchema } from "./models.js";
import { SerializedMutationExecutor } from "./serialized_mutation_executor.js";

function defaultIngressIdFactory(): string {
	return `tg-ing-${crypto.randomUUID()}`;
}

function cloneRecord(record: TelegramIngressRecord): TelegramIngressRecord {
	return TelegramIngressRecordSchema.parse(record);
}

export const TelegramIngressStateSchema = z.enum(["pending", "completed", "dead_letter"]);
export type TelegramIngressState = z.infer<typeof TelegramIngressStateSchema>;

export const TelegramIngressRecordSchema = z.object({
	ingress_id: z.string().min(1),
	dedupe_key: z.string().min(1),
	state: TelegramIngressStateSchema,
	inbound: InboundEnvelopeSchema,
	created_at_ms: z.number().int(),
	updated_at_ms: z.number().int(),
	next_attempt_at_ms: z.number().int(),
	attempt_count: z.number().int().nonnegative(),
	max_attempts: z.number().int().positive(),
	last_error: z.string().nullable().default(null),
	dead_letter_reason: z.string().nullable().default(null),
});
export type TelegramIngressRecord = z.infer<typeof TelegramIngressRecordSchema>;

export const TelegramIngressJournalEntrySchema = z.object({
	kind: z.literal("telegram.ingress.state"),
	ts_ms: z.number().int(),
	record: TelegramIngressRecordSchema,
});
export type TelegramIngressJournalEntry = z.infer<typeof TelegramIngressJournalEntrySchema>;

export type EnqueueTelegramIngressOpts = {
	dedupeKey: string;
	inbound: InboundEnvelope;
	nowMs?: number;
	maxAttempts?: number;
	ingressId?: string;
};

export type EnqueueTelegramIngressDecision =
	| { kind: "enqueued"; record: TelegramIngressRecord }
	| { kind: "duplicate"; record: TelegramIngressRecord };

export type MarkTelegramIngressFailureOpts = {
	error: string;
	nowMs?: number;
	retryDelayMs?: number;
};

export class TelegramIngressQueue {
	readonly #path: string;
	readonly #nowMs: () => number;
	readonly #ingressIdFactory: () => string;
	readonly #executor: SerializedMutationExecutor;
	#loaded = false;
	readonly #recordsById = new Map<string, TelegramIngressRecord>();
	readonly #recordIdByDedupeKey = new Map<string, string>();

	public constructor(
		path: string,
		opts: {
			nowMs?: () => number;
			ingressIdFactory?: () => string;
		} = {},
	) {
		this.#path = path;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#ingressIdFactory = opts.ingressIdFactory ?? defaultIngressIdFactory;
		this.#executor = new SerializedMutationExecutor();
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		this.#recordsById.clear();
		this.#recordIdByDedupeKey.clear();

		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = TelegramIngressJournalEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid telegram ingress row ${idx}: ${parsed.error.message}`);
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

	#applyRecord(record: TelegramIngressRecord): void {
		const cloned = cloneRecord(record);
		this.#recordsById.set(cloned.ingress_id, cloned);
		this.#recordIdByDedupeKey.set(cloned.dedupe_key, cloned.ingress_id);
	}

	async #appendRecord(record: TelegramIngressRecord): Promise<void> {
		const parsed = cloneRecord(record);
		const entry = TelegramIngressJournalEntrySchema.parse({
			kind: "telegram.ingress.state",
			ts_ms: parsed.updated_at_ms,
			record: parsed,
		});
		await appendJsonl(this.#path, entry);
		this.#applyRecord(parsed);
	}

	public async get(ingressId: string): Promise<TelegramIngressRecord | null> {
		await this.#ensureLoaded();
		const record = this.#recordsById.get(ingressId);
		return record ? cloneRecord(record) : null;
	}

	public async getByDedupeKey(dedupeKey: string): Promise<TelegramIngressRecord | null> {
		await this.#ensureLoaded();
		const ingressId = this.#recordIdByDedupeKey.get(dedupeKey);
		if (!ingressId) {
			return null;
		}
		const record = this.#recordsById.get(ingressId);
		return record ? cloneRecord(record) : null;
	}

	public async records(opts: { state?: TelegramIngressState | null } = {}): Promise<TelegramIngressRecord[]> {
		await this.#ensureLoaded();
		const out: TelegramIngressRecord[] = [];
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
			return a.ingress_id.localeCompare(b.ingress_id);
		});
		return out;
	}

	public async pendingDue(nowMs: number = Math.trunc(this.#nowMs()), limit: number = 100): Promise<TelegramIngressRecord[]> {
		const due = (await this.records({ state: "pending" }))
			.filter((record) => record.next_attempt_at_ms <= nowMs)
			.sort((a, b) => {
				if (a.next_attempt_at_ms !== b.next_attempt_at_ms) {
					return a.next_attempt_at_ms - b.next_attempt_at_ms;
				}
				if (a.created_at_ms !== b.created_at_ms) {
					return a.created_at_ms - b.created_at_ms;
				}
				return a.ingress_id.localeCompare(b.ingress_id);
			});
		return due.slice(0, Math.max(0, limit));
	}

	public async nextPendingAttemptAtMs(): Promise<number | null> {
		const pending = await this.records({ state: "pending" });
		if (pending.length === 0) {
			return null;
		}
		let min = pending[0]!.next_attempt_at_ms;
		for (let idx = 1; idx < pending.length; idx++) {
			const candidate = pending[idx]!.next_attempt_at_ms;
			if (candidate < min) {
				min = candidate;
			}
		}
		return min;
	}

	public async enqueue(opts: EnqueueTelegramIngressOpts): Promise<EnqueueTelegramIngressDecision> {
		return await this.#executor.run(async () => {
			await this.#ensureLoaded();
			const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
			const dedupeKey = opts.dedupeKey.trim();
			if (dedupeKey.length === 0) {
				throw new Error("dedupeKey must be non-empty");
			}

			const existing = await this.getByDedupeKey(dedupeKey);
			if (existing) {
				return { kind: "duplicate", record: existing };
			}

			const record = TelegramIngressRecordSchema.parse({
				ingress_id: opts.ingressId ?? this.#ingressIdFactory(),
				dedupe_key: dedupeKey,
				state: "pending",
				inbound: InboundEnvelopeSchema.parse(opts.inbound),
				created_at_ms: nowMs,
				updated_at_ms: nowMs,
				next_attempt_at_ms: nowMs,
				attempt_count: 0,
				max_attempts: Math.max(1, Math.trunc(opts.maxAttempts ?? 5)),
				last_error: null,
				dead_letter_reason: null,
			});
			await this.#appendRecord(record);
			return { kind: "enqueued", record };
		});
	}

	public async markCompleted(
		ingressId: string,
		nowMs: number = Math.trunc(this.#nowMs()),
	): Promise<TelegramIngressRecord | null> {
		return await this.#executor.run(async () => {
			await this.#ensureLoaded();
			const current = this.#recordsById.get(ingressId);
			if (!current) {
				return null;
			}
			if (current.state === "completed") {
				return cloneRecord(current);
			}
			const updated = TelegramIngressRecordSchema.parse({
				...current,
				state: "completed",
				updated_at_ms: nowMs,
				next_attempt_at_ms: nowMs,
				last_error: null,
				dead_letter_reason: null,
			});
			await this.#appendRecord(updated);
			return updated;
		});
	}

	public async markFailure(ingressId: string, opts: MarkTelegramIngressFailureOpts): Promise<TelegramIngressRecord | null> {
		return await this.#executor.run(async () => {
			await this.#ensureLoaded();
			const current = this.#recordsById.get(ingressId);
			if (!current) {
				return null;
			}
			if (current.state !== "pending") {
				return cloneRecord(current);
			}

			const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
			const attemptCount = current.attempt_count + 1;
			if (attemptCount >= current.max_attempts) {
				const deadLetter = TelegramIngressRecordSchema.parse({
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
			const retried = TelegramIngressRecordSchema.parse({
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
		});
	}
}
