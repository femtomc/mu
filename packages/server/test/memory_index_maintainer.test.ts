import { describe, expect, test } from "bun:test";
import {
	EventLog,
	JsonlEventSink,
	InMemoryJsonlStore,
	getStorePaths,
	runContextIndexStatus,
	type EventEnvelope,
} from "@femtomc/mu-core/node";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MU_CONFIG } from "../src/config.js";
import { ActivityHeartbeatScheduler } from "../src/heartbeat_scheduler.js";
import { MemoryIndexMaintainer } from "../src/memory_index_maintainer.js";

async function waitFor<T>(
	fn: () => T | null | Promise<T | null>,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 3_000;
	const intervalMs = opts.intervalMs ?? 20;
	const startedAt = Date.now();
	while (true) {
		const value = await fn();
		if (value != null) {
			return value;
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("timeout waiting for condition");
		}
		await Bun.sleep(intervalMs);
	}
}

async function mkTempRepo(): Promise<{ repoRoot: string; storeDir: string }> {
	const repoRoot = await mkdtemp(join(tmpdir(), "mu-memory-index-maintainer-"));
	await mkdir(join(repoRoot, ".git"), { recursive: true });
	const storeDir = getStorePaths(repoRoot).storeDir;
	await mkdir(storeDir, { recursive: true });
	return { repoRoot, storeDir };
}

describe("MemoryIndexMaintainer", () => {
	test("startup tick rebuilds missing memory index when enabled", async () => {
		const { repoRoot, storeDir } = await mkTempRepo();
		const eventsStore = new InMemoryJsonlStore<EventEnvelope>([]);
		const eventLog = new EventLog(new JsonlEventSink(eventsStore));
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });

		await writeFile(
			join(storeDir, "issues.jsonl"),
			`${JSON.stringify({
				id: "mu-maintainer-1",
				title: "Maintain memory index",
				body: "startup token",
				status: "open",
				tags: ["node:agent"],
				priority: 2,
				created_at: Date.now(),
				updated_at: Date.now(),
			})}\n`,
			"utf8",
		);

		const maintainer = new MemoryIndexMaintainer({
			repoRoot,
			heartbeatScheduler: scheduler,
			eventLog,
			loadConfigFromDisk: async () => ({
				...DEFAULT_MU_CONFIG,
				control_plane: {
					...DEFAULT_MU_CONFIG.control_plane,
					memory_index: {
						enabled: true,
						every_ms: 25,
					},
				},
			}),
			fallbackConfig: DEFAULT_MU_CONFIG,
		});

		try {
			maintainer.start();

			await waitFor(async () => {
				const status = await runContextIndexStatus({ repoRoot });
				return status.exists && status.total_count >= 1 ? status : null;
			});

			const events = await eventsStore.read();
			expect(events.some((event) => event.type === "memory_index.rebuild")).toBe(true);
		} finally {
			maintainer.stop();
			scheduler.stop();
			await rm(repoRoot, { recursive: true, force: true });
			await rm(storeDir, { recursive: true, force: true });
		}
	});

	test("disabled memory-index config skips rebuild work", async () => {
		const { repoRoot, storeDir } = await mkTempRepo();
		const eventsStore = new InMemoryJsonlStore<EventEnvelope>([]);
		const eventLog = new EventLog(new JsonlEventSink(eventsStore));
		const scheduler = new ActivityHeartbeatScheduler({ minIntervalMs: 10 });

		const disabledConfig = {
			...DEFAULT_MU_CONFIG,
			control_plane: {
				...DEFAULT_MU_CONFIG.control_plane,
				memory_index: {
					enabled: false,
					every_ms: 20,
				},
			},
		};

		const maintainer = new MemoryIndexMaintainer({
			repoRoot,
			heartbeatScheduler: scheduler,
			eventLog,
			loadConfigFromDisk: async () => disabledConfig,
			fallbackConfig: disabledConfig,
		});

		try {
			maintainer.start();

			const disabledEvent = await waitFor(async () => {
				const events = await eventsStore.read();
				return (
					events.find(
						(event) =>
							event.type === "memory_index.maintenance_tick" &&
							typeof event.payload === "object" &&
							event.payload != null &&
							(event.payload as Record<string, unknown>).action === "disabled",
					) ?? null
				);
			});
			expect(disabledEvent.type).toBe("memory_index.maintenance_tick");

			const status = await runContextIndexStatus({ repoRoot });
			expect(status.exists).toBe(false);
		} finally {
			maintainer.stop();
			scheduler.stop();
			await rm(repoRoot, { recursive: true, force: true });
			await rm(storeDir, { recursive: true, force: true });
		}
	});
});
