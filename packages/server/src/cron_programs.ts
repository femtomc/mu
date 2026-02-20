import { join } from "node:path";
import type { JsonlStore } from "@femtomc/mu-core";
import { FsJsonlStore } from "@femtomc/mu-core/node";
import { type CronProgramSchedule, computeNextScheduleRunAtMs, normalizeCronSchedule } from "./cron_schedule.js";
import { CronTimerRegistry } from "./cron_timer.js";
import type { ActivityHeartbeatScheduler, HeartbeatRunResult } from "./heartbeat_scheduler.js";

export type CronProgramSnapshot = {
	v: 1;
	program_id: string;
	title: string;
	enabled: boolean;
	schedule: CronProgramSchedule;
	reason: string;
	metadata: Record<string, unknown>;
	created_at_ms: number;
	updated_at_ms: number;
	next_run_at_ms: number | null;
	last_triggered_at_ms: number | null;
	last_result: "ok" | "coalesced" | "failed" | null;
	last_error: string | null;
};

export type CronProgramLifecycleAction =
	| "created"
	| "updated"
	| "deleted"
	| "scheduled"
	| "disabled"
	| "oneshot_completed";

export type CronProgramLifecycleEvent = {
	ts_ms: number;
	action: CronProgramLifecycleAction;
	program_id: string;
	message: string;
	program: CronProgramSnapshot | null;
};

export type CronProgramTickEvent = {
	ts_ms: number;
	program_id: string;
	message: string;
	status: "ok" | "coalesced" | "failed";
	reason: string | null;
	program: CronProgramSnapshot;
};

export type CronProgramOperationResult = {
	ok: boolean;
	reason: "not_found" | "missing_target" | "invalid_schedule" | "not_running" | "failed" | null;
	program: CronProgramSnapshot | null;
};

export type CronProgramStatusSnapshot = {
	count: number;
	enabled_count: number;
	armed_count: number;
	armed: Array<{
		program_id: string;
		due_at_ms: number;
	}>;
};

export type CronProgramDispatchResult =
	| { status: "ok"; reason?: string | null }
	| { status: "coalesced"; reason?: string | null }
	| { status: "failed"; reason: string };

export type CronProgramRegistryOpts = {
	repoRoot: string;
	heartbeatScheduler: ActivityHeartbeatScheduler;
	nowMs?: () => number;
	timer?: CronTimerRegistry;
	store?: JsonlStore<CronProgramSnapshot>;
	dispatchWake: (opts: {
		programId: string;
		title: string;
		reason: string;
		metadata: Record<string, unknown>;
		triggeredAtMs: number;
		schedule: CronProgramSchedule;
	}) => Promise<CronProgramDispatchResult>;
	onTickEvent?: (event: CronProgramTickEvent) => void | Promise<void>;
	onLifecycleEvent?: (event: CronProgramLifecycleEvent) => void | Promise<void>;
};

const CRON_PROGRAMS_FILENAME = "cron.jsonl";

function defaultNowMs(): number {
	return Date.now();
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return { ...(value as Record<string, unknown>) };
}

