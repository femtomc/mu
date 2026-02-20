import type { CommandRecord } from "@femtomc/mu-control-plane";
import type { InterRootQueuePolicy } from "./control_plane_contract.js";
import {
	type DurableRunQueueSnapshot,
	DurableRunQueue,
	reconcileRunQueue,
	runSnapshotFromQueueSnapshot,
} from "./run_queue.js";
import type {
	ControlPlaneRunEvent,
	ControlPlaneRunInterruptResult,
	ControlPlaneRunSnapshot,
	ControlPlaneRunSupervisor,
} from "./run_supervisor.js";

const DEFAULT_RUN_MAX_STEPS = 20;
const MAX_RECONCILE_TURNS = 256;

function toPositiveInt(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(1, Math.trunc(value));
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Math.max(1, Number.parseInt(value, 10));
	}
	return Math.max(1, Math.trunc(fallback));
}

function normalizeIssueId(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!/^mu-[a-z0-9][a-z0-9-]*$/i.test(trimmed)) {
		return null;
	}
	return trimmed.toLowerCase();
}

function isInFlightQueueState(state: DurableRunQueueSnapshot["state"]): boolean {
	return state === "active" || state === "waiting_review" || state === "refining";
}

export type QueueLaunchOpts = {
	mode: "run_start" | "run_resume";
	prompt?: string;
	rootIssueId?: string | null;
	maxSteps?: number;
	source: "command" | "api";
	command?: CommandRecord | null;
	dedupeKey: string;
};

export type ControlPlaneRunQueueCoordinatorOpts = {
	runQueue: DurableRunQueue;
	interRootQueuePolicy: InterRootQueuePolicy;
	getRunSupervisor: () => ControlPlaneRunSupervisor | null;
	defaultRunMaxSteps?: number;
};

/**
 * Queue/reconcile adapter for control-plane run lifecycle operations.
 *
 * Keeps inter-root queue execution concerns out of `control_plane.ts` while preserving
 * queue-first semantics:
 * - enqueue intents durably
 * - reconcile/claim/launch deterministically
 * - mirror runtime events back into durable queue state
 */
export class ControlPlaneRunQueueCoordinator {
	readonly #runQueue: DurableRunQueue;
	readonly #interRootQueuePolicy: InterRootQueuePolicy;
	readonly #getRunSupervisor: () => ControlPlaneRunSupervisor | null;
	readonly #defaultRunMaxSteps: number;
	readonly #queuedCommandById = new Map<string, CommandRecord>();
	#queueReconcileCounter = 0;
	#queueReconcileTail: Promise<void> = Promise.resolve();

	public constructor(opts: ControlPlaneRunQueueCoordinatorOpts) {
		this.#runQueue = opts.runQueue;
		this.#interRootQueuePolicy = opts.interRootQueuePolicy;
		this.#getRunSupervisor = opts.getRunSupervisor;
		this.#defaultRunMaxSteps = toPositiveInt(opts.defaultRunMaxSteps, DEFAULT_RUN_MAX_STEPS);
	}

	public runtimeSnapshotsByJobId(): Map<string, ControlPlaneRunSnapshot> {
		const map = new Map<string, ControlPlaneRunSnapshot>();
		for (const run of this.#getRunSupervisor()?.list({ limit: 500 }) ?? []) {
			map.set(run.job_id, run);
		}
		return map;
	}

