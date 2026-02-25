import { UiEvent, UiEventSchema } from "@femtomc/mu-core";
import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const CALLBACK_PREFIX = "mu-ui:";
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{10,48}$/;
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const StoredTelegramUiEventSchema = UiEventSchema.transform((event) => {
	const clone: UiEvent = { ...event };
	if (clone.callback_token) {
		Reflect.deleteProperty(clone, "callback_token");
	}
	return clone;
});

export const TelegramCallbackTokenScopeSchema = z.object({
	channelTenantId: z.string().trim().min(1),
	channelConversationId: z.string().trim().min(1),
	actorId: z.string().trim().min(1),
	actorBindingId: z.string().trim().min(1),
});
export type TelegramCallbackTokenScope = z.infer<typeof TelegramCallbackTokenScopeSchema>;

export const TelegramCallbackCommandActionSchema = z.object({
	kind: z.literal("command"),
	command_text: z.string().trim().min(1).max(280),
});

export const TelegramCallbackActionSchema = z.discriminatedUnion("kind", [TelegramCallbackCommandActionSchema]);
export type TelegramCallbackAction = z.infer<typeof TelegramCallbackActionSchema>;

export const TelegramCallbackTokenRecordSchema = z.object({
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	callback_data: z.string().min(1),
	action: TelegramCallbackActionSchema,
	scope: TelegramCallbackTokenScopeSchema.optional(),
	ui_event: StoredTelegramUiEventSchema.optional(),
	created_at_ms: z.number().int(),
	expires_at_ms: z.number().int(),
	consumed_at_ms: z.number().int().nullable(),
	consume_count: z.number().int().nonnegative(),
});
export type TelegramCallbackTokenRecord = z.infer<typeof TelegramCallbackTokenRecordSchema>;

const IssueEntrySchema = z.object({
	kind: z.literal("issue"),
	ts_ms: z.number().int(),
	scope: TelegramCallbackTokenScopeSchema.optional(),
	record: TelegramCallbackTokenRecordSchema,
});

const ConsumeEntrySchema = z.object({
	kind: z.literal("consume"),
	ts_ms: z.number().int(),
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	record: TelegramCallbackTokenRecordSchema,
});

const DecodeInvalidEntrySchema = z.object({
	kind: z.literal("decode_invalid"),
	ts_ms: z.number().int(),
	callback_data: z.string(),
	reason: z.enum(["format", "unknown_token"]),
});

const DecodeExpiredEntrySchema = z.object({
	kind: z.literal("decode_expired"),
	ts_ms: z.number().int(),
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	callback_data: z.string(),
	record: TelegramCallbackTokenRecordSchema.optional(),
});

const DecodeConsumedEntrySchema = z.object({
	kind: z.literal("decode_consumed"),
	ts_ms: z.number().int(),
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	callback_data: z.string(),
	record: TelegramCallbackTokenRecordSchema,
});

const DecodeScopeMismatchEntrySchema = z.object({
	kind: z.literal("decode_scope_mismatch"),
	ts_ms: z.number().int(),
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	callback_data: z.string(),
	expected_scope: TelegramCallbackTokenScopeSchema,
	record: TelegramCallbackTokenRecordSchema,
});

export const TelegramCallbackTokenJournalEntrySchema = z.discriminatedUnion("kind", [
	IssueEntrySchema,
	ConsumeEntrySchema,
	DecodeInvalidEntrySchema,
	DecodeExpiredEntrySchema,
	DecodeConsumedEntrySchema,
	DecodeScopeMismatchEntrySchema,
]);
export type TelegramCallbackTokenJournalEntry = z.infer<typeof TelegramCallbackTokenJournalEntrySchema>;

export type TelegramCallbackTokenDecodeDecision =
	| { kind: "ok"; record: TelegramCallbackTokenRecord }
	| { kind: "invalid"; reason: "invalid_callback_data" | "unknown_callback_token" }
	| { kind: "expired"; record: TelegramCallbackTokenRecord }
	| { kind: "consumed"; record: TelegramCallbackTokenRecord }
	| { kind: "scope_mismatch"; record: TelegramCallbackTokenRecord };

function cloneRecord(record: TelegramCallbackTokenRecord): TelegramCallbackTokenRecord {
	return TelegramCallbackTokenRecordSchema.parse(record);
}

function randomTokenId(): string {
	return randomBytes(12).toString("base64url");
}

function encodeCallbackData(tokenId: string): string {
	const data = `${CALLBACK_PREFIX}${tokenId}`;
	const byteLen = new TextEncoder().encode(data).length;
	if (byteLen > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
		throw new Error(`telegram callback_data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes`);
	}
	return data;
}

function decodeTokenId(callbackData: string): string | null {
	if (!callbackData.startsWith(CALLBACK_PREFIX)) {
		return null;
	}
	const tokenId = callbackData.slice(CALLBACK_PREFIX.length);
	if (!TOKEN_ID_PATTERN.test(tokenId)) {
		return null;
	}
	return tokenId;
}

export class TelegramCallbackTokenStore {
	readonly #path: string;
	readonly #nowMs: () => number;
	#loaded = false;
	readonly #recordsByTokenId = new Map<string, TelegramCallbackTokenRecord>();

