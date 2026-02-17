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
});