	async #launchQueueEntry(row: DurableRunQueueSnapshot, opPrefix: string): Promise<void> {
		const runSupervisor = this.#getRunSupervisor();
		if (!runSupervisor) {
			throw new Error("run_supervisor_unavailable");
		}
		const command = row.command_id ? (this.#queuedCommandById.get(row.command_id) ?? null) : null;
		try {
			const launched =
				row.mode === "run_start"
					? await runSupervisor.launchStart({
							prompt: row.prompt ?? "",
							maxSteps: row.max_steps,
							command,
							commandId: row.command_id,
							source: row.source,
						})
					: await runSupervisor.launchResume({
							rootIssueId: row.root_issue_id ?? "",
							maxSteps: row.max_steps,
							command,
							commandId: row.command_id,
							source: row.source,
						});

			if (command?.command_id) {
				this.#queuedCommandById.delete(command.command_id);
			}

			const latestSnapshot = runSupervisor.get(launched.job_id) ?? launched;
			await this.#runQueue.bindRunSnapshot({
				queueId: row.queue_id,
				run: latestSnapshot,
				operationId: `${opPrefix}:bind:${row.queue_id}:${launched.job_id}`,
			});
		} catch {
			if (command?.command_id) {
				this.#queuedCommandById.delete(command.command_id);
			}
			await this.#runQueue.transition({
				queueId: row.queue_id,
				toState: "failed",
				operationId: `${opPrefix}:failed:${row.queue_id}`,
			});
		}
	}

	async #reconcileQueuedRunsNow(reason: string): Promise<void> {
		const runSupervisor = this.#getRunSupervisor();
		if (!runSupervisor) {
			return;
		}

		for (let turn = 0; turn < MAX_RECONCILE_TURNS; turn += 1) {
			const rows = await this.#runQueue.list({ limit: 500 });
			const plan = reconcileRunQueue(rows, this.#interRootQueuePolicy);
			if (plan.activate_queue_ids.length === 0 && plan.launch_queue_ids.length === 0) {
				return;
			}

			if (plan.activate_queue_ids.length > 0) {
				for (const queueId of plan.activate_queue_ids) {
					await this.#runQueue.claim({
						queueId,
						operationId: `reconcile:${reason}:activate:${queueId}:${turn}`,
					});
				}
				continue;
			}

			for (const queueId of plan.launch_queue_ids) {
				const row = await this.#runQueue.get(queueId);
				if (!row || row.state !== "active") {
					continue;
				}
				if (row.job_id) {
					const existing = runSupervisor.get(row.job_id);
					if (existing) {
						await this.#runQueue.applyRunSnapshot({
							queueId: row.queue_id,
							run: existing,
							operationId: `reconcile:${reason}:existing:${row.queue_id}:${existing.updated_at_ms}`,
						});
						continue;
					}
				}
				await this.#launchQueueEntry(row, `reconcile:${reason}:launch:${turn}`);
			}
		}
	}

	public async scheduleReconcile(reason: string): Promise<void> {
		const token = `${++this.#queueReconcileCounter}:${reason}`;
		this.#queueReconcileTail = this.#queueReconcileTail.then(
			async () => await this.#reconcileQueuedRunsNow(token),
			async () => await this.#reconcileQueuedRunsNow(token),
		);
		return await this.#queueReconcileTail;
	}

	public async launchQueuedRun(launchOpts: QueueLaunchOpts): Promise<ControlPlaneRunSnapshot> {
		const runSupervisor = this.#getRunSupervisor();
		if (!runSupervisor) {
			throw new Error("run_supervisor_unavailable");
		}
		const dedupeKey = launchOpts.dedupeKey.trim();
		if (!dedupeKey) {
			throw new Error("run_queue_dedupe_key_required");
		}
		const maxSteps = toPositiveInt(launchOpts.maxSteps, this.#defaultRunMaxSteps);
		const queued = await this.#runQueue.enqueue({
			mode: launchOpts.mode,
			prompt: launchOpts.mode === "run_start" ? (launchOpts.prompt ?? null) : null,
			rootIssueId: launchOpts.mode === "run_resume" ? (launchOpts.rootIssueId ?? null) : null,
			maxSteps,
			commandId: launchOpts.command?.command_id ?? null,
			source: launchOpts.source,
			dedupeKey,
			operationId: `enqueue:${dedupeKey}`,
		});
		if (launchOpts.command?.command_id) {
			this.#queuedCommandById.set(launchOpts.command.command_id, launchOpts.command);
		}

		await this.scheduleReconcile(`enqueue:${queued.queue_id}`);

		const refreshed = (await this.#runQueue.get(queued.queue_id)) ?? queued;
		const runtime = refreshed.job_id ? (runSupervisor.get(refreshed.job_id) ?? null) : null;
		return runSnapshotFromQueueSnapshot(refreshed, runtime);
	}

	public async launchQueuedRunFromCommand(record: CommandRecord): Promise<ControlPlaneRunSnapshot> {
		if (record.target_type === "run start") {
			const prompt = record.command_args.join(" ").trim();
			if (!prompt) {
				throw new Error("run_start_prompt_required");
			}
			return await this.launchQueuedRun({
				mode: "run_start",
				prompt,
				source: "command",
				command: record,
				dedupeKey: `command:${record.command_id}`,
			});
		}

		if (record.target_type === "run resume") {
			const fallbackRoot = normalizeIssueId(record.target_id);
			const explicitRoot = normalizeIssueId(record.command_args[0] ?? "") ?? fallbackRoot;
			if (!explicitRoot) {
				throw new Error("run_resume_invalid_root_issue_id");
			}
			const maxSteps = toPositiveInt(record.command_args[1], this.#defaultRunMaxSteps);
			return await this.launchQueuedRun({
				mode: "run_resume",
				rootIssueId: explicitRoot,
				maxSteps,
				source: "command",
				command: record,
				dedupeKey: `command:${record.command_id}`,
			});
		}

		throw new Error("run_queue_invalid_command_target");
	}

	public async interruptQueuedRun(opts: {
		jobId?: string | null;
		rootIssueId?: string | null;
	}): Promise<ControlPlaneRunInterruptResult> {
		const runSupervisor = this.#getRunSupervisor();
		const result = runSupervisor?.interrupt(opts) ?? { ok: false, reason: "not_found", run: null };
		if (result.run) {
			await this.#runQueue
				.applyRunSnapshot({
					run: result.run,
					operationId: `interrupt-sync:${result.run.job_id}:${result.run.updated_at_ms}`,
					createIfMissing: true,
				})
				.catch(() => {
					// Best effort only.
				});
		}
		if (result.ok) {
			return result;
		}
		const target = opts.jobId?.trim() || opts.rootIssueId?.trim() || "";
		if (!target) {
			return result;
		}
		const queued = await this.#runQueue.get(target);
		if (!queued) {
			return result;
		}
		if (
			queued.state === "queued" ||
			queued.state === "active" ||
			queued.state === "waiting_review" ||
			queued.state === "refining"
		) {
			const cancelled = await this.#runQueue.transition({
				queueId: queued.queue_id,
				toState: "cancelled",
				operationId: `interrupt-cancel:${target}`,
			});
			await this.scheduleReconcile(`interrupt:${queued.queue_id}`);
			return {
				ok: true,
				reason: null,
				run: runSnapshotFromQueueSnapshot(cancelled),
			};
		}
		return {
			ok: false,
			reason: "not_running",
			run: runSnapshotFromQueueSnapshot(queued),
		};
	}

	public async onRunEvent(event: ControlPlaneRunEvent): Promise<void> {
		const queueEventSnapshot = await this.#runQueue
			.applyRunSnapshot({
				run: event.run,
				operationId: `run-event:${event.seq}:${event.kind}`,
				createIfMissing: false,
			})
			.catch(() => {
				// Best effort queue reconciliation from runtime events.
				return null;
			});

		if (event.kind === "run_heartbeat" && queueEventSnapshot && isInFlightQueueState(queueEventSnapshot.state)) {
			await this.scheduleReconcile(`event-wake:run_heartbeat:${queueEventSnapshot.queue_id}:${event.seq}`);
		}

		if (event.kind === "run_completed" || event.kind === "run_failed" || event.kind === "run_cancelled") {
			await this.scheduleReconcile(`terminal:${event.kind}:${event.run.job_id}`);
		}
	}

	public stop(): void {
		this.#queuedCommandById.clear();
	}
}
