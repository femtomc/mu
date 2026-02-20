import {
	runContextIndexRebuild,
	runContextIndexStatus,
	type EventLog,
	type ContextIndexRebuildResult,
	type ContextIndexStatusResult,
} from "@femtomc/mu-core/node";
import type { MuConfig } from "./config.js";
import type { ActivityHeartbeatScheduler, HeartbeatRunResult } from "./heartbeat_scheduler.js";

const MEMORY_INDEX_ACTIVITY_ID = "maintenance:memory-index";

function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function normalizeEveryMs(value: number): number {
	if (!Number.isFinite(value)) {
		return 300_000;
	}
	return Math.max(1_000, Math.min(86_400_000, Math.trunc(value)));
}

type MaintainerConfig = {
	enabled: boolean;
	every_ms: number;
};

function maintainerConfigFromMuConfig(config: MuConfig): MaintainerConfig {
	return {
		enabled: config.control_plane.memory_index.enabled,
		every_ms: normalizeEveryMs(config.control_plane.memory_index.every_ms),
	};
}

export class MemoryIndexMaintainer {
	readonly #repoRoot: string;
	readonly #scheduler: ActivityHeartbeatScheduler;
	readonly #eventLog: EventLog;
	readonly #loadConfigFromDisk: () => Promise<MuConfig>;
	readonly #fallbackConfig: MaintainerConfig;
	#currentEveryMs: number;
	#started = false;

	public constructor(opts: {
		repoRoot: string;
		heartbeatScheduler: ActivityHeartbeatScheduler;
		eventLog: EventLog;
		loadConfigFromDisk: () => Promise<MuConfig>;
		fallbackConfig: MuConfig;
	}) {
		this.#repoRoot = opts.repoRoot;
		this.#scheduler = opts.heartbeatScheduler;
		this.#eventLog = opts.eventLog;
		this.#loadConfigFromDisk = opts.loadConfigFromDisk;
		this.#fallbackConfig = maintainerConfigFromMuConfig(opts.fallbackConfig);
		this.#currentEveryMs = this.#fallbackConfig.every_ms;
	}

	#register(everyMs: number): void {
		this.#currentEveryMs = everyMs;
		this.#scheduler.register({
			activityId: MEMORY_INDEX_ACTIVITY_ID,
			everyMs,
			coalesceMs: 0,
			handler: async ({ reason }) => await this.#tick(reason),
		});
	}

	async #emitTickEvent(payload: Record<string, unknown>): Promise<void> {
		await this.#eventLog.emit("memory_index.maintenance_tick", {
			source: "mu-server.memory-index-maintainer",
			payload,
		});
	}

	async #emitRebuildEvent(payload: Record<string, unknown>): Promise<void> {
		await this.#eventLog.emit("memory_index.rebuild", {
			source: "mu-server.memory-index-maintainer",
			payload,
		});
	}

	async #emitRebuildFailureEvent(payload: Record<string, unknown>): Promise<void> {
		await this.#eventLog.emit("memory_index.rebuild_failed", {
			source: "mu-server.memory-index-maintainer",
			payload,
		});
	}

	async #readConfig(): Promise<MaintainerConfig> {
		try {
			const config = await this.#loadConfigFromDisk();
			return maintainerConfigFromMuConfig(config);
		} catch {
			return this.#fallbackConfig;
		}
	}

	async #tick(reasonRaw: string | undefined): Promise<HeartbeatRunResult> {
		const reason = typeof reasonRaw === "string" && reasonRaw.trim().length > 0 ? reasonRaw.trim() : "scheduled";
		const cfg = await this.#readConfig();
		if (cfg.every_ms !== this.#currentEveryMs) {
			this.#register(cfg.every_ms);
			await this.#emitTickEvent({
				reason,
				action: "rescheduled",
				every_ms: cfg.every_ms,
				enabled: cfg.enabled,
			});
			return { status: "skipped", reason: "rescheduled" };
		}

		if (!cfg.enabled) {
			await this.#emitTickEvent({
				reason,
				action: "disabled",
				every_ms: cfg.every_ms,
				enabled: cfg.enabled,
			});
			return { status: "skipped", reason: "disabled" };
		}

		let status: ContextIndexStatusResult;
		try {
			status = await runContextIndexStatus({ repoRoot: this.#repoRoot });
		} catch (err) {
			const error = describeError(err);
			await this.#emitRebuildFailureEvent({
				reason,
				action: "status_failed",
				error,
			});
			return { status: "failed", reason: error };
		}

		const needsRebuild = !status.exists || status.stale_source_count > 0;
		if (!needsRebuild) {
			await this.#emitTickEvent({
				reason,
				action: "up_to_date",
				enabled: cfg.enabled,
				every_ms: cfg.every_ms,
				total_count: status.total_count,
				stale_source_count: status.stale_source_count,
			});
			return { status: "skipped", reason: "up_to_date" };
		}

		const startedAtMs = Date.now();
		try {
			const rebuild: ContextIndexRebuildResult = await runContextIndexRebuild({
				repoRoot: this.#repoRoot,
				search: new URLSearchParams(),
			});
			await this.#emitRebuildEvent({
				reason,
				action: "rebuilt",
				duration_ms: Math.max(0, Date.now() - startedAtMs),
				indexed_count: rebuild.indexed_count,
				total_count: rebuild.total_count,
				stale_source_count: rebuild.stale_source_count,
				source_count: rebuild.source_count,
			});
			return { status: "ran" };
		} catch (err) {
			const error = describeError(err);
			await this.#emitRebuildFailureEvent({
				reason,
				action: "rebuild_failed",
				duration_ms: Math.max(0, Date.now() - startedAtMs),
				error,
				index_exists: status.exists,
				stale_source_count: status.stale_source_count,
			});
			return { status: "failed", reason: error };
		}
	}

	public start(): void {
		if (this.#started) {
			return;
		}
		this.#started = true;
		this.#register(this.#currentEveryMs);
		this.#scheduler.requestNow(MEMORY_INDEX_ACTIVITY_ID, { reason: "startup", coalesceMs: 0 });
	}

	public stop(): void {
		if (!this.#started) {
			return;
		}
		this.#started = false;
		this.#scheduler.unregister(MEMORY_INDEX_ACTIVITY_ID);
	}
}