function normalizeProgram(row: unknown): CronProgramSnapshot | null {
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		return null;
	}
	const record = row as Record<string, unknown>;
	const programId = typeof record.program_id === "string" ? record.program_id.trim() : "";
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const createdAt =
		typeof record.created_at_ms === "number" && Number.isFinite(record.created_at_ms)
			? Math.trunc(record.created_at_ms)
			: defaultNowMs();
	const schedule = normalizeCronSchedule(record.schedule, {
		nowMs: createdAt,
		defaultEveryAnchorMs: createdAt,
	});
	if (!programId || !title || !schedule) {
		return null;
	}
	const updatedAt =
		typeof record.updated_at_ms === "number" && Number.isFinite(record.updated_at_ms)
			? Math.trunc(record.updated_at_ms)
			: createdAt;
	const nextRunAt =
		typeof record.next_run_at_ms === "number" && Number.isFinite(record.next_run_at_ms)
			? Math.trunc(record.next_run_at_ms)
			: null;
	const lastTriggeredAt =
		typeof record.last_triggered_at_ms === "number" && Number.isFinite(record.last_triggered_at_ms)
			? Math.trunc(record.last_triggered_at_ms)
			: null;
	const lastResultRaw = typeof record.last_result === "string" ? record.last_result.trim().toLowerCase() : null;
	const lastResult = lastResultRaw === "ok" || lastResultRaw === "coalesced" || lastResultRaw === "failed" ? lastResultRaw : null;
	const reason =
		typeof record.reason === "string" && record.reason.trim().length > 0 ? record.reason.trim() : "scheduled";
	return {
		v: 1,
		program_id: programId,
		title,
		enabled: record.enabled !== false,
		schedule,
		reason,
		metadata: sanitizeMetadata(record.metadata),
		created_at_ms: createdAt,
		updated_at_ms: updatedAt,
		next_run_at_ms: nextRunAt,
		last_triggered_at_ms: lastTriggeredAt,
		last_result: lastResult,
		last_error: typeof record.last_error === "string" ? record.last_error : null,
	};
}

function sortPrograms(programs: CronProgramSnapshot[]): CronProgramSnapshot[] {
	return [...programs].sort((a, b) => {
		if (a.created_at_ms !== b.created_at_ms) {
			return a.created_at_ms - b.created_at_ms;
		}
		return a.program_id.localeCompare(b.program_id);
	});
}

function shouldRetry(result: HeartbeatRunResult): boolean {
	return result.status === "failed";
}

export class CronProgramRegistry {
	readonly #store: JsonlStore<CronProgramSnapshot>;
	readonly #heartbeatScheduler: ActivityHeartbeatScheduler;
	readonly #timer: CronTimerRegistry;
	readonly #dispatchWake: CronProgramRegistryOpts["dispatchWake"];
	readonly #onTickEvent: CronProgramRegistryOpts["onTickEvent"];
	readonly #onLifecycleEvent: CronProgramRegistryOpts["onLifecycleEvent"];
	readonly #nowMs: () => number;
	readonly #programs = new Map<string, CronProgramSnapshot>();
	#loaded: Promise<void> | null = null;

