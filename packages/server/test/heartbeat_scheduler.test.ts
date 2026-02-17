import { describe, expect, test } from "bun:test";
import { ActivityHeartbeatScheduler } from "../src/heartbeat_scheduler.js";

async function waitFor<T>(fn: () => T, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 1_000;
	const intervalMs = opts.intervalMs ?? 10;
	const startedAt = Date.now();
	while (true) {
		const value = fn();
		if (value) {
			return value;
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("timeout waiting for condition");
		}
		await Bun.sleep(intervalMs);
	}
}

describe("ActivityHeartbeatScheduler", () => {
	test("coalesces pending wake reasons and prefers higher-priority requests", async () => {
		const reasons: string[] = [];
		const scheduler = new ActivityHeartbeatScheduler({
			minIntervalMs: 1,
		});

		scheduler.register({
			activityId: "activity-1",
			everyMs: 10_000,
			coalesceMs: 40,
			handler: async ({ reason }) => {
				reasons.push(reason ?? "(none)");
				return { status: "ran" } as const;
			},
		});

		scheduler.requestNow("activity-1", { reason: "interval", coalesceMs: 40 });
		scheduler.requestNow("activity-1", { reason: "manual", coalesceMs: 40 });

		await waitFor(() => (reasons.length >= 1 ? true : null));
		expect(reasons).toEqual(["manual"]);

		scheduler.stop();
	});

	test("keeps newest reason when action-priority wakes coalesce", async () => {
		const reasons: string[] = [];
		const scheduler = new ActivityHeartbeatScheduler({
			minIntervalMs: 1,
		});

		scheduler.register({
			activityId: "activity-priority",
			everyMs: 10_000,
			coalesceMs: 35,
			handler: async ({ reason }) => {
				reasons.push(reason ?? "(none)");
				return { status: "ran" } as const;
			},
		});

		scheduler.requestNow("activity-priority", { reason: "manual", coalesceMs: 35 });
		scheduler.requestNow("activity-priority", { reason: "hook:post-commit", coalesceMs: 35 });
		scheduler.requestNow("activity-priority", { reason: "interval", coalesceMs: 35 });

		await waitFor(() => (reasons.length >= 1 ? true : null));
		expect(reasons).toEqual(["hook:post-commit"]);

		scheduler.stop();
	});

	test("retries failed heartbeat handlers", async () => {
		let calls = 0;
		const scheduler = new ActivityHeartbeatScheduler({
			minIntervalMs: 1,
			retryMs: 40,
		});

		scheduler.register({
			activityId: "activity-2",
			everyMs: 10_000,
			handler: async () => {
				calls += 1;
				if (calls === 1) {
					return { status: "failed", reason: "simulated_failure" } as const;
				}
				return { status: "ran" } as const;
			},
		});

		scheduler.requestNow("activity-2", { reason: "manual", coalesceMs: 0 });
		await waitFor(() => (calls >= 2 ? true : null), { timeoutMs: 2_000 });
		expect(calls).toBe(2);

		scheduler.stop();
	});

	test("preserves retry backoff when new wake requests arrive during cooldown", async () => {
		const callTimes: number[] = [];
		let first = true;
		const scheduler = new ActivityHeartbeatScheduler({
			minIntervalMs: 1,
			retryMs: 150,
		});

		scheduler.register({
			activityId: "activity-retry-floor",
			everyMs: 10_000,
			handler: async () => {
				callTimes.push(Date.now());
				if (first) {
					first = false;
					return { status: "failed", reason: "boom" } as const;
				}
				return { status: "ran" } as const;
			},
		});

		scheduler.requestNow("activity-retry-floor", { reason: "manual", coalesceMs: 0 });
		await waitFor(() => (callTimes.length >= 1 ? true : null));

		// This immediate request should be queued but must not preempt retry cooldown.
		scheduler.requestNow("activity-retry-floor", { reason: "manual", coalesceMs: 0 });

		await Bun.sleep(70);
		expect(callTimes).toHaveLength(1);

		await waitFor(() => (callTimes.length >= 2 ? true : null), { timeoutMs: 2_000 });
		expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(110);

		scheduler.stop();
	});

	test("ignores stale wake callbacks from replaced registrations", async () => {
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 1 });
		const reasons: string[] = [];
		const originalClearTimeout = globalThis.clearTimeout;
		const mutableGlobal = globalThis as typeof globalThis & {
			clearTimeout: typeof clearTimeout;
		};

		try {
			// Simulate a runtime race where clearTimeout cannot cancel an already-queued callback.
			mutableGlobal.clearTimeout = (() => undefined) as typeof clearTimeout;

			scheduler.register({
				activityId: "activity-stale",
				everyMs: 10_000,
				coalesceMs: 30,
				handler: async ({ reason }) => {
					reasons.push(reason ?? "(none)");
					return { status: "ran" } as const;
				},
			});

			scheduler.requestNow("activity-stale", { reason: "manual", coalesceMs: 30 });
			await Bun.sleep(5);

			scheduler.register({
				activityId: "activity-stale",
				everyMs: 10_000,
				handler: async ({ reason }) => {
					reasons.push(`new:${reason ?? "(none)"}`);
					return { status: "ran" } as const;
				},
			});
		} finally {
			mutableGlobal.clearTimeout = originalClearTimeout;
		}

		await Bun.sleep(90);
		expect(reasons).toEqual([]);

		scheduler.stop();
	});

	test("unregister removes activity and rejects future wake requests", async () => {
		let calls = 0;
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 1 });
		scheduler.register({
			activityId: "activity-3",
			everyMs: 10_000,
			handler: async () => {
				calls += 1;
				return { status: "ran" } as const;
			},
		});

		expect(scheduler.requestNow("activity-3", { reason: "manual", coalesceMs: 0 })).toBe(true);
		await waitFor(() => (calls >= 1 ? true : null));

		expect(scheduler.unregister("activity-3")).toBe(true);
		expect(scheduler.requestNow("activity-3", { reason: "manual", coalesceMs: 0 })).toBe(false);
		await Bun.sleep(80);
		expect(calls).toBe(1);

		scheduler.stop();
	});

	test("supports event-driven registrations with everyMs <= 0", async () => {
		let calls = 0;
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 1 });
		scheduler.register({
			activityId: "activity-on-demand",
			everyMs: 0,
			handler: async () => {
				calls += 1;
				return { status: "ran" } as const;
			},
		});

		expect(scheduler.requestNow("activity-on-demand", { reason: "manual", coalesceMs: 0 })).toBe(true);
		await waitFor(() => (calls >= 1 ? true : null));
		await Bun.sleep(80);
		expect(calls).toBe(1);

		scheduler.stop();
	});

	test("cleanup is idempotent while an in-flight heartbeat settles", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = () => resolve();
		});

		const scheduler = new ActivityHeartbeatScheduler({
			minIntervalMs: 1,
			retryMs: 40,
		});
		scheduler.register({
			activityId: "activity-cleanup",
			everyMs: 10_000,
			handler: async () => {
				calls += 1;
				if (calls === 1) {
					await gate;
					return { status: "failed", reason: "late_failure" } as const;
				}
				return { status: "ran" } as const;
			},
		});

		scheduler.requestNow("activity-cleanup", { reason: "manual", coalesceMs: 0 });
		await waitFor(() => (calls >= 1 ? true : null));

		expect(scheduler.unregister("activity-cleanup")).toBe(true);
		expect(scheduler.unregister("activity-cleanup")).toBe(false);
		scheduler.stop();
		scheduler.stop();

		release?.();
		await Bun.sleep(100);
		expect(calls).toBe(1);
	});
});