	public constructor(path: string, opts: { nowMs?: () => number } = {}) {
		this.#path = path;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		this.#recordsByTokenId.clear();
		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = TelegramCallbackTokenJournalEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid telegram callback token row ${idx}: ${parsed.error.message}`);
			}
			const row = parsed.data;
			switch (row.kind) {
				case "issue":
				case "consume":
					this.#recordsByTokenId.set(row.record.token_id, cloneRecord(row.record));
					break;
				case "decode_invalid":
				case "decode_expired":
				case "decode_consumed":
				case "decode_scope_mismatch":
					break;
			}
		}
		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	public async issue(opts: {
		action: TelegramCallbackAction;
		ttlMs: number;
		nowMs?: number;
		scope?: TelegramCallbackTokenScope;
		uiEvent?: UiEvent;
	}): Promise<TelegramCallbackTokenRecord> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const ttlMs = Math.trunc(opts.ttlMs);
		if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
			throw new Error(`ttlMs must be a positive integer, got ${opts.ttlMs}`);
		}
		const action = TelegramCallbackActionSchema.parse(opts.action);
		const scope = opts.scope ? TelegramCallbackTokenScopeSchema.parse(opts.scope) : undefined;
		const uiEventForRecord = opts.uiEvent ? StoredTelegramUiEventSchema.parse(opts.uiEvent) : undefined;

		let tokenId = "";
		for (let attempt = 0; attempt < 10; attempt++) {
			tokenId = randomTokenId();
			if (!this.#recordsByTokenId.has(tokenId)) {
				break;
			}
		}
		if (!tokenId || this.#recordsByTokenId.has(tokenId)) {
			throw new Error("failed_to_allocate_unique_telegram_callback_token");
		}

		const record = TelegramCallbackTokenRecordSchema.parse({
			token_id: tokenId,
			callback_data: encodeCallbackData(tokenId),
			action,
			scope,
			ui_event: uiEventForRecord,
			created_at_ms: nowMs,
			expires_at_ms: nowMs + ttlMs,
			consumed_at_ms: null,
			consume_count: 0,
		});

		await appendJsonl(this.#path, {
			kind: "issue",
			ts_ms: nowMs,
			scope,
			record,
		});
		this.#recordsByTokenId.set(tokenId, record);
		return cloneRecord(record);
	}

	public async decodeAndConsume(opts: {
		callbackData: string;
		scope?: TelegramCallbackTokenScope;
		nowMs?: number;
	}): Promise<TelegramCallbackTokenDecodeDecision> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const scope = opts.scope ? TelegramCallbackTokenScopeSchema.parse(opts.scope) : null;
		const tokenId = decodeTokenId(opts.callbackData);
		if (!tokenId) {
			await appendJsonl(this.#path, {
				kind: "decode_invalid",
				ts_ms: nowMs,
				callback_data: opts.callbackData,
				reason: "format",
			});
			return { kind: "invalid", reason: "invalid_callback_data" };
		}

		const existing = this.#recordsByTokenId.get(tokenId);
		if (!existing) {
			await appendJsonl(this.#path, {
				kind: "decode_invalid",
				ts_ms: nowMs,
				callback_data: opts.callbackData,
				reason: "unknown_token",
			});
			return { kind: "invalid", reason: "unknown_callback_token" };
		}

		if (scope && existing.scope && !scopeMatches(existing, scope)) {
			await appendJsonl(this.#path, {
				kind: "decode_scope_mismatch",
				ts_ms: nowMs,
				token_id: tokenId,
				callback_data: opts.callbackData,
				expected_scope: scope,
				record: cloneRecord(existing),
			});
			return { kind: "scope_mismatch", record: cloneRecord(existing) };
		}

		if (existing.expires_at_ms <= nowMs) {
			await appendJsonl(this.#path, {
				kind: "decode_expired",
				ts_ms: nowMs,
				token_id: tokenId,
				callback_data: opts.callbackData,
				record: cloneRecord(existing),
			});
			return { kind: "expired", record: cloneRecord(existing) };
		}

		if (existing.consumed_at_ms != null) {
			await appendJsonl(this.#path, {
				kind: "decode_consumed",
				ts_ms: nowMs,
				token_id: tokenId,
				callback_data: opts.callbackData,
				record: cloneRecord(existing),
			});
			return { kind: "consumed", record: cloneRecord(existing) };
		}

		const consumed = TelegramCallbackTokenRecordSchema.parse({
			...existing,
			consumed_at_ms: nowMs,
			consume_count: existing.consume_count + 1,
		});
		await appendJsonl(this.#path, {
			kind: "consume",
			ts_ms: nowMs,
			token_id: tokenId,
			record: consumed,
		});
		this.#recordsByTokenId.set(tokenId, consumed);
		return { kind: "ok", record: cloneRecord(consumed) };
	}
}

function scopeMatches(record: TelegramCallbackTokenRecord, scope: TelegramCallbackTokenScope): boolean {
	if (!record.scope) {
		return true;
	}
	return (
		record.scope.channelTenantId === scope.channelTenantId &&
		record.scope.channelConversationId === scope.channelConversationId &&
		record.scope.actorId === scope.actorId &&
		record.scope.actorBindingId === scope.actorBindingId
	);
}
