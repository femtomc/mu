import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { UiEventSchema, type UiEvent } from "@femtomc/mu-core";

const CALLBACK_PREFIX = "mu-ui:";
const UI_CALLBACK_DATA_MAX_BYTES = 64;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{10,48}$/;

export const UiCallbackTokenScopeSchema = z.object({
	channel: z.string().trim().min(1),
	channelTenantId: z.string().trim().min(1),
	channelConversationId: z.string().trim().min(1),
	actorBindingId: z.string().trim().min(1),
	uiId: z.string().trim().min(1),
	revision: z.number().int().nonnegative(),
	actionId: z.string().trim().min(1),
});
export type UiCallbackTokenScope = z.infer<typeof UiCallbackTokenScopeSchema>;

export const UiCallbackTokenContextSchema = z.object({
	channel: z.string().trim().min(1),
	channelTenantId: z.string().trim().min(1),
	channelConversationId: z.string().trim().min(1),
	actorBindingId: z.string().trim().min(1),
});
export type UiCallbackTokenContext = z.infer<typeof UiCallbackTokenContextSchema>;

const StoredUiEventSchema = UiEventSchema.transform((event) => {
	const clone: UiEvent = { ...event };
	if (clone.callback_token) {
		Reflect.deleteProperty(clone, "callback_token");
	}
	return clone;
});

export const UiCallbackTokenRecordSchema = z.object({
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	callback_data: z.string().min(1),
	channel: z.string().trim().min(1),
	channel_tenant_id: z.string().trim().min(1),
	channel_conversation_id: z.string().trim().min(1),
	actor_binding_id: z.string().trim().min(1),
	ui_id: z.string().trim().min(1),
	revision: z.number().int().nonnegative(),
	action_id: z.string().trim().min(1),
	created_at_ms: z.number().int(),
	expires_at_ms: z.number().int(),
	consumed_at_ms: z.number().int().nullable(),
	consume_count: z.number().int().nonnegative(),
	ui_event: StoredUiEventSchema,
});
export type UiCallbackTokenRecord = z.infer<typeof UiCallbackTokenRecordSchema>;

const IssueEntrySchema = z.object({
	kind: z.literal("issue"),
	ts_ms: z.number().int(),
	scope: UiCallbackTokenScopeSchema,
	record: UiCallbackTokenRecordSchema,
});

const ConsumeEntrySchema = z.object({
	kind: z.literal("consume"),
	ts_ms: z.number().int(),
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	record: UiCallbackTokenRecordSchema,
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
	record: UiCallbackTokenRecordSchema,
});

const DecodeConsumedEntrySchema = z.object({
	kind: z.literal("decode_consumed"),
	ts_ms: z.number().int(),
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	callback_data: z.string(),
	record: UiCallbackTokenRecordSchema,
});

const DecodeScopeMismatchEntrySchema = z.object({
	kind: z.literal("decode_scope_mismatch"),
	ts_ms: z.number().int(),
	token_id: z.string().regex(TOKEN_ID_PATTERN),
	callback_data: z.string(),
	expected_scope: UiCallbackTokenScopeSchema,
	record: UiCallbackTokenRecordSchema,
});

export const UiCallbackTokenJournalEntrySchema = z.discriminatedUnion("kind", [
	IssueEntrySchema,
	ConsumeEntrySchema,
	DecodeInvalidEntrySchema,
	DecodeExpiredEntrySchema,
	DecodeConsumedEntrySchema,
	DecodeScopeMismatchEntrySchema,
]);
export type UiCallbackTokenJournalEntry = z.infer<typeof UiCallbackTokenJournalEntrySchema>;

export type UiCallbackTokenDecodeDecision =
	| { kind: "ok"; record: UiCallbackTokenRecord }
	| { kind: "invalid"; reason: "invalid_callback_data" | "unknown_callback_token" }
	| { kind: "expired"; record: UiCallbackTokenRecord }
	| { kind: "consumed"; record: UiCallbackTokenRecord }
	| { kind: "scope_mismatch"; record: UiCallbackTokenRecord };

function cloneRecord(record: UiCallbackTokenRecord): UiCallbackTokenRecord {
	return UiCallbackTokenRecordSchema.parse(record);
}

function randomTokenId(): string {
	return randomBytes(12).toString("base64url");
}

