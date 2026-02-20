import { describe, expect, test } from "bun:test";
import { InMemoryJsonlStore } from "@femtomc/mu-core";
import { CronProgramRegistry, type CronProgramSnapshot } from "../src/cron_programs.js";
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

describe("CronProgramRegistry", () => {
	test("runs one-shot at schedules and disables after completion", async () => {
		const store = new InMemoryJsonlStore<CronProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 1, retryMs: 30 });
		let calls = 0;
		const registry = new CronProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async () => {
				calls += 1;
				return { status: "ok" };
			},
		});

		const atMs = Date.now() + 60;
		const program = await registry.create({
			title: "One-shot wake",
			schedule: {
				kind: "at",
				at_ms: atMs,
			},
		});

		await waitFor(() => (calls >= 1 ? true : null));
		const refreshed = await registry.get(program.program_id);
		expect(refreshed?.enabled).toBe(false);
		expect(refreshed?.next_run_at_ms).toBeNull();
		expect(refreshed?.last_result).toBe("ok");

		registry.stop();
		scheduler.stop();
	});

	test("coalesced manual trigger records coalesced result", async () => {
		const store = new InMemoryJsonlStore<CronProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 1, retryMs: 30 });
		const registry = new CronProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async () => ({ status: "coalesced", reason: "coalesced" }),
		});

		const program = await registry.create({
			title: "Coalesced wake",
			schedule: { kind: "at", at_ms: Date.now() + 60_000 },
		});

		const trigger = await registry.trigger({ programId: program.program_id, reason: "manual" });
		expect(trigger.ok).toBe(true);
		const refreshed = await registry.get(program.program_id);
		expect(refreshed?.last_result).toBe("coalesced");

		registry.stop();
		scheduler.stop();
	});

	test("loads persisted recurring schedules and re-arms on startup", async () => {
		const now = Date.now();
		const store = new InMemoryJsonlStore<CronProgramSnapshot>([
			{
				v: 1,
				program_id: "cron-preloaded-1",
				title: "Preloaded recurring",
				enabled: true,
				schedule: {
					kind: "every",
					every_ms: 40,
					anchor_ms: now,
				},
				reason: "scheduled",
				metadata: {},
				created_at_ms: now,
				updated_at_ms: now,
				next_run_at_ms: null,
				last_triggered_at_ms: null,
				last_result: null,
				last_error: null,
			},
		]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 1, retryMs: 30 });
		let ticks = 0;
		const registry = new CronProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async () => {
				ticks += 1;
				return { status: "ok" };
			},
		});

		await waitFor(() => (ticks >= 1 ? true : null));
		const loaded = await registry.get("cron-preloaded-1");
		expect(loaded).not.toBeNull();
		expect(loaded?.last_triggered_at_ms).not.toBeNull();
		expect(loaded?.last_result).toBe("ok");

		registry.stop();
		scheduler.stop();
	});
});
