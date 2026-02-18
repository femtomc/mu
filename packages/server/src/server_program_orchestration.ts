import type { EventLog } from "@femtomc/mu-core/node";
import type { ControlPlaneActivitySupervisor } from "./activity_supervisor.js";
import type { ControlPlaneHandle } from "./control_plane_contract.js";
import { CronProgramRegistry } from "./cron_programs.js";
import { HeartbeatProgramRegistry, type HeartbeatProgramSnapshot } from "./heartbeat_programs.js";
import type { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";

const AUTO_RUN_HEARTBEAT_REASON = "auto-run-heartbeat";

export type AutoHeartbeatRunSnapshot = {
	job_id: string;
	root_issue_id: string | null;
	status: string;
	source: "command" | "api";
	mode: string;
};

type OperatorWakeEmitter = (opts: {
	dedupeKey: string;
	message: string;
	payload: Record<string, unknown>;
	coalesceMs?: number;
}) => Promise<boolean>;

export function createServerProgramOrchestration(opts: {
	repoRoot: string;
	heartbeatScheduler: ActivityHeartbeatScheduler;
	controlPlaneProxy: ControlPlaneHandle;
	activitySupervisor: ControlPlaneActivitySupervisor;
	eventLog: EventLog;
	autoRunHeartbeatEveryMs: number;
	emitOperatorWake: OperatorWakeEmitter;
}): {
	heartbeatPrograms: HeartbeatProgramRegistry;
	cronPrograms: CronProgramRegistry;
	registerAutoRunHeartbeatProgram: (run: AutoHeartbeatRunSnapshot) => Promise<void>;
	disableAutoRunHeartbeatProgram: (opts: { jobId: string; status: string; reason: string }) => Promise<void>;
} {
	const autoRunHeartbeatProgramByJobId = new Map<string, string>();

	const heartbeatPrograms = new HeartbeatProgramRegistry({
		repoRoot: opts.repoRoot,
		heartbeatScheduler: opts.heartbeatScheduler,
		runHeartbeat: async (runOpts) => {
			const result = await opts.controlPlaneProxy.heartbeatRun?.({
				jobId: runOpts.jobId ?? null,
				rootIssueId: runOpts.rootIssueId ?? null,
				reason: runOpts.reason ?? null,
				wakeMode: runOpts.wakeMode,
			});
			return result ?? { ok: false, reason: "not_found" };
		},
		activityHeartbeat: async (activityOpts) => {
			return opts.activitySupervisor.heartbeat({
				activityId: activityOpts.activityId ?? null,
				reason: activityOpts.reason ?? null,
			});
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
			await opts.emitOperatorWake({
				dedupeKey: `heartbeat-program:${event.program_id}`,
				message: event.message,
				payload: {
					wake_source: "heartbeat_program",
					program_id: event.program_id,
					status: event.status,
					reason: event.reason,
					wake_mode: event.program.wake_mode,
					target_kind: event.program.target.kind,
					target:
						event.program.target.kind === "run"
							? {
									job_id: event.program.target.job_id,
									root_issue_id: event.program.target.root_issue_id,
								}
							: { activity_id: event.program.target.activity_id },
				},
			});
		},
	});

	const cronPrograms = new CronProgramRegistry({
		repoRoot: opts.repoRoot,
		heartbeatScheduler: opts.heartbeatScheduler,
		runHeartbeat: async (runOpts) => {
			const result = await opts.controlPlaneProxy.heartbeatRun?.({
				jobId: runOpts.jobId ?? null,
				rootIssueId: runOpts.rootIssueId ?? null,
				reason: runOpts.reason ?? null,
				wakeMode: runOpts.wakeMode,
			});
			return result ?? { ok: false, reason: "not_found" };
		},
		activityHeartbeat: async (activityOpts) => {
			return opts.activitySupervisor.heartbeat({
				activityId: activityOpts.activityId ?? null,
				reason: activityOpts.reason ?? null,
			});
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
			await opts.emitOperatorWake({
				dedupeKey: `cron-program:${event.program_id}`,
				message: event.message,
				payload: {
					wake_source: "cron_program",
					program_id: event.program_id,
					status: event.status,
					reason: event.reason,
					wake_mode: event.program.wake_mode,
					target_kind: event.program.target.kind,
					target:
						event.program.target.kind === "run"
							? {
									job_id: event.program.target.job_id,
									root_issue_id: event.program.target.root_issue_id,
								}
							: { activity_id: event.program.target.activity_id },
				},
			});
		},
	});

	const findAutoRunHeartbeatProgram = async (jobId: string): Promise<HeartbeatProgramSnapshot | null> => {
		const normalizedJobId = jobId.trim();
		if (!normalizedJobId) {
			return null;
		}
		const knownProgramId = autoRunHeartbeatProgramByJobId.get(normalizedJobId);
		if (knownProgramId) {
			const knownProgram = await heartbeatPrograms.get(knownProgramId);
			if (knownProgram) {
				return knownProgram;
			}
			autoRunHeartbeatProgramByJobId.delete(normalizedJobId);
		}
		const programs = await heartbeatPrograms.list({ targetKind: "run", limit: 500 });
		for (const program of programs) {
			if (program.metadata.auto_run_job_id !== normalizedJobId) {
				continue;
			}
			autoRunHeartbeatProgramByJobId.set(normalizedJobId, program.program_id);
			return program;
		}
		return null;
	};

	const registerAutoRunHeartbeatProgram = async (run: AutoHeartbeatRunSnapshot): Promise<void> => {
		if (run.source === "command") {
			return;
		}
		const jobId = run.job_id.trim();
		if (!jobId || run.status !== "running") {
			return;
		}
		const rootIssueId = typeof run.root_issue_id === "string" ? run.root_issue_id.trim() : "";
		const metadata: Record<string, unknown> = {
			auto_run_heartbeat: true,
			auto_run_job_id: jobId,
			auto_run_root_issue_id: rootIssueId || null,
			auto_disable_on_terminal: true,
			run_mode: run.mode,
			run_source: run.source,
		};

		const existing = await findAutoRunHeartbeatProgram(jobId);
		if (existing) {
			const result = await heartbeatPrograms.update({
				programId: existing.program_id,
				title: `Run heartbeat: ${rootIssueId || jobId}`,
				target: {
					kind: "run",
					job_id: jobId,
					root_issue_id: rootIssueId || null,
				},
				enabled: true,
				everyMs: opts.autoRunHeartbeatEveryMs,
				reason: AUTO_RUN_HEARTBEAT_REASON,
				wakeMode: "next_heartbeat",
				metadata,
			});
			if (result.ok && result.program) {
				autoRunHeartbeatProgramByJobId.set(jobId, result.program.program_id);
				await opts.eventLog.emit("run.auto_heartbeat.lifecycle", {
					source: "mu-server.runs",
					payload: {
						action: "updated",
						run_job_id: jobId,
						run_root_issue_id: rootIssueId || null,
						program_id: result.program.program_id,
						program: result.program,
					},
				});
			}
			return;
		}

		const created = await heartbeatPrograms.create({
			title: `Run heartbeat: ${rootIssueId || jobId}`,
			target: {
				kind: "run",
				job_id: jobId,
				root_issue_id: rootIssueId || null,
			},
			everyMs: opts.autoRunHeartbeatEveryMs,
			reason: AUTO_RUN_HEARTBEAT_REASON,
			wakeMode: "next_heartbeat",
			metadata,
			enabled: true,
		});
		autoRunHeartbeatProgramByJobId.set(jobId, created.program_id);
		await opts.eventLog.emit("run.auto_heartbeat.lifecycle", {
			source: "mu-server.runs",
			payload: {
				action: "registered",
				run_job_id: jobId,
				run_root_issue_id: rootIssueId || null,
				program_id: created.program_id,
				program: created,
			},
		});
	};

	const disableAutoRunHeartbeatProgram = async (disableOpts: {
		jobId: string;
		status: string;
		reason: string;
	}): Promise<void> => {
		const program = await findAutoRunHeartbeatProgram(disableOpts.jobId);
		if (!program) {
			return;
		}
		const metadata = {
			...program.metadata,
			auto_disabled_from_status: disableOpts.status,
			auto_disabled_reason: disableOpts.reason,
			auto_disabled_at_ms: Date.now(),
		};
		const result = await heartbeatPrograms.update({
			programId: program.program_id,
			enabled: false,
			everyMs: 0,
			reason: AUTO_RUN_HEARTBEAT_REASON,
			wakeMode: program.wake_mode,
			metadata,
		});
		autoRunHeartbeatProgramByJobId.delete(disableOpts.jobId.trim());
		if (!result.ok || !result.program) {
			return;
		}
		await opts.eventLog.emit("run.auto_heartbeat.lifecycle", {
			source: "mu-server.runs",
			payload: {
				action: "disabled",
				run_job_id: disableOpts.jobId,
				status: disableOpts.status,
				reason: disableOpts.reason,
				program_id: result.program.program_id,
				program: result.program,
			},
		});
	};

	return {
		heartbeatPrograms,
		cronPrograms,
		registerAutoRunHeartbeatProgram,
		disableAutoRunHeartbeatProgram,
	};
}