function encodeCallbackData(tokenId: string): string {
	const data = `${CALLBACK_PREFIX}${tokenId}`;
	const byteLen = new TextEncoder().encode(data).length;
	if (byteLen > UI_CALLBACK_DATA_MAX_BYTES) {
		throw new Error(`ui callback_data exceeds ${UI_CALLBACK_DATA_MAX_BYTES} bytes`);
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

function scopeMatches(record: UiCallbackTokenRecord, scope: UiCallbackTokenScope): boolean {
	return (
		record.channel === scope.channel &&
		record.channel_tenant_id === scope.channelTenantId &&
		record.channel_conversation_id === scope.channelConversationId &&
		record.actor_binding_id === scope.actorBindingId &&
		record.ui_id === scope.uiId &&
		record.revision === scope.revision &&
		record.action_id === scope.actionId
	);
}

function contextMatches(record: UiCallbackTokenRecord, context: UiCallbackTokenContext): boolean {
	return (
		record.channel === context.channel &&
		record.channel_tenant_id === context.channelTenantId &&
		record.channel_conversation_id === context.channelConversationId &&
		record.actor_binding_id === context.actorBindingId
	);
}

export type UiCallbackTokenStoreOpts = {
	nowMs?: () => number;
	tokenIdGenerator?: () => string;
};

export class UiCallbackTokenStore {
	readonly #path: string;
	readonly #nowMs: () => number;
	readonly #tokenIdGenerator: () => string;
	#loaded = false;
	readonly #recordsByTokenId = new Map<string, UiCallbackTokenRecord>();

	public constructor(path: string, opts: UiCallbackTokenStoreOpts = {}) {
		this.#path = path;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#tokenIdGenerator = opts.tokenIdGenerator ?? randomTokenId;
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		this.#recordsByTokenId.clear();
		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = UiCallbackTokenJournalEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid ui callback token row ${idx}: ${parsed.error.message}`);
			}
			const row = parsed.data;
			if (row.kind === "issue" || row.kind === "consume") {
				this.#recordsByTokenId.set(row.record.token_id, cloneRecord(row.record));
			}
		}
		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	public async issue(opts: { scope: UiCallbackTokenScope; uiEvent: UiEvent; ttlMs: number; nowMs?: number }): Promise<UiCallbackTokenRecord> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const ttlMs = Math.trunc(opts.ttlMs);
		if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
			throw new Error(`ttlMs must be a positive integer, got ${opts.ttlMs}`);
		}
		const scope = UiCallbackTokenScopeSchema.parse(opts.scope);

		let tokenId = "";
		for (let attempt = 0; attempt < 10; attempt++) {
			tokenId = this.#tokenIdGenerator();
			if (!this.#recordsByTokenId.has(tokenId)) {
				break;
			}
		}
		if (!tokenId || this.#recordsByTokenId.has(tokenId)) {
			throw new Error("failed_to_allocate_unique_ui_callback_token");
		}

		const uiEventForRecord = StoredUiEventSchema.parse(opts.uiEvent);
		const record = UiCallbackTokenRecordSchema.parse({
			token_id: tokenId,
			callback_data: encodeCallbackData(tokenId),
			channel: scope.channel,
			channel_tenant_id: scope.channelTenantId,
			channel_conversation_id: scope.channelConversationId,
			actor_binding_id: scope.actorBindingId,
			ui_id: scope.uiId,
			revision: scope.revision,
			action_id: scope.actionId,
			created_at_ms: nowMs,
			expires_at_ms: nowMs + ttlMs,
			consumed_at_ms: null,
			consume_count: 0,
			ui_event: uiEventForRecord,
		});

		await appendJsonl(this.#path, {
			kind: "issue",
			ts_ms: nowMs,
			scope,
			record,
		});
		this.#recordsByTokenId.set(tokenId, cloneRecord(record));
		return cloneRecord(record);
	}

	async #consumeExisting(opts: {
		existing: UiCallbackTokenRecord;
		tokenId: string;
		callbackData: string;
		nowMs: number;
	}): Promise<UiCallbackTokenDecodeDecision> {
		if (opts.existing.consumed_at_ms != null) {
			await appendJsonl(this.#path, {
				kind: "decode_consumed",
				ts_ms: opts.nowMs,
				token_id: opts.tokenId,
				callback_data: opts.callbackData,
				record: cloneRecord(opts.existing),
			});
			return { kind: "consumed", record: cloneRecord(opts.existing) };
		}

		const consumed = UiCallbackTokenRecordSchema.parse({
			...opts.existing,
			consumed_at_ms: opts.nowMs,
			consume_count: opts.existing.consume_count + 1,
		});
		await appendJsonl(this.#path, {
			kind: "consume",
			ts_ms: opts.nowMs,
			token_id: opts.tokenId,
			record: consumed,
		});
		this.#recordsByTokenId.set(opts.tokenId, cloneRecord(consumed));
		return { kind: "ok", record: cloneRecord(consumed) };
	}

	public async decodeAndConsume(opts: {
		callbackData: string;
		scope: UiCallbackTokenScope;
		nowMs?: number;
	}): Promise<UiCallbackTokenDecodeDecision> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const scope = UiCallbackTokenScopeSchema.parse(opts.scope);
		const callbackData = opts.callbackData;
		const tokenId = decodeTokenId(callbackData);
		if (!tokenId) {
			await appendJsonl(this.#path, {
				kind: "decode_invalid",
				ts_ms: nowMs,
				callback_data: callbackData,
				reason: "format",
			});
			return { kind: "invalid", reason: "invalid_callback_data" };
		}

		const existing = this.#recordsByTokenId.get(tokenId);
		if (!existing) {
			await appendJsonl(this.#path, {
				kind: "decode_invalid",
				ts_ms: nowMs,
				callback_data: callbackData,
				reason: "unknown_token",
			});
			return { kind: "invalid", reason: "unknown_callback_token" };
		}

		if (existing.expires_at_ms <= nowMs) {
			await appendJsonl(this.#path, {
				kind: "decode_expired",
				ts_ms: nowMs,
				token_id: tokenId,
				callback_data: callbackData,
				record: cloneRecord(existing),
			});
			return { kind: "expired", record: cloneRecord(existing) };
		}

		if (!scopeMatches(existing, scope)) {
			await appendJsonl(this.#path, {
				kind: "decode_scope_mismatch",
				ts_ms: nowMs,
				token_id: tokenId,
				callback_data: callbackData,
				expected_scope: scope,
				record: cloneRecord(existing),
			});
			return { kind: "scope_mismatch", record: cloneRecord(existing) };
		}

		return await this.#consumeExisting({
			existing,
			tokenId,
			callbackData,
			nowMs,
		});
	}

	public async decodeAndConsumeForContext(opts: {
		callbackData: string;
		context: UiCallbackTokenContext;
		nowMs?: number;
	}): Promise<UiCallbackTokenDecodeDecision> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());
		const context = UiCallbackTokenContextSchema.parse(opts.context);
		const callbackData = opts.callbackData;
		const tokenId = decodeTokenId(callbackData);
		if (!tokenId) {
			await appendJsonl(this.#path, {
				kind: "decode_invalid",
				ts_ms: nowMs,
				callback_data: callbackData,
				reason: "format",
			});
			return { kind: "invalid", reason: "invalid_callback_data" };
		}

		const existing = this.#recordsByTokenId.get(tokenId);
		if (!existing) {
			await appendJsonl(this.#path, {
				kind: "decode_invalid",
				ts_ms: nowMs,
				callback_data: callbackData,
				reason: "unknown_token",
			});
			return { kind: "invalid", reason: "unknown_callback_token" };
		}

		if (existing.expires_at_ms <= nowMs) {
			await appendJsonl(this.#path, {
				kind: "decode_expired",
				ts_ms: nowMs,
				token_id: tokenId,
				callback_data: callbackData,
				record: cloneRecord(existing),
			});
			return { kind: "expired", record: cloneRecord(existing) };
		}

		if (!contextMatches(existing, context)) {
			await appendJsonl(this.#path, {
				kind: "decode_scope_mismatch",
				ts_ms: nowMs,
				token_id: tokenId,
				callback_data: callbackData,
				expected_scope: {
					channel: context.channel,
					channelTenantId: context.channelTenantId,
					channelConversationId: context.channelConversationId,
					actorBindingId: context.actorBindingId,
					uiId: existing.ui_id,
					revision: existing.revision,
					actionId: existing.action_id,
				},
				record: cloneRecord(existing),
			});
			return { kind: "scope_mismatch", record: cloneRecord(existing) };
		}

		return await this.#consumeExisting({
			existing,
			tokenId,
			callbackData,
			nowMs,
		});
	}
}
