import { describe, expect, test } from "bun:test";
import { ControlPlaneActivitySupervisor } from "../src/activity_supervisor.js";
import { ActivityHeartbeatScheduler } from "../src/heartbeat_scheduler.js";

async function waitFor<T>(fn: () => T, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 2_000;
	const intervalMs = opts.intervalMs ?? 20;
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

describe("ControlPlaneActivitySupervisor", () => {
	test("start/progress/complete lifecycle works", () => {
		const supervisor = new ControlPlaneActivitySupervisor({ defaultHeartbeatEveryMs: 0 });
		const started = supervisor.start({ title: "Index repository", kind: "indexer" });
		expect(started.status).toBe("running");
		expect(started.kind).toBe("indexer");

		const progress = supervisor.progress({
			activityId: started.activity_id,
			message: "Indexed 10/20 files",
		});
		expect(progress.ok).toBe(true);
		expect(progress.activity?.last_progress).toBe("Indexed 10/20 files");

		const completed = supervisor.complete({
			activityId: started.activity_id,
			message: "Done",
		});
		expect(completed.ok).toBe(true);
		expect(completed.activity?.status).toBe("completed");
		expect(completed.activity?.final_message).toBe("Done");

		supervisor.stop();
	});

	test("manual heartbeat emits heartbeat event even without periodic interval", async () => {
		const kinds: string[] = [];
		const supervisor = new ControlPlaneActivitySupervisor({
			defaultHeartbeatEveryMs: 0,
			onEvent: (event) => {
				kinds.push(event.kind);
			},
		});
		const started = supervisor.start({ title: "Sync tasks", kind: "sync", heartbeatEveryMs: 0 });
		const heartbeat = supervisor.heartbeat({ activityId: started.activity_id, reason: "manual" });
		expect(heartbeat.ok).toBe(true);
		await waitFor(() => (kinds.includes("activity_heartbeat") ? true : null));

		supervisor.stop();
	});

	test("periodic heartbeat ticks while activity is running", async () => {
		const heartbeats: number[] = [];
		const heartbeatScheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		const supervisor = new ControlPlaneActivitySupervisor({
			heartbeatScheduler,
			onEvent: (event) => {
				if (event.kind === "activity_heartbeat") {
					heartbeats.push(event.seq);
				}
			},
		});
		const started = supervisor.start({ title: "Watch queue", heartbeatEveryMs: 60 });
		await waitFor(() => (heartbeats.length >= 1 ? true : null));

		const cancelled = supervisor.cancel({ activityId: started.activity_id });
		expect(cancelled.ok).toBe(true);
		expect(cancelled.activity?.status).toBe("cancelled");

		supervisor.stop();
		heartbeatScheduler.stop();
	});
});
