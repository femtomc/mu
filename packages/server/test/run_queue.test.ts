import { describe, expect, test } from "bun:test";
import { InMemoryJsonlStore } from "@femtomc/mu-core";
import { DurableRunQueue, runSnapshotFromQueueSnapshot } from "../src/run_queue.js";

describe("DurableRunQueue", () => {
	test("enforces valid transitions and rejects invalid transitions", async () => {
		const store = new InMemoryJsonlStore<unknown>([]);
		const queue = new DurableRunQueue({ repoRoot: "/repo", store, nowMs: () => 1_000 });

		const queued = await queue.enqueue({
			mode: "run_resume",
			prompt: null,
			rootIssueId: "mu-root-transition",
			source: "api",
			dedupeKey: "transition-seq",
		});
		expect(queued.state).toBe("queued");

		const active = await queue.claim({ queueId: queued.queue_id, operationId: "claim-1" });
		expect(active?.state).toBe("active");

		const waitingReview = await queue.transition({
			queueId: queued.queue_id,
			toState: "waiting_review",
			operationId: "review-1",
		});
		expect(waitingReview.state).toBe("waiting_review");

		const refining = await queue.transition({
			queueId: queued.queue_id,
			toState: "refining",
			operationId: "refine-1",
		});
		expect(refining.state).toBe("refining");

		const requeued = await queue.transition({
			queueId: queued.queue_id,
			toState: "queued",
			operationId: "requeue-1",
		});
		expect(requeued.state).toBe("queued");

		await queue.claim({ queueId: queued.queue_id, operationId: "claim-2" });
		const done = await queue.transition({ queueId: queued.queue_id, toState: "done", operationId: "done-1" });
		expect(done.state).toBe("done");

		await expect(queue.transition({ queueId: queued.queue_id, toState: "queued" })).rejects.toThrow(
			"invalid_run_queue_transition",
		);

		const second = await queue.enqueue({
			mode: "run_start",
			prompt: "hello",
			rootIssueId: null,
			source: "api",
			dedupeKey: "transition-invalid",
		});
		await expect(queue.transition({ queueId: second.queue_id, toState: "done" })).rejects.toThrow(
			"invalid_run_queue_transition",
		);
	});

	test("enqueue/claim/transition operations are idempotent", async () => {
		const store = new InMemoryJsonlStore<unknown>([]);
		const queue = new DurableRunQueue({ repoRoot: "/repo", store, nowMs: () => 2_000 });

		const first = await queue.enqueue({
			mode: "run_resume",
			prompt: null,
			rootIssueId: "mu-root-idempotent",
			source: "command",
			commandId: "cmd-1",
			dedupeKey: "dedupe:idempotent",
			operationId: "enqueue-op",
		});
		const replayedEnqueue = await queue.enqueue({
			mode: "run_resume",
			prompt: null,
			rootIssueId: "mu-root-idempotent",
			source: "command",
			commandId: "cmd-1",
			dedupeKey: "dedupe:idempotent",
			operationId: "enqueue-op",
		});
		expect(replayedEnqueue.queue_id).toBe(first.queue_id);
		expect((await store.read()).length).toBe(1);

		const claimed = await queue.claim({ queueId: first.queue_id, operationId: "claim-op" });
		expect(claimed?.state).toBe("active");
		const replayedClaim = await queue.claim({ queueId: first.queue_id, operationId: "claim-op" });
		expect(replayedClaim?.revision).toBe(claimed?.revision);

		const failed = await queue.transition({
			queueId: first.queue_id,
			toState: "failed",
			operationId: "fail-op",
		});
		const replayedFailed = await queue.transition({
			queueId: first.queue_id,
			toState: "failed",
			operationId: "fail-op",
		});
		expect(replayedFailed.revision).toBe(failed.revision);
	});

	test("state persists across reload and replay-safe operation ids survive reload", async () => {
		const store = new InMemoryJsonlStore<unknown>([]);
		const queueA = new DurableRunQueue({ repoRoot: "/repo", store, nowMs: () => 3_000 });

		const queued = await queueA.enqueue({
			mode: "run_resume",
			prompt: null,
			rootIssueId: "mu-root-persist",
			source: "api",
			dedupeKey: "persist:1",
		});
		await queueA.claim({ queueId: queued.queue_id, operationId: "persist-claim" });
		const failed = await queueA.transition({
			queueId: queued.queue_id,
			toState: "failed",
			operationId: "persist-fail",
		});
		expect(failed.state).toBe("failed");

		const queueB = new DurableRunQueue({ repoRoot: "/repo", store, nowMs: () => 4_000 });
		const loaded = await queueB.get(queued.queue_id);
		expect(loaded).not.toBeNull();
		if (!loaded) {
			throw new Error("expected persisted queue row");
		}
		expect(loaded.state).toBe("failed");
		expect(loaded.applied_operation_ids).toContain("persist-fail");

		const replayed = await queueB.transition({
			queueId: queued.queue_id,
			toState: "failed",
			operationId: "persist-fail",
		});
		expect(replayed.revision).toBe(loaded.revision);
	});

	test("legacy run snapshots are migrated/readable through queue adapter", async () => {
		const now = Date.now();
		const legacyRunSnapshot = {
			job_id: "run-job-legacy",
			mode: "run_resume",
			status: "completed",
			prompt: null,
			root_issue_id: "mu-root-legacy",
			max_steps: 17,
			command_id: "cmd-legacy",
			source: "api",
			started_at_ms: now - 50,
			updated_at_ms: now,
			finished_at_ms: now,
			exit_code: 0,
			pid: 123,
			last_progress: "Done 1/1",
		};
		const store = new InMemoryJsonlStore<unknown>([legacyRunSnapshot]);
		const queue = new DurableRunQueue({ repoRoot: "/repo", store, nowMs: () => now + 1 });

		const migrated = await queue.get("run-job-legacy");
		expect(migrated).not.toBeNull();
		if (!migrated) {
			throw new Error("expected migrated legacy run");
		}
		expect(migrated.queue_id).toBe("legacy-run-job-legacy");
		expect(migrated.state).toBe("done");

		const mappedRun = runSnapshotFromQueueSnapshot(migrated);
		expect(mappedRun.job_id).toBe("run-job-legacy");
		expect(mappedRun.status).toBe("completed");
		expect(mappedRun.root_issue_id).toBe("mu-root-legacy");

		const byRoot = await queue.get("mu-root-legacy");
		expect(byRoot?.queue_id).toBe(migrated.queue_id);

		const persistedRows = await store.read();
		const persisted = persistedRows[0] as Record<string, unknown>;
		expect(typeof persisted.queue_id).toBe("string");
		expect(persisted.state).toBe("done");
		expect(persisted.status).toBeUndefined();
	});
});
