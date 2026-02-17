import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";

export const WriterLockMetadataSchema = z.object({
	owner_id: z.string().min(1),
	pid: z.number().int(),
	hostname: z.string().min(1),
	repo_root: z.string().min(1),
	acquired_at_ms: z.number().int(),
});
export type WriterLockMetadata = z.infer<typeof WriterLockMetadataSchema>;

async function readLockMetadata(lockPath: string): Promise<WriterLockMetadata | null> {
	try {
		const raw = await Bun.file(lockPath).text();
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			return null;
		}
		return WriterLockMetadataSchema.parse(JSON.parse(trimmed));
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return null;
		}
		return null;
	}
}

export class WriterLockBusyError extends Error {
	public readonly lockPath: string;
	public readonly existing: WriterLockMetadata | null;

	public constructor(lockPath: string, existing: WriterLockMetadata | null) {
		super(`writer lock is already held: ${lockPath}`);
		this.name = "WriterLockBusyError";
		this.lockPath = lockPath;
		this.existing = existing;
	}
}

export type AcquireWriterLockOpts = {
	ownerId?: string;
	repoRoot: string;
	nowMs?: number;
};

export class WriterLock {
	readonly #lockPath: string;
	readonly #handle: FileHandle;
	readonly #metadata: WriterLockMetadata;
	#released = false;

	private constructor(lockPath: string, handle: FileHandle, metadata: WriterLockMetadata) {
		this.#lockPath = lockPath;
		this.#handle = handle;
		this.#metadata = metadata;
	}

	public get path(): string {
		return this.#lockPath;
	}

	public get metadata(): WriterLockMetadata {
		return this.#metadata;
	}

	public static async acquire(lockPath: string, opts: AcquireWriterLockOpts): Promise<WriterLock> {
		await mkdir(dirname(lockPath), { recursive: true });
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const metadata = WriterLockMetadataSchema.parse({
			owner_id: opts.ownerId ?? `${hostname()}:${process.pid}`,
			pid: process.pid,
			hostname: hostname(),
			repo_root: opts.repoRoot,
			acquired_at_ms: nowMs,
		});

		let handle: FileHandle;
		try {
			handle = await open(lockPath, "wx", 0o600);
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === "EEXIST") {
				const existing = await readLockMetadata(lockPath);
				throw new WriterLockBusyError(lockPath, existing);
			}
			throw err;
		}

		try {
			await handle.writeFile(`${JSON.stringify(metadata)}\n`, { encoding: "utf8" });
		} catch (err) {
			await handle.close();
			await rm(lockPath, { force: true });
			throw err;
		}

		return new WriterLock(lockPath, handle, metadata);
	}

	public async release(): Promise<void> {
		if (this.#released) {
			return;
		}
		this.#released = true;
		try {
			await this.#handle.close();
		} finally {
			await rm(this.#lockPath, { force: true });
		}
	}
}
