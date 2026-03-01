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

	test("dispatches per-program model routing and context checkpoint fields", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		const wakeCalls: Array<{
			programId: string;
			operatorProvider: string | null;
			operatorModel: string | null;
			operatorThinking: string | null;
			contextSessionId: string | null;
			contextSessionFile: string | null;
			contextSessionDir: string | null;
		}> = [];
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async (opts) => {
				wakeCalls.push({
					programId: opts.programId,
					operatorProvider: opts.operatorProvider,
					operatorModel: opts.operatorModel,
					operatorThinking: opts.operatorThinking,
					contextSessionId: opts.contextSessionId,
					contextSessionFile: opts.contextSessionFile,
					contextSessionDir: opts.contextSessionDir,
				});
				return { status: "ok" };
			},
		});

		const program = await registry.create({
			title: "Model-routed wake pulse",
			everyMs: 0,
			operatorProvider: "openrouter",
			operatorModel: "google/gemini-3.1-pro-preview",
			operatorThinking: "high",
			contextSessionId: "checkpoint-1",
			contextSessionFile: "/tmp/operator-session.jsonl",
			contextSessionDir: "/tmp",
		});

		const trigger = await registry.trigger({ programId: program.program_id, reason: "manual" });
		expect(trigger.ok).toBe(true);
		expect(wakeCalls).toHaveLength(1);
		expect(wakeCalls[0]).toEqual({
			programId: program.program_id,
			operatorProvider: "openrouter",
			operatorModel: "google/gemini-3.1-pro-preview",
			operatorThinking: "high",
			contextSessionId: "checkpoint-1",
			contextSessionFile: "/tmp/operator-session.jsonl",
			contextSessionDir: "/tmp",
		});

		registry.stop();
		scheduler.stop();
	});

	test("coalesces concurrent trigger calls while wake dispatch is in flight", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		let wakeCalls = 0;
		let releaseWake!: () => void;
		const wakeBlocked = new Promise<void>((resolve) => {
			releaseWake = () => resolve();
		});
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async () => {
				wakeCalls += 1;
				await wakeBlocked;
				return { status: "ok" };
			},
		});

		const program = await registry.create({
			title: "Wake pulse",
			everyMs: 0,
			reason: "scheduled",
		});

		const trigger1 = registry.trigger({ programId: program.program_id, reason: "manual" });
		await waitFor(() => (wakeCalls === 1 ? true : null));

		const trigger2 = await Promise.race([
			registry.trigger({ programId: program.program_id, reason: "manual" }),
			Bun.sleep(100).then(() => null),
		]);
		if (!trigger2) {
			throw new Error("expected coalesced trigger to return without waiting for in-flight wake");
		}
		expect(trigger2.ok).toBe(true);
		expect(wakeCalls).toBe(1);

		releaseWake();
		const trigger1Result = await trigger1;
		expect(trigger1Result.ok).toBe(true);

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
				operator_provider: null,
				operator_model: null,
				operator_thinking: null,
				context_session_id: null,
				context_session_file: null,
				context_session_dir: null,
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

		await waitFor(() => (ticks >= 1 ? true : null));
		const loaded = await registry.list({ limit: 10 });
		expect(loaded.length).toBe(1);
		expect(loaded[0]?.program_id).toBe("hb-preloaded-1");

		registry.stop();
		scheduler.stop();
	});

	test("normalizes cadence to scheduler minimum and exposes status", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 2_000 });
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async () => ({ status: "ok" }),
		});

		const created = await registry.create({
			title: "Fast pulse",
			everyMs: 500,
		});
		expect(created.every_ms).toBe(2_000);

		const status = await registry.status();
		expect(status.count).toBe(1);
		expect(status.enabled_count).toBe(1);
		expect(status.armed_count).toBe(1);
		expect(status.armed[0]?.program_id).toBe(created.program_id);
		expect(status.armed[0]?.every_ms).toBe(2_000);

		const disabled = await registry.update({
			programId: created.program_id,
			everyMs: 0,
		});
		expect(disabled.ok).toBe(true);
		expect(disabled.program?.every_ms).toBe(0);

		const statusAfterDisable = await registry.status();
		expect(statusAfterDisable.armed_count).toBe(0);

		registry.stop();
		scheduler.stop();
	});

	test("emits lifecycle events for create/update/delete", async () => {
		const store = new InMemoryJsonlStore<HeartbeatProgramSnapshot>([]);
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });
		const lifecycleActions: string[] = [];
		const registry = new HeartbeatProgramRegistry({
			repoRoot: "/repo",
			heartbeatScheduler: scheduler,
			store,
			dispatchWake: async () => ({ status: "ok" }),
			onLifecycleEvent: async (event) => {
				lifecycleActions.push(event.action);
			},
		});

		const created = await registry.create({ title: "Lifecycle pulse", everyMs: 0 });
		const updated = await registry.update({
			programId: created.program_id,
			title: "Lifecycle pulse v2",
		});
		expect(updated.ok).toBe(true);
		const removed = await registry.remove(created.program_id);
		expect(removed.ok).toBe(true);
		expect(lifecycleActions).toEqual(["created", "updated", "deleted"]);

		registry.stop();
		scheduler.stop();
	});
});
