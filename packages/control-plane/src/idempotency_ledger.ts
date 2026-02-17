import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { z } from "zod";

export const IdempotencyClaimRecordSchema = z.object({
	key: z.string().min(1),
	fingerprint: z.string().min(1),
	command_id: z.string().min(1),
	ttl_ms: z.number().int().positive(),
	first_seen_ms: z.number().int(),
	last_seen_ms: z.number().int(),
	expires_at_ms: z.number().int(),
});
export type IdempotencyClaimRecord = z.infer<typeof IdempotencyClaimRecordSchema>;

const ClaimEntrySchema = z.object({
	kind: z.literal("claim"),
	ts_ms: z.number().int(),
	record: IdempotencyClaimRecordSchema,
});

const DuplicateEntrySchema = z.object({
	kind: z.literal("duplicate"),
	ts_ms: z.number().int(),
	key: z.string().min(1),
	fingerprint: z.string().min(1),
	record: IdempotencyClaimRecordSchema,
});

const ConflictEntrySchema = z.object({
	kind: z.literal("conflict"),
	ts_ms: z.number().int(),
	key: z.string().min(1),
	incoming_fingerprint: z.string().min(1),
	record: IdempotencyClaimRecordSchema,
});

export const IdempotencyLedgerEntrySchema = z.discriminatedUnion("kind", [
	ClaimEntrySchema,
	DuplicateEntrySchema,
	ConflictEntrySchema,
]);
export type IdempotencyLedgerEntry = z.infer<typeof IdempotencyLedgerEntrySchema>;

export type IdempotencyClaimDecision =
	| { kind: "created"; record: IdempotencyClaimRecord }
	| { kind: "duplicate"; record: IdempotencyClaimRecord }
	| { kind: "conflict"; record: IdempotencyClaimRecord; incomingFingerprint: string };

function cloneRecord(record: IdempotencyClaimRecord): IdempotencyClaimRecord {
	return {
		...record,
	};
}

export class IdempotencyLedger {
	readonly #path: string;
	#loaded = false;
	readonly #byKey = new Map<string, IdempotencyClaimRecord>();

	public constructor(path: string) {
		this.#path = path;
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		this.#byKey.clear();
		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = IdempotencyLedgerEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid idempotency row ${idx}: ${parsed.error.message}`);
			}
			const entry = parsed.data;
			switch (entry.kind) {
				case "claim":
					this.#byKey.set(entry.record.key, cloneRecord(entry.record));
					break;
				case "duplicate": {
					const existing = this.#byKey.get(entry.key);
					if (existing) {
						this.#byKey.set(entry.key, {
							...existing,
							last_seen_ms: Math.max(existing.last_seen_ms, entry.ts_ms),
						});
					} else {
						this.#byKey.set(entry.key, cloneRecord(entry.record));
					}
					break;
				}
				case "conflict": {
					if (!this.#byKey.has(entry.key)) {
						this.#byKey.set(entry.key, cloneRecord(entry.record));
					}
					break;
				}
			}
		}
		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	public async lookup(key: string, opts: { nowMs?: number } = {}): Promise<IdempotencyClaimRecord | null> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const existing = this.#byKey.get(key);
		if (!existing) {
			return null;
		}
		if (existing.expires_at_ms <= nowMs) {
			return null;
		}
		return cloneRecord(existing);
	}

	public async claim(opts: {
		key: string;
		fingerprint: string;
		commandId: string;
		ttlMs: number;
		nowMs?: number;
	}): Promise<IdempotencyClaimDecision> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const ttlMs = Math.trunc(opts.ttlMs);
		if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
			throw new Error(`ttlMs must be a positive integer, got ${opts.ttlMs}`);
		}

		const existing = this.#byKey.get(opts.key);
		if (existing && existing.expires_at_ms > nowMs) {
			if (existing.fingerprint === opts.fingerprint) {
				const updated = IdempotencyClaimRecordSchema.parse({
					...existing,
					last_seen_ms: nowMs,
				});
				await appendJsonl(this.#path, {
					kind: "duplicate",
					ts_ms: nowMs,
					key: opts.key,
					fingerprint: opts.fingerprint,
					record: updated,
				});
				this.#byKey.set(opts.key, updated);
				return { kind: "duplicate", record: cloneRecord(updated) };
			}

			await appendJsonl(this.#path, {
				kind: "conflict",
				ts_ms: nowMs,
				key: opts.key,
				incoming_fingerprint: opts.fingerprint,
				record: existing,
			});
			return {
				kind: "conflict",
				record: cloneRecord(existing),
				incomingFingerprint: opts.fingerprint,
			};
		}

		const created = IdempotencyClaimRecordSchema.parse({
			key: opts.key,
			fingerprint: opts.fingerprint,
			command_id: opts.commandId,
			ttl_ms: ttlMs,
			first_seen_ms: nowMs,
			last_seen_ms: nowMs,
			expires_at_ms: nowMs + ttlMs,
		});
		await appendJsonl(this.#path, {
			kind: "claim",
			ts_ms: nowMs,
			record: created,
		});
		this.#byKey.set(opts.key, created);
		return { kind: "created", record: cloneRecord(created) };
	}

	public snapshot(opts: { nowMs?: number } = {}): IdempotencyClaimRecord[] {
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const out: IdempotencyClaimRecord[] = [];
		for (const record of this.#byKey.values()) {
			if (record.expires_at_ms > nowMs) {
				out.push(cloneRecord(record));
			}
		}
		out.sort((a, b) => {
			if (a.first_seen_ms !== b.first_seen_ms) {
				return a.first_seen_ms - b.first_seen_ms;
			}
			return a.key.localeCompare(b.key);
		});
		return out;
	}
}
