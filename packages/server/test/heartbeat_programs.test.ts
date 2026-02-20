import { describe, expect, test } from "bun:test";
import { InMemoryJsonlStore } from "@femtomc/mu-core";
import { HeartbeatProgramRegistry, type HeartbeatProgramSnapshot } from "../src/heartbeat_programs.js";
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

describe("HeartbeatProgramRegistry", () => {
	test("creates, triggers, and persists wake heartbeat programs", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		const wakeCalls: Array<{ programId: string; reason: string; prompt: string | null }> = [];
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async (opts) => {
				wakeCalls.push({ programId: opts.programId, reason: opts.reason, prompt: opts.prompt });
				return { status: "ok" };
			},
		});

		const program = await registry.create({
			title: "Wake pulse",
			prompt: "Investigate stalled work and recover",
			everyMs: 0,
			reason: "scheduled",
		});
		expect(program.title).toBe("Wake pulse");
		expect(program.prompt).toBe("Investigate stalled work and recover");

		const trigger = await registry.trigger({ programId: program.program_id, reason: "manual" });
		expect(trigger.ok).toBe(true);
		expect(wakeCalls.length).toBe(1);
		expect(wakeCalls[0]?.programId).toBe(program.program_id);
		expect(wakeCalls[0]?.reason).toBe("manual");
		expect(wakeCalls[0]?.prompt).toBe("Investigate stalled work and recover");

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
			dispatchWake: async () => {
				ticks += 1;
				return { status: "ok" };
			},
		});

		await registry.create({
			title: "Wake pulse",
			everyMs: 40,
			reason: "scheduled",
		});

		await waitFor(() => (ticks >= 1 ? true : null));

		registry.stop();
		scheduler.stop();
	});

	test("coalesced wake dispatch persists coalesced status", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async () => ({ status: "coalesced", reason: "coalesced" }),
		});

		const program = await registry.create({
			title: "Coalesced pulse",
			everyMs: 0,
		});

		const result = await registry.trigger({ programId: program.program_id, reason: "manual" });
		expect(result.ok).toBe(true);
		const refreshed = await registry.get(program.program_id);
		expect(refreshed?.last_result).toBe("coalesced");

		registry.stop();
		scheduler.stop();
	});

	test("registry loads persisted programs from .mu store and schedules them", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([
			{
				v: 1,
				program_id: "hb-preloaded-1",
				title: "Preloaded wake pulse",
				prompt: null,
				enabled: true,
				every_ms: 40,
				reason: "scheduled",
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
			dispatchWake: async () => {
				ticks += 1;
				return { status: "ok" };
			},
		});

		const loaded = await registry.list({ limit: 10 });
		expect(loaded.length).toBe(1);
		expect(loaded[0]?.program_id).toBe("hb-preloaded-1");
		await waitFor(() => (ticks >= 1 ? true : null));

		registry.stop();
		scheduler.stop();
	});
});
