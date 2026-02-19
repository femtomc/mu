import { describe, expect, test } from "bun:test";
import type { InterRootQueuePolicy } from "../src/control_plane_contract.js";
import { reconcileRunQueue, type DurableRunQueueSnapshot } from "../src/run_queue.js";

function mkRow(queueId: string, overrides: Partial<DurableRunQueueSnapshot> = {}): DurableRunQueueSnapshot {
	return {
		v: 1,
		queue_id: queueId,
		dedupe_key: `dedupe:${queueId}`,
		mode: "run_resume",
		state: "queued",
		prompt: null,
		root_issue_id: `mu-${queueId}`,
		max_steps: 20,
		command_id: null,
		source: "api",
		job_id: null,
		started_at_ms: null,
		updated_at_ms: 1,
		finished_at_ms: null,
		exit_code: null,
		pid: null,
		last_progress: null,
		created_at_ms: 1,
		revision: 1,
		applied_operation_ids: [],
		...overrides,
	};
}

describe("reconcileRunQueue", () => {
	test("is deterministic/idempotent for unchanged snapshots", () => {
		const policy: InterRootQueuePolicy = { mode: "sequential", max_active_roots: 1 };
		const q1 = mkRow("q1", { created_at_ms: 10, updated_at_ms: 10, root_issue_id: "mu-root-a" });
		const q2 = mkRow("q2", { created_at_ms: 20, updated_at_ms: 20, root_issue_id: "mu-root-b" });

		const first = reconcileRunQueue([q2, q1], policy);
		const second = reconcileRunQueue([q2, q1], policy);

		expect(first).toEqual(second);
		expect(first.activate_queue_ids).toEqual([q1.queue_id]);
		expect(first.launch_queue_ids).toEqual([]);
	});

	test("sequential policy blocks new activation while one root is active", () => {
		const policy: InterRootQueuePolicy = { mode: "sequential", max_active_roots: 1 };
		const active = mkRow("q1", {
			state: "active",
			root_issue_id: "mu-root-a",
			created_at_ms: 10,
			updated_at_ms: 10,
			job_id: null,
		});
		const queued = mkRow("q2", {
			state: "queued",
			root_issue_id: "mu-root-b",
			created_at_ms: 20,
			updated_at_ms: 20,
		});

		const plan = reconcileRunQueue([active, queued], policy);
		expect(plan.activate_queue_ids).toEqual([]);
		expect(plan.launch_queue_ids).toEqual([active.queue_id]);
	});

	test("parallel policy fanout controls activation order and concurrency", () => {
		const policy: InterRootQueuePolicy = { mode: "parallel", max_active_roots: 2 };
		const q1 = mkRow("q1", { root_issue_id: "mu-root-a", created_at_ms: 10, updated_at_ms: 10 });
		const q2 = mkRow("q2", { root_issue_id: "mu-root-b", created_at_ms: 20, updated_at_ms: 20 });
		const q3 = mkRow("q3", { root_issue_id: "mu-root-c", created_at_ms: 30, updated_at_ms: 30 });

		const p0 = reconcileRunQueue([q3, q1, q2], policy);
		expect(p0.activate_queue_ids).toEqual([q1.queue_id, q2.queue_id]);

		const p1 = reconcileRunQueue(
			[{ ...q1, state: "active", job_id: "run-1" }, { ...q2, state: "active", job_id: "run-2" }, q3],
			policy,
		);
		expect(p1.activate_queue_ids).toEqual([]);

		const p2 = reconcileRunQueue(
			[{ ...q1, state: "done", job_id: "run-1" }, { ...q2, state: "active", job_id: "run-2" }, q3],
			policy,
		);
		expect(p2.activate_queue_ids).toEqual([q3.queue_id]);
	});
});
