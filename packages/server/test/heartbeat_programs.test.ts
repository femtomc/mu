import { describe, expect, test } from "bun:test";
import { InMemoryJsonlStore } from "@femtomc/mu-core";
import { ActivityHeartbeatScheduler } from "../src/heartbeat_scheduler.js";
import { HeartbeatProgramRegistry, type HeartbeatProgramSnapshot } from "../src/heartbeat_programs.js";

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

describe("HeartbeatProgramRegistry", () => {
	test("creates, triggers, and persists heartbeat programs", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		const activityHeartbeatCalls: Array<{ activityId?: string | null; reason?: string | null }> = [];
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			runHeartbeat: async () => ({ ok: false, reason: "not_found" }),
			activityHeartbeat: async (opts) => {
				activityHeartbeatCalls.push(opts);
				return { ok: true, reason: null };
			},
		});

		const program = await registry.create({
			title: "Pulse activity",
			target: {
				kind: "activity",
				activity_id: "activity-1",
			},
			everyMs: 0,
			reason: "scheduled",
		});
		expect(program.title).toBe("Pulse activity");

		const trigger = await registry.trigger({ programId: program.program_id, reason: "manual" });
		expect(trigger.ok).toBe(true);
		expect(activityHeartbeatCalls.length).toBe(1);
		expect(activityHeartbeatCalls[0]?.activityId).toBe("activity-1");
		expect(activityHeartbeatCalls[0]?.reason).toBe("manual");

		const rows = await store.read();
		expect(rows.length).toBe(1);
		expect(rows[0]?.program_id).toBe(program.program_id);
		expect(rows[0]?.last_result).toBe("ok");

		registry.stop();
		scheduler.stop();
	});

	test("scheduled programs tick automatically while enabled", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		let ticks = 0;
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			runHeartbeat: async (opts) => {
				ticks += 1;
				expect(opts.rootIssueId).toBe("mu-root1234");
				return { ok: true, reason: null };
			},
			activityHeartbeat: async () => ({ ok: false, reason: "not_found" }),
		});

		await registry.create({
			title: "Run pulse",
			target: {
				kind: "run",
				job_id: null,
				root_issue_id: "mu-root1234",
			},
			everyMs: 40,
			reason: "scheduled",
		});

		await waitFor(() => (ticks >= 1 ? true : null));

		registry.stop();
		scheduler.stop();
	});

	test("registry loads persisted programs from .mu store and schedules them", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([
			{
				v: 1,
				program_id: "hb-preloaded-1",
				title: "Preloaded run pulse",
				enabled: true,
				every_ms: 40,
				reason: "scheduled",
				target: {
					kind: "run",
					job_id: null,
					root_issue_id: "mu-root-preloaded",
				},
				metadata: {},
				created_at_ms: Date.now(),
				updated_at_ms: Date.now(),
				last_triggered_at_ms: null,
				last_result: null,
				last_error: null,
			},
		]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		let ticks = 0;
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			runHeartbeat: async (opts) => {
				ticks += 1;
				expect(opts.rootIssueId).toBe("mu-root-preloaded");
				return { ok: true, reason: null };
			},
			activityHeartbeat: async () => ({ ok: false, reason: "not_found" }),
		});

		const loaded = await registry.list({ limit: 10 });
		expect(loaded.length).toBe(1);
		expect(loaded[0]?.program_id).toBe("hb-preloaded-1");
		await waitFor(() => (ticks >= 1 ? true : null));

		registry.stop();
		scheduler.stop();
	});
});