	public constructor(opts: CronProgramRegistryOpts) {
		this.#heartbeatScheduler = opts.heartbeatScheduler;
		this.#dispatchWake = opts.dispatchWake;
		this.#onTickEvent = opts.onTickEvent;
		this.#onLifecycleEvent = opts.onLifecycleEvent;
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#timer = opts.timer ?? new CronTimerRegistry({ nowMs: this.#nowMs });
		this.#store =
			opts.store ?? new FsJsonlStore<CronProgramSnapshot>(join(opts.repoRoot, ".mu", CRON_PROGRAMS_FILENAME));
		void this.#ensureLoaded().catch(() => {
			// Best effort eager load for startup re-arming.
		});
	}

	#scheduleId(programId: string): string {
		return `cron-program:${programId}`;
	}

	#snapshot(program: CronProgramSnapshot): CronProgramSnapshot {
		return {
			...program,
			schedule: { ...program.schedule },
			metadata: { ...program.metadata },
		};
	}

	async #emitLifecycleEvent(event: CronProgramLifecycleEvent): Promise<void> {
		if (!this.#onLifecycleEvent) {
			return;
		}
		await this.#onLifecycleEvent(event);
	}

	async #emitTickEvent(event: CronProgramTickEvent): Promise<void> {
		if (!this.#onTickEvent) {
			return;
		}
		await this.#onTickEvent(event);
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			this.#loaded = this.#load();
		}
		await this.#loaded;
	}

	async #load(): Promise<void> {
		const rows = await this.#store.read();
		for (const row of rows) {
			const normalized = normalizeProgram(row);
			if (!normalized) {
				continue;
			}
			this.#programs.set(normalized.program_id, normalized);
		}
		let dirty = false;
		for (const program of this.#programs.values()) {
			dirty = this.#applySchedule(program) || dirty;
		}
		if (dirty) {
			await this.#persist();
		}
	}

	async #persist(): Promise<void> {
		const rows = sortPrograms([...this.#programs.values()]);
		await this.#store.write(rows);
	}

	#armTimer(program: CronProgramSnapshot): boolean {
		this.#timer.disarm(program.program_id);
		const nowMs = Math.trunc(this.#nowMs());
		const nextRunAt = computeNextScheduleRunAtMs(program.schedule, nowMs);
		const normalizedNextRun =
			typeof nextRunAt === "number" && Number.isFinite(nextRunAt) ? Math.trunc(nextRunAt) : null;
		const changed = program.next_run_at_ms !== normalizedNextRun;
		program.next_run_at_ms = normalizedNextRun;
		if (normalizedNextRun == null) {
			return changed;
		}
		this.#timer.arm({
			programId: program.program_id,
			dueAtMs: normalizedNextRun,
			onDue: async () => {
				const current = this.#programs.get(program.program_id);
				if (!current || !current.enabled) {
					return;
				}
				this.#heartbeatScheduler.requestNow(this.#scheduleId(program.program_id), {
					reason: `cron:${program.program_id}`,
					coalesceMs: 0,
				});
			},
		});
		return changed;
	}

	#applySchedule(program: CronProgramSnapshot): boolean {
		const scheduleId = this.#scheduleId(program.program_id);
		this.#timer.disarm(program.program_id);
		this.#heartbeatScheduler.unregister(scheduleId);
		if (!program.enabled) {
			const changed = program.next_run_at_ms !== null;
			program.next_run_at_ms = null;
			return changed;
		}

		this.#heartbeatScheduler.register({
			activityId: scheduleId,
			everyMs: 0,
			handler: async ({ reason }): Promise<HeartbeatRunResult> => {
				return await this.#tickProgram(program.program_id, {
					reason: reason ?? undefined,
					advanceSchedule: true,
				});
			},
		});
		return this.#armTimer(program);
	}

	async #tickProgram(
		programId: string,
		opts: {
			reason?: string;
			advanceSchedule: boolean;
		},
	): Promise<HeartbeatRunResult> {
		const program = this.#programs.get(programId);
		if (!program) {
			return { status: "skipped", reason: "not_found" };
		}
		if (!program.enabled) {
			return { status: "skipped", reason: "disabled" };
		}

		const triggerReason = opts.reason?.trim() || program.reason || "scheduled";
		const nowMs = Math.trunc(this.#nowMs());
		program.last_triggered_at_ms = nowMs;
		program.updated_at_ms = nowMs;

		let dispatchResult: HeartbeatRunResult;
		let eventStatus: CronProgramTickEvent["status"] = "ok";
		let eventReason: string | null = triggerReason;
		let eventMessage = `cron program dispatched wake: ${program.title}`;

		try {
			const executionResult = await this.#dispatchWake({
				programId: program.program_id,
				title: program.title,
				reason: triggerReason,
				metadata: { ...program.metadata },
				triggeredAtMs: nowMs,
				schedule: { ...program.schedule },
			});

			if (executionResult.status === "ok") {
				program.last_result = "ok";
				program.last_error = null;
				dispatchResult = { status: "ran" };
			} else if (executionResult.status === "coalesced") {
				program.last_result = "coalesced";
				program.last_error = null;
				eventStatus = "coalesced";
				eventReason = executionResult.reason ?? "coalesced";
				eventMessage = `cron program coalesced wake: ${program.title}`;
				dispatchResult = { status: "skipped", reason: "coalesced" };
			} else {
				program.last_result = "failed";
				program.last_error = executionResult.reason;
				eventStatus = "failed";
				eventReason = executionResult.reason;
				eventMessage = `cron program failed: ${program.title}`;
				dispatchResult = { status: "failed", reason: executionResult.reason };
			}
		} catch (err) {
			program.last_result = "failed";
			program.last_error = err instanceof Error ? err.message : String(err);
			eventStatus = "failed";
			eventReason = program.last_error;
			eventMessage = `cron program failed: ${program.title}`;
			dispatchResult = { status: "failed", reason: program.last_error };
		}

		if (opts.advanceSchedule && !shouldRetry(dispatchResult)) {
			if (program.schedule.kind === "at") {
				program.enabled = false;
				program.next_run_at_ms = null;
				this.#timer.disarm(program.program_id);
				this.#heartbeatScheduler.unregister(this.#scheduleId(program.program_id));
				void this.#emitLifecycleEvent({
					ts_ms: Math.trunc(this.#nowMs()),
					action: "oneshot_completed",
					program_id: program.program_id,
					message: `cron one-shot completed: ${program.title}`,
					program: this.#snapshot(program),
				}).catch(() => {
					// best effort only
				});
			} else {
				this.#armTimer(program);
			}
		}

		await this.#persist();
		await this.#emitTickEvent({
			ts_ms: nowMs,
			program_id: program.program_id,
			message: eventMessage,
			status: eventStatus,
			reason: eventReason,
			program: this.#snapshot(program),
		}).catch(() => {
			// best effort only
		});

		return dispatchResult;
	}

	public async list(
		opts: {
			enabled?: boolean;
			scheduleKind?: "at" | "every" | "cron";
			limit?: number;
		} = {},
	): Promise<CronProgramSnapshot[]> {
		await this.#ensureLoaded();
		const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
		return sortPrograms([...this.#programs.values()])
			.filter((program) => {
				if (typeof opts.enabled === "boolean" && program.enabled !== opts.enabled) {
					return false;
				}
				if (opts.scheduleKind && program.schedule.kind !== opts.scheduleKind) {
					return false;
				}
				return true;
			})
			.slice(0, limit)
			.map((program) => this.#snapshot(program));
	}

	public async status(): Promise<CronProgramStatusSnapshot> {
		await this.#ensureLoaded();
		const armed = this.#timer.list();
		const programs = [...this.#programs.values()];
		return {
			count: programs.length,
			enabled_count: programs.filter((program) => program.enabled).length,
			armed_count: armed.length,
			armed,
		};
	}

	public async get(programId: string): Promise<CronProgramSnapshot | null> {
		await this.#ensureLoaded();
		const program = this.#programs.get(programId.trim());
		return program ? this.#snapshot(program) : null;
	}

	public async create(opts: {
		title: string;
		schedule: unknown;
		reason?: string;
		enabled?: boolean;
		metadata?: Record<string, unknown>;
	}): Promise<CronProgramSnapshot> {
		await this.#ensureLoaded();
		const title = opts.title.trim();
		if (!title) {
			throw new Error("cron_program_title_required");
		}
		const nowMs = Math.trunc(this.#nowMs());
		const schedule = normalizeCronSchedule(opts.schedule, {
			nowMs,
			defaultEveryAnchorMs: nowMs,
		});
		if (!schedule) {
			throw new Error("cron_program_invalid_schedule");
		}
		const program: CronProgramSnapshot = {
			v: 1,
			program_id: `cron-${crypto.randomUUID().slice(0, 12)}`,
			title,
			enabled: opts.enabled !== false,
			schedule,
			reason: opts.reason?.trim() || "scheduled",
			metadata: sanitizeMetadata(opts.metadata),
			created_at_ms: nowMs,
			updated_at_ms: nowMs,
			next_run_at_ms: null,
			last_triggered_at_ms: null,
			last_result: null,
			last_error: null,
		};
		this.#programs.set(program.program_id, program);
		this.#applySchedule(program);
		await this.#persist();
		void this.#emitLifecycleEvent({
			ts_ms: nowMs,
			action: "created",
			program_id: program.program_id,
			message: `cron program created: ${program.title}`,
			program: this.#snapshot(program),
		}).catch(() => {
			// best effort only
		});
		return this.#snapshot(program);
	}

	public async update(opts: {
		programId: string;
		title?: string;
		reason?: string;
		enabled?: boolean;
		schedule?: unknown;
		metadata?: Record<string, unknown>;
	}): Promise<CronProgramOperationResult> {
		await this.#ensureLoaded();
		const program = this.#programs.get(opts.programId.trim());
		if (!program) {
			return { ok: false, reason: "not_found", program: null };
		}

		if (typeof opts.title === "string") {
			const title = opts.title.trim();
			if (!title) {
				throw new Error("cron_program_title_required");
			}
			program.title = title;
		}
		if (typeof opts.reason === "string") {
			program.reason = opts.reason.trim() || "scheduled";
		}
		if (typeof opts.enabled === "boolean") {
			program.enabled = opts.enabled;
		}
		if (opts.schedule) {
			const nowMs = Math.trunc(this.#nowMs());
			const normalizedSchedule = normalizeCronSchedule(opts.schedule, {
				nowMs,
				defaultEveryAnchorMs: program.schedule.kind === "every" ? program.schedule.anchor_ms : nowMs,
			});
			if (!normalizedSchedule) {
				return { ok: false, reason: "invalid_schedule", program: this.#snapshot(program) };
			}
			program.schedule = normalizedSchedule;
		}
		if (opts.metadata) {
			program.metadata = sanitizeMetadata(opts.metadata);
		}

		program.updated_at_ms = Math.trunc(this.#nowMs());
		this.#applySchedule(program);
		await this.#persist();
		void this.#emitLifecycleEvent({
			ts_ms: Math.trunc(this.#nowMs()),
			action: "updated",
			program_id: program.program_id,
			message: `cron program updated: ${program.title}`,
			program: this.#snapshot(program),
		}).catch(() => {
			// best effort only
		});
		return { ok: true, reason: null, program: this.#snapshot(program) };
	}

	public async remove(programId: string): Promise<CronProgramOperationResult> {
		await this.#ensureLoaded();
		const normalizedId = programId.trim();
		if (!normalizedId) {
			return { ok: false, reason: "missing_target", program: null };
		}
		const program = this.#programs.get(normalizedId);
		if (!program) {
			return { ok: false, reason: "not_found", program: null };
		}
		this.#timer.disarm(program.program_id);
		this.#heartbeatScheduler.unregister(this.#scheduleId(program.program_id));
		this.#programs.delete(normalizedId);
		await this.#persist();
		void this.#emitLifecycleEvent({
			ts_ms: Math.trunc(this.#nowMs()),
			action: "deleted",
			program_id: program.program_id,
			message: `cron program deleted: ${program.title}`,
			program: this.#snapshot(program),
		}).catch(() => {
			// best effort only
		});
		return { ok: true, reason: null, program: this.#snapshot(program) };
	}

	public async trigger(opts: {
		programId?: string | null;
		reason?: string | null;
	}): Promise<CronProgramOperationResult> {
		await this.#ensureLoaded();
		const programId = opts.programId?.trim() || "";
		if (!programId) {
			return { ok: false, reason: "missing_target", program: null };
		}
		const program = this.#programs.get(programId);
		if (!program) {
			return { ok: false, reason: "not_found", program: null };
		}
		if (!program.enabled) {
			return { ok: false, reason: "not_running", program: this.#snapshot(program) };
		}
		const tick = await this.#tickProgram(program.program_id, {
			reason: opts.reason?.trim() || "manual",
			advanceSchedule: false,
		});
		if (tick.status === "failed") {
			return { ok: false, reason: "failed", program: this.#snapshot(program) };
		}
		return { ok: true, reason: null, program: this.#snapshot(program) };
	}

	public stop(): void {
		for (const program of this.#programs.values()) {
			this.#timer.disarm(program.program_id);
			this.#heartbeatScheduler.unregister(this.#scheduleId(program.program_id));
		}
		this.#timer.stop();
		this.#programs.clear();
	}
}
