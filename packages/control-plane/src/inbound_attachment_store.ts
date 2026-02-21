import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize } from "node:path";
import { z } from "zod";
import { type Channel, ChannelSchema } from "./identity_store.js";

export const InboundAttachmentStoreRecordSchema = z.object({
	attachment_id: z.string().min(1),
	channel: ChannelSchema,
	source: z.string().min(1),
	source_file_id: z.string().min(1).nullable(),
	content_hash_sha256: z.string().regex(/^[a-f0-9]{64}$/),
	mime_type: z.string().min(1).nullable(),
	original_filename: z.string().min(1).nullable(),
	safe_filename: z.string().min(1),
	size_bytes: z.number().int().nonnegative(),
	blob_relpath: z.string().min(1),
	created_at_ms: z.number().int(),
	last_seen_at_ms: z.number().int(),
	expires_at_ms: z.number().int(),
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type InboundAttachmentStoreRecord = z.infer<typeof InboundAttachmentStoreRecordSchema>;

const InboundAttachmentStoreUpsertEntrySchema = z.object({
	kind: z.literal("upsert"),
	ts_ms: z.number().int(),
	record: InboundAttachmentStoreRecordSchema,
	dedupe_kind: z.enum(["none", "source_file_id", "content_hash"]),
});

const InboundAttachmentStoreExpireEntrySchema = z.object({
	kind: z.literal("expire"),
	ts_ms: z.number().int(),
	attachment_id: z.string().min(1),
	reason: z.literal("ttl"),
});

const InboundAttachmentStoreEntrySchema = z.discriminatedUnion("kind", [
	InboundAttachmentStoreUpsertEntrySchema,
	InboundAttachmentStoreExpireEntrySchema,
]);

type InboundAttachmentStoreEntry = z.infer<typeof InboundAttachmentStoreEntrySchema>;

type PutInboundAttachmentOpts = {
	channel: Channel;
	source: string;
	sourceFileId?: string | null;
	filename?: string | null;
	mimeType?: string | null;
	bytes: Uint8Array;
	nowMs?: number;
	ttlMs: number;
	metadata?: Record<string, unknown>;
};

export type PutInboundAttachmentResult = {
	record: InboundAttachmentStoreRecord;
	dedupe_kind: "none" | "source_file_id" | "content_hash";
};

export type InboundAttachmentCleanupResult = {
	expired_count: number;
	removed_blob_count: number;
	expired_attachment_ids: string[];
};

function sanitizeFilename(value: string | null | undefined): string {
	const fallback = "attachment.bin";
	if (!value) {
		return fallback;
	}
	const base = basename(value).trim();
	if (base.length === 0 || base === "." || base === "..") {
		return fallback;
	}
	const cleaned = base
		.replace(/[\x00-\x1F\x7F]/g, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[.-]+/, "")
		.replace(/[.-]+$/, "");
	if (cleaned.length === 0) {
		return fallback;
	}
	return cleaned.slice(0, 128);
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function attachmentIdFor(opts: { channel: Channel; source: string; sourceFileId: string | null; contentHash: string }): string {
	const stable = `${opts.channel}:${opts.source}:${opts.sourceFileId ?? "-"}:${opts.contentHash}`;
	return `att-${createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

function normalizeRelpath(relpath: string): string {
	return normalize(relpath).replaceAll("\\", "/");
}

export class InboundAttachmentStore {
	readonly #indexPath: string;
	readonly #blobRootDir: string;
	#loaded = false;
	readonly #records = new Map<string, InboundAttachmentStoreRecord>();

	public constructor(opts: { indexPath: string; blobRootDir: string }) {
		this.#indexPath = opts.indexPath;
		this.#blobRootDir = opts.blobRootDir;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#indexPath);
		this.#records.clear();
		for (let idx = 0; idx < rows.length; idx += 1) {
			const parsed = InboundAttachmentStoreEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid inbound attachment row ${idx}: ${parsed.error.message}`);
			}
			const row = parsed.data;
			if (row.kind === "upsert") {
				this.#records.set(row.record.attachment_id, { ...row.record, metadata: { ...row.record.metadata } });
				continue;
			}
			this.#records.delete(row.attachment_id);
		}
		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	public async put(opts: PutInboundAttachmentOpts): Promise<PutInboundAttachmentResult> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const ttlMs = Math.trunc(opts.ttlMs);
		if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
			throw new Error(`ttlMs must be a positive integer, got ${opts.ttlMs}`);
		}
		const sourceFileId = opts.sourceFileId?.trim() || null;
		const contentHash = sha256Hex(opts.bytes);

		let dedupeHit: InboundAttachmentStoreRecord | null = null;
		let dedupeKind: PutInboundAttachmentResult["dedupe_kind"] = "none";
		if (sourceFileId) {
			for (const existing of this.#records.values()) {
				if (existing.channel === opts.channel && existing.source === opts.source && existing.source_file_id === sourceFileId) {
					dedupeHit = existing;
					dedupeKind = "source_file_id";
					break;
				}
			}
		}
		if (!dedupeHit) {
			for (const existing of this.#records.values()) {
				if (existing.content_hash_sha256 === contentHash) {
					dedupeHit = existing;
					dedupeKind = "content_hash";
					break;
				}
			}
		}

		const safeFilename = sanitizeFilename(opts.filename);
		const expiresAtMs = nowMs + ttlMs;
		const record = InboundAttachmentStoreRecordSchema.parse(
			dedupeHit
				? {
						...dedupeHit,
						last_seen_at_ms: nowMs,
						expires_at_ms: Math.max(dedupeHit.expires_at_ms, expiresAtMs),
						source_file_id: sourceFileId,
						mime_type: opts.mimeType ?? dedupeHit.mime_type,
						original_filename: opts.filename ?? dedupeHit.original_filename,
						safe_filename: safeFilename,
						metadata: { ...dedupeHit.metadata, ...(opts.metadata ?? {}) },
				  }
				: {
						attachment_id: attachmentIdFor({
							channel: opts.channel,
							source: opts.source,
							sourceFileId,
							contentHash,
						}),
						channel: opts.channel,
						source: opts.source,
						source_file_id: sourceFileId,
						content_hash_sha256: contentHash,
						mime_type: opts.mimeType ?? null,
						original_filename: opts.filename ?? null,
						safe_filename: safeFilename,
						size_bytes: opts.bytes.byteLength,
						blob_relpath: normalizeRelpath(join("sha256", contentHash.slice(0, 2), contentHash.slice(2, 4), `${contentHash}${extname(safeFilename)}`)),
						created_at_ms: nowMs,
						last_seen_at_ms: nowMs,
						expires_at_ms: expiresAtMs,
						metadata: opts.metadata ?? {},
				  },
		);

		if (!dedupeHit) {
			const blobPath = join(this.#blobRootDir, record.blob_relpath);
			await mkdir(dirname(blobPath), { recursive: true });
			try {
				await stat(blobPath);
			} catch {
				await writeFile(blobPath, opts.bytes);
			}
		}

		await appendJsonl(this.#indexPath, {
			kind: "upsert",
			ts_ms: nowMs,
			record,
			dedupe_kind: dedupeKind,
		} satisfies InboundAttachmentStoreEntry);
		this.#records.set(record.attachment_id, record);
		return { record: { ...record, metadata: { ...record.metadata } }, dedupe_kind: dedupeKind };
	}

	public snapshot(): InboundAttachmentStoreRecord[] {
		return [...this.#records.values()]
			.map((record) => ({ ...record, metadata: { ...record.metadata } }))
			.sort((a, b) => a.created_at_ms - b.created_at_ms || a.attachment_id.localeCompare(b.attachment_id));
	}

	public async cleanupExpired(opts: { nowMs?: number; batchLimit: number }): Promise<InboundAttachmentCleanupResult> {
		await this.#ensureLoaded();
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const batchLimit = Math.trunc(opts.batchLimit);
		if (!Number.isInteger(batchLimit) || batchLimit <= 0) {
			throw new Error(`batchLimit must be a positive integer, got ${opts.batchLimit}`);
		}
		const expired = [...this.#records.values()]
			.filter((record) => record.expires_at_ms <= nowMs)
			.sort((a, b) => a.expires_at_ms - b.expires_at_ms)
			.slice(0, batchLimit);
		const expiredIds: string[] = [];
		let removedBlobCount = 0;
		for (const record of expired) {
			await appendJsonl(this.#indexPath, {
				kind: "expire",
				ts_ms: nowMs,
				attachment_id: record.attachment_id,
				reason: "ttl",
			} satisfies InboundAttachmentStoreEntry);
			this.#records.delete(record.attachment_id);
			expiredIds.push(record.attachment_id);
			const stillReferenced = [...this.#records.values()].some((active) => active.blob_relpath === record.blob_relpath);
			if (!stillReferenced) {
				const blobPath = join(this.#blobRootDir, record.blob_relpath);
				await rm(blobPath, { force: true });
				removedBlobCount += 1;
			}
		}
		return {
			expired_count: expired.length,
			removed_blob_count: removedBlobCount,
			expired_attachment_ids: expiredIds,
		};
	}

	public async readBlob(record: InboundAttachmentStoreRecord): Promise<Uint8Array> {
		await this.#ensureLoaded();
		return await readFile(join(this.#blobRootDir, record.blob_relpath));
	}
}

export function buildInboundAttachmentStorePaths(controlPlaneDir: string): { indexPath: string; blobRootDir: string } {
	const attachmentDir = join(controlPlaneDir, "attachments");
	return {
		indexPath: join(attachmentDir, "index.jsonl"),
		blobRootDir: join(attachmentDir, "blobs"),
	};
}

export function toInboundAttachmentReference(record: InboundAttachmentStoreRecord): { source: string; file_id: string } {
	return {
		source: `mu-attachment:${record.channel}`,
		file_id: record.attachment_id,
	};
}
