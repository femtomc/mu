import type { EventLog } from "@femtomc/mu-core/node";
import { CronProgramRegistry } from "./cron_programs.js";
import { HeartbeatProgramRegistry } from "./heartbeat_programs.js";
import type { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";

type OperatorWakeEmitter = (opts: {
	dedupeKey: string;
	message: string;
	payload: Record<string, unknown>;
	coalesceMs?: number;
}) => Promise<{ status: "dispatched" | "coalesced" | "failed"; reason: string }>;

function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

export function createServerProgramCoordination(opts: {
	repoRoot: string;
	heartbeatScheduler: ActivityHeartbeatScheduler;
	eventLog: EventLog;
	emitOperatorWake: OperatorWakeEmitter;
}): {
	heartbeatPrograms: HeartbeatProgramRegistry;
	cronPrograms: CronProgramRegistry;
} {
	const heartbeatPrograms = new HeartbeatProgramRegistry({
		repoRoot: opts.repoRoot,
		heartbeatScheduler: opts.heartbeatScheduler,
		dispatchWake: async (wakeOpts) => {
			const prompt = wakeOpts.prompt && wakeOpts.prompt.trim().length > 0 ? wakeOpts.prompt : null;
			const wakeResult = await opts.emitOperatorWake({
				dedupeKey: `heartbeat-program:${wakeOpts.programId}`,
				message: prompt ?? `Heartbeat wake: ${wakeOpts.title}`,
				payload: {
					wake_source: "heartbeat_program",
					source_ts_ms: wakeOpts.triggeredAtMs,
					program_id: wakeOpts.programId,
					title: wakeOpts.title,
					prompt,
					reason: wakeOpts.reason,
					metadata: wakeOpts.metadata,
				},
			});
			if (wakeResult.status === "coalesced") {
				return { status: "coalesced", reason: wakeResult.reason };
			}
			if (wakeResult.status === "failed") {
				return { status: "failed", reason: wakeResult.reason };
			}
			return { status: "ok" };
		},
		onTickEvent: async (event) => {
			await opts.eventLog.emit("heartbeat_program.tick", {
				source: "mu-server.heartbeat-programs",
				payload: {
					program_id: event.program_id,
					status: event.status,
					reason: event.reason,
					message: event.message,
					program: event.program,
				},
			});
		},
	});

	const cronPrograms = new CronProgramRegistry({
		repoRoot: opts.repoRoot,
		heartbeatScheduler: opts.heartbeatScheduler,
		dispatchWake: async (wakeOpts) => {
			try {
				const wakeResult = await opts.emitOperatorWake({
					dedupeKey: `cron-program:${wakeOpts.programId}`,
					message: `Cron wake: ${wakeOpts.title}`,
					payload: {
						wake_source: "cron_program",
						source_ts_ms: wakeOpts.triggeredAtMs,
						program_id: wakeOpts.programId,
						title: wakeOpts.title,
						prompt: null,
						reason: wakeOpts.reason,
						schedule: wakeOpts.schedule,
						metadata: wakeOpts.metadata,
					},
				});
				if (wakeResult.status === "coalesced") {
					return { status: "coalesced", reason: wakeResult.reason };
				}
				if (wakeResult.status === "failed") {
					return { status: "failed", reason: wakeResult.reason };
				}
				return { status: "ok" };
			} catch (error) {
				return { status: "failed", reason: describeError(error) };
			}
		},
		onLifecycleEvent: async (event) => {
			await opts.eventLog.emit("cron_program.lifecycle", {
				source: "mu-server.cron-programs",
				payload: {
					action: event.action,
					program_id: event.program_id,
					message: event.message,
					program: event.program,
				},
			});
		},
		onTickEvent: async (event) => {
			await opts.eventLog.emit("cron_program.tick", {
				source: "mu-server.cron-programs",
				payload: {
					program_id: event.program_id,
					status: event.status,
					reason: event.reason,
					message: event.message,
					program: event.program,
				},
			});
		},
	});

	return {
		heartbeatPrograms,
		cronPrograms,
	};
}
