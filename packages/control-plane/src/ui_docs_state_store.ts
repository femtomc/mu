import { normalizeUiDocs, stableSerializeJson, UiDocSchema, type UiDoc } from "@femtomc/mu-core";
import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { z } from "zod";
import type { InboundEnvelope } from "./models.js";

export const UI_DOCS_STATE_STORE_VERSION = 1;
const UI_DOCS_STATE_DOCS_MAX = 16;
const AUTONOMOUS_INGRESS_SOURCE = "autonomous_ingress";

export const UiDocsStateScopeSchema = z.object({
	kind: z.enum(["session", "conversation"]),
	id: z.string().trim().min(1),
});
export type UiDocsStateScope = z.infer<typeof UiDocsStateScopeSchema>;

export const UiDocsStateWriterSchema = z.object({
	source: z.string().trim().min(1),
	request_id: z.string().trim().min(1).nullable().optional(),
	channel: z.string().trim().min(1).nullable().optional(),
	actor_binding_id: z.string().trim().min(1).nullable().optional(),
	session_id: z.string().trim().min(1).nullable().optional(),
	wake_id: z.string().trim().min(1).nullable().optional(),
	program_id: z.string().trim().min(1).nullable().optional(),
});
export type UiDocsStateWriter = z.infer<typeof UiDocsStateWriterSchema>;

export const UiDocsStateRecordSchema = z.object({
	v: z.literal(UI_DOCS_STATE_STORE_VERSION).default(UI_DOCS_STATE_STORE_VERSION),
	kind: z.literal("ui_docs_state"),
	scope: UiDocsStateScopeSchema,
	rev: z.number().int().positive(),
	updated_at_ms: z.number().int(),
	docs: z.array(UiDocSchema).max(UI_DOCS_STATE_DOCS_MAX),
	writer: UiDocsStateWriterSchema,
});
export type UiDocsStateRecord = z.infer<typeof UiDocsStateRecordSchema>;

export type UiDocsStateUpsertDecision =
	| { kind: "updated"; record: UiDocsStateRecord }
	| { kind: "unchanged"; record: UiDocsStateRecord };

function cloneRecord(record: UiDocsStateRecord): UiDocsStateRecord {
	return UiDocsStateRecordSchema.parse(record);
}

function scopeKey(scope: UiDocsStateScope): string {
	return `${scope.kind}:${scope.id}`;
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldReplaceRecord(existing: UiDocsStateRecord, candidate: UiDocsStateRecord): boolean {
	if (candidate.rev !== existing.rev) {
		return candidate.rev > existing.rev;
	}
	if (candidate.updated_at_ms !== existing.updated_at_ms) {
		return candidate.updated_at_ms > existing.updated_at_ms;
	}
	return scopeKey(candidate.scope).localeCompare(scopeKey(existing.scope)) >= 0;
}

function metadataForInbound(inbound: InboundEnvelope): Record<string, unknown> {
	return isPlainObject(inbound.metadata) ? inbound.metadata : {};
}

export function uiDocsStateScopeForInbound(inbound: InboundEnvelope): UiDocsStateScope {
	const metadata = metadataForInbound(inbound);
	const source = nonEmptyString(metadata.source);
	if (source === AUTONOMOUS_INGRESS_SOURCE) {
		const sessionId = nonEmptyString(metadata.operator_session_id);
		if (sessionId) {
			return UiDocsStateScopeSchema.parse({
				kind: "session",
				id: sessionId,
			});
		}
		const programId = nonEmptyString(metadata.program_id) ?? nonEmptyString(metadata.wake_program_id);
		if (programId) {
			return UiDocsStateScopeSchema.parse({
				kind: "session",
				id: `heartbeat-program:${programId}`,
			});
		}
	}
	return UiDocsStateScopeSchema.parse({
		kind: "conversation",
		id: `${inbound.channel}:${inbound.channel_tenant_id}:${inbound.channel_conversation_id}:${inbound.actor_binding_id}`,
	});
}

export function uiDocsStateWriterForInbound(inbound: InboundEnvelope): UiDocsStateWriter {
	const metadata = metadataForInbound(inbound);
	const source = nonEmptyString(metadata.source) ?? "adapter_ingress";
	return UiDocsStateWriterSchema.parse({
		source,
		request_id: inbound.request_id,
		channel: inbound.channel,
		actor_binding_id: inbound.actor_binding_id,
		session_id: nonEmptyString(metadata.operator_session_id),
		wake_id: nonEmptyString(metadata.wake_id),
		program_id: nonEmptyString(metadata.program_id) ?? nonEmptyString(metadata.wake_program_id),
	});
}

export class UiDocsStateStore {
	readonly #path: string;
	readonly #nowMs: () => number;
	#loaded = false;
	readonly #latestByScope = new Map<string, UiDocsStateRecord>();

	public constructor(path: string, opts: { nowMs?: () => number } = {}) {
		this.#path = path;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		this.#latestByScope.clear();
		for (let idx = 0; idx < rows.length; idx += 1) {
			const parsed = UiDocsStateRecordSchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid ui docs state row ${idx}: ${parsed.error.message}`);
			}
			const record = parsed.data;
			const key = scopeKey(record.scope);
			const existing = this.#latestByScope.get(key);
			if (!existing || shouldReplaceRecord(existing, record)) {
				this.#latestByScope.set(key, cloneRecord(record));
			}
		}
		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	public get(scope: UiDocsStateScope): UiDocsStateRecord | null {
		const existing = this.#latestByScope.get(scopeKey(UiDocsStateScopeSchema.parse(scope)));
		return existing ? cloneRecord(existing) : null;
	}

	public snapshot(opts: { scopeKind?: UiDocsStateScope["kind"]; limit?: number } = {}): UiDocsStateRecord[] {
		const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
		return [...this.#latestByScope.values()]
			.filter((record) => {
				if (opts.scopeKind && record.scope.kind !== opts.scopeKind) {
					return false;
				}
				return true;
			})
			.sort((left, right) => {
				if (left.updated_at_ms !== right.updated_at_ms) {
					return left.updated_at_ms - right.updated_at_ms;
				}
				return scopeKey(left.scope).localeCompare(scopeKey(right.scope));
			})
			.slice(0, limit)
			.map((record) => cloneRecord(record));
	}

	public async upsert(opts: {
		scope: UiDocsStateScope;
		docs: unknown;
		writer: UiDocsStateWriter;
		nowMs?: number;
	}): Promise<UiDocsStateUpsertDecision> {
		await this.#ensureLoaded();
		const scope = UiDocsStateScopeSchema.parse(opts.scope);
		const writer = UiDocsStateWriterSchema.parse(opts.writer);
		const docs = normalizeUiDocs(opts.docs, { maxDocs: UI_DOCS_STATE_DOCS_MAX });
		const nowMs = Math.trunc(opts.nowMs ?? this.#nowMs());

		const key = scopeKey(scope);
		const existing = this.#latestByScope.get(key);
		if (existing) {
			const sameDocs = stableSerializeJson(existing.docs) === stableSerializeJson(docs);
			if (sameDocs) {
				return { kind: "unchanged", record: cloneRecord(existing) };
			}
		}

		const record = UiDocsStateRecordSchema.parse({
			v: UI_DOCS_STATE_STORE_VERSION,
			kind: "ui_docs_state",
			scope,
			rev: (existing?.rev ?? 0) + 1,
			updated_at_ms: nowMs,
			docs,
			writer,
		});
		await appendJsonl(this.#path, record);
		this.#latestByScope.set(key, cloneRecord(record));
		return { kind: "updated", record: cloneRecord(record) };
	}
}
