import { describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundAttachmentStore } from "@femtomc/mu-control-plane";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-attachments-"));
}

describe("InboundAttachmentStore", () => {
	test("normalizes unsafe filenames and writes deterministic sha256 blob layout", async () => {
		const dir = await mkTempDir();
		const store = new InboundAttachmentStore({
			indexPath: join(dir, ".mu", "control-plane", "attachments", "index.jsonl"),
			blobRootDir: join(dir, ".mu", "control-plane", "attachments", "blobs"),
		});
		await store.load();

		const inserted = await store.put({
			channel: "telegram",
			source: "telegram",
			sourceFileId: "file-1",
			filename: "../../etc/passwd\u0000.pdf",
			mimeType: "application/pdf",
			bytes: new TextEncoder().encode("payload-a"),
			ttlMs: 24 * 60 * 60 * 1000,
			nowMs: 100,
		});

		expect(inserted.record.safe_filename.includes("/")).toBe(false);
		expect(inserted.record.safe_filename.includes("\\")).toBe(false);
		expect(inserted.record.blob_relpath.startsWith("sha256/")).toBe(true);
		await expect(stat(join(dir, ".mu", "control-plane", "attachments", "blobs", inserted.record.blob_relpath))).resolves.toBeTruthy();
	});

	test("dedupes by source_file_id first, then content hash", async () => {
		const dir = await mkTempDir();
		const store = new InboundAttachmentStore({
			indexPath: join(dir, ".mu", "control-plane", "attachments", "index.jsonl"),
			blobRootDir: join(dir, ".mu", "control-plane", "attachments", "blobs"),
		});
		await store.load();

		const first = await store.put({
			channel: "slack",
			source: "slack",
			sourceFileId: "F-123",
			filename: "report.pdf",
			mimeType: "application/pdf",
			bytes: new TextEncoder().encode("same-blob"),
			ttlMs: 1_000,
			nowMs: 100,
		});
		expect(first.dedupe_kind).toBe("none");

		const sameSource = await store.put({
			channel: "slack",
			source: "slack",
			sourceFileId: "F-123",
			filename: "report-v2.pdf",
			mimeType: "application/pdf",
			bytes: new TextEncoder().encode("different-content"),
			ttlMs: 2_000,
			nowMs: 200,
		});
		expect(sameSource.dedupe_kind).toBe("source_file_id");
		expect(sameSource.record.attachment_id).toBe(first.record.attachment_id);

		const sameHash = await store.put({
			channel: "telegram",
			source: "telegram",
			sourceFileId: "tg-9",
			filename: "copy.pdf",
			mimeType: "application/pdf",
			bytes: new TextEncoder().encode("same-blob"),
			ttlMs: 2_000,
			nowMs: 300,
		});
		expect(sameHash.dedupe_kind).toBe("content_hash");
		expect(sameHash.record.attachment_id).toBe(first.record.attachment_id);
	});

	test("cleanupExpired removes ttl-expired metadata and blobs", async () => {
		const dir = await mkTempDir();
		const store = new InboundAttachmentStore({
			indexPath: join(dir, ".mu", "control-plane", "attachments", "index.jsonl"),
			blobRootDir: join(dir, ".mu", "control-plane", "attachments", "blobs"),
		});
		await store.load();

		const inserted = await store.put({
			channel: "telegram",
			source: "telegram",
			sourceFileId: "file-cleanup",
			filename: "cleanup.pdf",
			mimeType: "application/pdf",
			bytes: new TextEncoder().encode("cleanup"),
			ttlMs: 50,
			nowMs: 100,
		});

		const cleanup = await store.cleanupExpired({ nowMs: 151, batchLimit: 100 });
		expect(cleanup.expired_count).toBe(1);
		expect(cleanup.removed_blob_count).toBe(1);
		expect(cleanup.expired_attachment_ids).toEqual([inserted.record.attachment_id]);
		expect(store.snapshot()).toHaveLength(0);
		await expect(stat(join(dir, ".mu", "control-plane", "attachments", "blobs", inserted.record.blob_relpath))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
