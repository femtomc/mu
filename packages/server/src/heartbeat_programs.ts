import { join } from "node:path";
import type { JsonlStore } from "@femtomc/mu-core";
import { FsJsonlStore, getStorePaths } from "@femtomc/mu-core/node";
import type { ActivityHeartbeatScheduler, HeartbeatRunResult } from "./heartbeat_scheduler.js";

export type HeartbeatProgramSnapshot = {
	v: 1;
	program_id: string;
	title: string;
	prompt: string | null;
	enabled: boolean;
	every_ms: number;
	reason: string;
	metadata: Record<string, unknown>;
	created_at_ms: number;
	updated_at_ms: number;
	last_triggered_at_ms: number | null;
	last_result: "ok" | "coalesced" | "failed" | null;
	last_error: string | null;
};

export type HeartbeatProgramOperationResult = {
	ok: boolean;
	reason: "not_found" | "missing_target" | "not_running" | "failed" | null;
	program: HeartbeatProgramSnapshot | null;
};

export type HeartbeatProgramTickEvent = {
	ts_ms: number;
	program_id: string;
	message: string;
	status: "ok" | "coalesced" | "failed";
	reason: string | null;
	program: HeartbeatProgramSnapshot;
};

export type HeartbeatProgramDispatchResult =
	| { status: "ok"; reason?: string | null }
	| { status: "coalesced"; reason?: string | null }
	| { status: "failed"; reason: string };

export type HeartbeatProgramRegistryOpts = {
	repoRoot: string;
	heartbeatScheduler: ActivityHeartbeatScheduler;
	nowMs?: () => number;
	store?: JsonlStore<HeartbeatProgramSnapshot>;
	dispatchWake: (opts: {
		programId: string;
		title: string;
		prompt: string | null;
		reason: string;
		metadata: Record<string, unknown>;
		triggeredAtMs: number;
	}) => Promise<HeartbeatProgramDispatchResult>;
	onTickEvent?: (event: HeartbeatProgramTickEvent) => void | Promise<void>;
};

const HEARTBEAT_PROGRAMS_FILENAME = "heartbeats.jsonl";

function defaultNowMs(): number {
	return Date.now();
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return { ...(value as Record<string, unknown>) };
}

function normalizePrompt(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	if (value.trim().length === 0) {
		return null;
	}
	return value;
}

function normalizeProgram(row: unknown): HeartbeatProgramSnapshot | null {
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		return null;
	}
	const record = row as Record<string, unknown>;
	const programId = typeof record.program_id === "string" ? record.program_id.trim() : "";
	const title = typeof record.title === "string" ? record.title.trim() : "";
	if (!programId || !title) {
		return null;
	}
	const everyMsRaw = record.every_ms;
	const everyMs =
		typeof everyMsRaw === "number" && Number.isFinite(everyMsRaw) ? Math.max(0, Math.trunc(everyMsRaw)) : 0;
	const createdAt =
		typeof record.created_at_ms === "number" && Number.isFinite(record.created_at_ms)
			? Math.trunc(record.created_at_ms)
			: defaultNowMs();
	const updatedAt =
		typeof record.updated_at_ms === "number" && Number.isFinite(record.updated_at_ms)
			? Math.trunc(record.updated_at_ms)
			: createdAt;
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
		prompt: normalizePrompt(record.prompt),
		enabled: record.enabled !== false,
		every_ms: everyMs,
		reason,
		metadata: sanitizeMetadata(record.metadata),
		created_at_ms: createdAt,
		updated_at_ms: updatedAt,
		last_triggered_at_ms: lastTriggeredAt,
		last_result: lastResult,
		last_error: typeof record.last_error === "string" ? record.last_error : null,
	};
}

function sortPrograms(programs: HeartbeatProgramSnapshot[]): HeartbeatProgramSnapshot[] {
	return [...programs].sort((a, b) => {
		if (a.created_at_ms !== b.created_at_ms) {
			return a.created_at_ms - b.created_at_ms;
		}
		return a.program_id.localeCompare(b.program_id);
	});
}

export class HeartbeatProgramRegistry {
	readonly #store: JsonlStore<HeartbeatProgramSnapshot>;
	readonly #heartbeatScheduler: ActivityHeartbeatScheduler;
	readonly #dispatchWake: HeartbeatProgramRegistryOpts["dispatchWake"];
	readonly #onTickEvent: HeartbeatProgramRegistryOpts["onTickEvent"];
	readonly #nowMs: () => number;
	readonly #programs = new Map<string, HeartbeatProgramSnapshot>();
	#loaded: Promise<void> | null = null;

