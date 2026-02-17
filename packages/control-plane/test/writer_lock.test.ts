import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriterLock, WriterLockBusyError } from "@femtomc/mu-control-plane";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-lock-"));
}

describe("WriterLock", () => {
	test("prevents split-brain writer acquisition", async () => {
		const dir = await mkTempDir();
		const lockPath = join(dir, ".mu", "control-plane", "writer.lock");

		const lockA = await WriterLock.acquire(lockPath, {
			repoRoot: dir,
			ownerId: "writer-a",
			nowMs: 10,
		});

		await expect(
			WriterLock.acquire(lockPath, {
				repoRoot: dir,
				ownerId: "writer-b",
				nowMs: 11,
			}),
		).rejects.toThrow(WriterLockBusyError);

		await expect(
			WriterLock.acquire(lockPath, {
				repoRoot: dir,
				ownerId: "writer-b",
				nowMs: 11,
			}),
		).rejects.toMatchObject({
			existing: {
				owner_id: "writer-a",
				repo_root: dir,
				acquired_at_ms: 10,
			},
		});

		await lockA.release();

		const lockB = await WriterLock.acquire(lockPath, {
			repoRoot: dir,
			ownerId: "writer-b",
			nowMs: 12,
		});
		expect(lockB.metadata.owner_id).toBe("writer-b");
		await lockB.release();
	});
});