	public constructor(opts: HeartbeatProgramRegistryOpts) {
		this.#heartbeatScheduler = opts.heartbeatScheduler;
		this.#dispatchWake = opts.dispatchWake;
		this.#onTickEvent = opts.onTickEvent;
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#store =
			opts.store ??
			new FsJsonlStore<HeartbeatProgramSnapshot>(join(getStorePaths(opts.repoRoot).storeDir, HEARTBEAT_PROGRAMS_FILENAME));
	}

	#scheduleId(programId: string): string {
		return `heartbeat-program:${programId}`;
	}

	#snapshot(program: HeartbeatProgramSnapshot): HeartbeatProgramSnapshot {
		return {
			...program,
			metadata: { ...program.metadata },
		};
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
		for (const program of this.#programs.values()) {
			this.#applySchedule(program);
		}
	}

	async #persist(): Promise<void> {
		const rows = sortPrograms([...this.#programs.values()]);
		await this.#store.write(rows);
	}

	#applySchedule(program: HeartbeatProgramSnapshot): void {
		const scheduleId = this.#scheduleId(program.program_id);
		if (!program.enabled || program.every_ms <= 0) {
			this.#heartbeatScheduler.unregister(scheduleId);
			return;
		}
		this.#heartbeatScheduler.register({
			activityId: scheduleId,
			everyMs: program.every_ms,
			handler: async ({ reason }): Promise<HeartbeatRunResult> => {
				return await this.#tickProgram(program.program_id, reason ?? undefined);
			},
		});
	}

	async #emitTickEvent(event: HeartbeatProgramTickEvent): Promise<void> {
		if (!this.#onTickEvent) {
			return;
		}
		await this.#onTickEvent(event);
	}

	async #tickProgram(programId: string, reason?: string): Promise<HeartbeatRunResult> {
		const program = this.#programs.get(programId);
		if (!program) {
			return { status: "skipped", reason: "not_found" };
		}
		if (!program.enabled) {
			return { status: "skipped", reason: "disabled" };
		}

		const heartbeatReason = reason?.trim() || program.reason || "scheduled";
		const nowMs = Math.trunc(this.#nowMs());
		program.last_triggered_at_ms = nowMs;
		program.updated_at_ms = nowMs;

		let tickResult: HeartbeatRunResult;
		let eventStatus: HeartbeatProgramTickEvent["status"] = "ok";
		let eventReason: string | null = heartbeatReason;
		let eventMessage = `heartbeat program dispatched wake: ${program.title}`;

		try {
			const result = await this.#dispatchWake({
				programId: program.program_id,
				title: program.title,
				prompt: program.prompt,
				reason: heartbeatReason,
				metadata: { ...program.metadata },
				triggeredAtMs: nowMs,
			});

			if (result.status === "ok") {
				program.last_result = "ok";
				program.last_error = null;
				tickResult = { status: "ran" };
			} else if (result.status === "coalesced") {
				program.last_result = "coalesced";
				program.last_error = null;
				eventStatus = "coalesced";
				eventReason = result.reason ?? "coalesced";
				eventMessage = `heartbeat program coalesced wake: ${program.title}`;
				tickResult = { status: "skipped", reason: "coalesced" };
			} else {
				program.last_result = "failed";
				program.last_error = result.reason;
				eventStatus = "failed";
				eventReason = result.reason;
				eventMessage = `heartbeat program failed: ${program.title}`;
				tickResult = { status: "failed", reason: result.reason };
			}
		} catch (err) {
			program.last_result = "failed";
			program.last_error = err instanceof Error ? err.message : String(err);
			eventStatus = "failed";
			eventReason = program.last_error;
			eventMessage = `heartbeat program failed: ${program.title}`;
			tickResult = { status: "failed", reason: program.last_error };
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

		return tickResult;
	}

	public async list(opts: { enabled?: boolean; limit?: number } = {}): Promise<HeartbeatProgramSnapshot[]> {
		await this.#ensureLoaded();
		const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
		return sortPrograms([...this.#programs.values()])
			.filter((program) => {
				if (typeof opts.enabled === "boolean" && program.enabled !== opts.enabled) {
					return false;
				}
				return true;
			})
			.slice(0, limit)
			.map((program) => this.#snapshot(program));
	}

	public async get(programId: string): Promise<HeartbeatProgramSnapshot | null> {
		await this.#ensureLoaded();
		const program = this.#programs.get(programId.trim());
		return program ? this.#snapshot(program) : null;
	}

	public async create(opts: {
		title: string;
		prompt?: string | null;
		everyMs?: number;
		reason?: string;
		enabled?: boolean;
		metadata?: Record<string, unknown>;
	}): Promise<HeartbeatProgramSnapshot> {
		await this.#ensureLoaded();
		const title = opts.title.trim();
		if (!title) {
			throw new Error("heartbeat_program_title_required");
		}
		const nowMs = Math.trunc(this.#nowMs());
		const program: HeartbeatProgramSnapshot = {
			v: 1,
			program_id: `hb-${crypto.randomUUID().slice(0, 12)}`,
			title,
			prompt: normalizePrompt(opts.prompt),
			enabled: opts.enabled !== false,
			every_ms:
				typeof opts.everyMs === "number" && Number.isFinite(opts.everyMs)
					? Math.max(0, Math.trunc(opts.everyMs))
					: 15_000,
			reason: opts.reason?.trim() || "scheduled",
			metadata: sanitizeMetadata(opts.metadata),
			created_at_ms: nowMs,
			updated_at_ms: nowMs,
			last_triggered_at_ms: null,
			last_result: null,
			last_error: null,
		};
		this.#programs.set(program.program_id, program);
		this.#applySchedule(program);
		await this.#persist();
		return this.#snapshot(program);
	}

	public async update(opts: {
		programId: string;
		title?: string;
		prompt?: string | null;
		everyMs?: number;
		reason?: string;
		enabled?: boolean;
		metadata?: Record<string, unknown>;
	}): Promise<HeartbeatProgramOperationResult> {
		await this.#ensureLoaded();
		const program = this.#programs.get(opts.programId.trim());
		if (!program) {
			return { ok: false, reason: "not_found", program: null };
		}
		if (typeof opts.title === "string") {
			const title = opts.title.trim();
			if (!title) {
				throw new Error("heartbeat_program_title_required");
			}
			program.title = title;
		}
		if ("prompt" in opts) {
			program.prompt = normalizePrompt(opts.prompt);
		}
		if (typeof opts.everyMs === "number" && Number.isFinite(opts.everyMs)) {
			program.every_ms = Math.max(0, Math.trunc(opts.everyMs));
		}
		if (typeof opts.reason === "string") {
			program.reason = opts.reason.trim() || "scheduled";
		}
		if (typeof opts.enabled === "boolean") {
			program.enabled = opts.enabled;
		}
		if (opts.metadata) {
			program.metadata = sanitizeMetadata(opts.metadata);
		}
		program.updated_at_ms = Math.trunc(this.#nowMs());
		this.#applySchedule(program);
		await this.#persist();
		return { ok: true, reason: null, program: this.#snapshot(program) };
	}

	public async remove(programId: string): Promise<HeartbeatProgramOperationResult> {
		await this.#ensureLoaded();
		const normalizedId = programId.trim();
		if (!normalizedId) {
			return { ok: false, reason: "missing_target", program: null };
		}
		const program = this.#programs.get(normalizedId);
		if (!program) {
			return { ok: false, reason: "not_found", program: null };
		}
		this.#heartbeatScheduler.unregister(this.#scheduleId(program.program_id));
		this.#programs.delete(normalizedId);
		await this.#persist();
		return { ok: true, reason: null, program: this.#snapshot(program) };
	}

	public async trigger(opts: {
		programId?: string | null;
		reason?: string | null;
	}): Promise<HeartbeatProgramOperationResult> {
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
		const tick = await this.#tickProgram(program.program_id, opts.reason?.trim() || "manual");
		if (tick.status === "failed") {
			return { ok: false, reason: "failed", program: this.#snapshot(program) };
		}
		return { ok: true, reason: null, program: this.#snapshot(program) };
	}

	public stop(): void {
		for (const program of this.#programs.values()) {
			this.#heartbeatScheduler.unregister(this.#scheduleId(program.program_id));
		}
		this.#programs.clear();
	}
}
