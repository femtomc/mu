import { join } from "node:path";
import type { JsonlStore } from "@femtomc/mu-core";
import { FsJsonlStore, getStorePaths } from "@femtomc/mu-core/node";
import {
	INTER_ROOT_QUEUE_RECONCILE_INVARIANTS,
	ORCHESTRATION_QUEUE_ALLOWED_TRANSITIONS,
	reconcileInterRootQueue,
	type InterRootQueuePolicy,
	type InterRootQueueReconcilePlan,
	type OrchestrationQueueState,
} from "./orchestration_queue.js";
import type { ControlPlaneRunMode, ControlPlaneRunSnapshot, ControlPlaneRunStatus } from "./run_supervisor.js";

const RUN_QUEUE_FILENAME = "run_queue.jsonl";
const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_OPERATION_IDS = 128;

const TERMINAL_QUEUE_STATES = new Set<OrchestrationQueueState>(["done", "failed", "cancelled"]);
const RUNNING_QUEUE_STATES = new Set<OrchestrationQueueState>(["queued", "active", "waiting_review", "refining"]);
const RUN_QUEUE_STATE_VALUES: readonly OrchestrationQueueState[] = [
	"queued",
	"active",
	"waiting_review",
	"refining",
	"done",
	"failed",
	"cancelled",
] as const;
const RUN_MODE_VALUES: readonly ControlPlaneRunMode[] = ["run_start", "run_resume"] as const;
const RUN_SOURCE_VALUES = ["command", "api"] as const;

export type DurableRunQueueState = OrchestrationQueueState;

export type DurableRunQueueSnapshot = {
	v: 1;
	queue_id: string;
	dedupe_key: string;
	mode: ControlPlaneRunMode;
	state: DurableRunQueueState;
	prompt: string | null;
	root_issue_id: string | null;
	max_steps: number;
	command_id: string | null;
	source: "command" | "api";
	job_id: string | null;
	started_at_ms: number | null;
	updated_at_ms: number;
	finished_at_ms: number | null;
	exit_code: number | null;
	pid: number | null;
	last_progress: string | null;
	created_at_ms: number;
	revision: number;
	applied_operation_ids: string[];
};

export type DurableRunQueueOpts = {
	repoRoot: string;
	nowMs?: () => number;
	store?: JsonlStore<unknown>;
	maxOperationIds?: number;
};

export type DurableRunQueueEnqueueOpts = {
	mode: ControlPlaneRunMode;
	prompt: string | null;
	rootIssueId: string | null;
	maxSteps?: number;
	commandId?: string | null;
	source: "command" | "api";
	dedupeKey: string;
	operationId?: string | null;
	nowMs?: number;
};

export type DurableRunQueueTransitionOpts = {
	queueId: string;
	toState: DurableRunQueueState;
	operationId?: string | null;
	nowMs?: number;
};

export type DurableRunQueueClaimOpts = {
	queueId?: string | null;
	operationId?: string | null;
	nowMs?: number;
};

function defaultNowMs(): number {
	return Date.now();
}

function normalizeOperationId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeRunMode(value: unknown): ControlPlaneRunMode | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim().toLowerCase();
	if (RUN_MODE_VALUES.includes(trimmed as ControlPlaneRunMode)) {
		return trimmed as ControlPlaneRunMode;
	}
	return null;
}

function normalizeRunSource(value: unknown): "command" | "api" {
	if (typeof value !== "string") {
		return "api";
	}
	const trimmed = value.trim().toLowerCase();
	return RUN_SOURCE_VALUES.includes(trimmed as (typeof RUN_SOURCE_VALUES)[number])
		? (trimmed as "command" | "api")
		: "api";
}

function normalizeQueueState(value: unknown): DurableRunQueueState | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim().toLowerCase().replaceAll("-", "_");
	if (RUN_QUEUE_STATE_VALUES.includes(normalized as DurableRunQueueState)) {
		return normalized as DurableRunQueueState;
	}
	return null;
}

function normalizeIssueId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!/^mu-[a-z0-9][a-z0-9-]*$/i.test(trimmed)) {
		return null;
	}
	return trimmed.toLowerCase();
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizePrompt(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeMaxSteps(value: unknown, fallback: number = DEFAULT_MAX_STEPS): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(1, Math.trunc(value));
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Math.max(1, Number.parseInt(value, 10));
	}
	return Math.max(1, Math.trunc(fallback));
}

function normalizeTimestamp(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	return Math.trunc(fallback);
}

function normalizeNullableTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	return null;
}

function normalizeNullableInt(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	return null;
}

function normalizeAppliedOperationIds(value: unknown, max: number): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		const opId = normalizeOperationId(item);
		if (!opId) {
			continue;
		}
		if (out.includes(opId)) {
			continue;
		}
		out.push(opId);
		if (out.length >= max) {
			break;
		}
	}
	return out;
}

function canTransition(from: DurableRunQueueState, to: DurableRunQueueState): boolean {
	if (from === to) {
		return true;
	}
	return ORCHESTRATION_QUEUE_ALLOWED_TRANSITIONS[from].includes(to);
}

function isTerminalState(state: DurableRunQueueState): boolean {
	return TERMINAL_QUEUE_STATES.has(state);
}

function queueStateFromRunStatus(status: ControlPlaneRunStatus): DurableRunQueueState {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "running":
		default:
			return "active";
	}
}

export function runStatusFromQueueState(state: DurableRunQueueState): ControlPlaneRunStatus {
	switch (state) {
		case "done":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "queued":
		case "active":
		case "waiting_review":
		case "refining":
		default:
			return "running";
	}
}

export function queueStatesForRunStatusFilter(status: string | null | undefined): DurableRunQueueState[] | null {
	if (typeof status !== "string") {
		return null;
	}
	const normalized = status.trim().toLowerCase().replaceAll("-", "_");
	if (normalized.length === 0) {
		return null;
	}
	if (normalized === "running") {
		return [...RUNNING_QUEUE_STATES];
	}
	if (normalized === "completed") {
		return ["done"];
	}
	if (normalized === "done") {
		return ["done"];
	}
	if (normalized === "failed") {
		return ["failed"];
	}
	if (normalized === "cancelled") {
		return ["cancelled"];
	}
	if (
		normalized === "waiting_review" ||
		normalized === "refining" ||
		normalized === "queued" ||
		normalized === "active"
	) {
		return [normalized as DurableRunQueueState];
	}
	return [];
}

export type RunQueueReconcilePlan = InterRootQueueReconcilePlan;

export const RUN_QUEUE_RECONCILE_INVARIANTS = INTER_ROOT_QUEUE_RECONCILE_INVARIANTS;

/**
 * Server adapter wrapper around the orchestrator-owned inter-root planner.
 */
export function reconcileRunQueue(
	rows: readonly DurableRunQueueSnapshot[],
	policy: InterRootQueuePolicy,
): RunQueueReconcilePlan {
	return reconcileInterRootQueue(rows, policy);
}

export function runQueuePath(repoRoot: string): string {
	return join(getStorePaths(repoRoot).storeDir, "control-plane", RUN_QUEUE_FILENAME);
}

function stableCompare(a: DurableRunQueueSnapshot, b: DurableRunQueueSnapshot): number {
	if (a.created_at_ms !== b.created_at_ms) {
		return a.created_at_ms - b.created_at_ms;
	}
	return a.queue_id.localeCompare(b.queue_id);
}

function chooseLatest(a: DurableRunQueueSnapshot, b: DurableRunQueueSnapshot): DurableRunQueueSnapshot {
	if (a.updated_at_ms !== b.updated_at_ms) {
		return a.updated_at_ms > b.updated_at_ms ? a : b;
	}
	if (a.revision !== b.revision) {
		return a.revision > b.revision ? a : b;
	}
	return a.queue_id.localeCompare(b.queue_id) >= 0 ? a : b;
}

function snapshotClone(value: DurableRunQueueSnapshot): DurableRunQueueSnapshot {
	return {
		...value,
		applied_operation_ids: [...value.applied_operation_ids],
	};
}

function normalizeRunStatus(value: unknown): ControlPlaneRunStatus | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "running" || normalized === "completed" || normalized === "failed" || normalized === "cancelled") {
		return normalized as ControlPlaneRunStatus;
	}
	return null;
}

function normalizeQueueRecordRow(row: unknown, nowMs: number, maxOperationIds: number): DurableRunQueueSnapshot | null {
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		return null;
	}
	const record = row as Record<string, unknown>;

	const queueId = normalizeString(record.queue_id);
	const mode = normalizeRunMode(record.mode);
	const state = normalizeQueueState(record.state);

	if (!queueId || !mode || !state) {
		return null;
	}

	const createdAt = normalizeTimestamp(record.created_at_ms, nowMs);
	const updatedAt = normalizeTimestamp(record.updated_at_ms, createdAt);
	const revision = Math.max(1, normalizeMaxSteps(record.revision, 1));
	const dedupeKey = normalizeString(record.dedupe_key) ?? `queue:${queueId}`;
	const prompt = normalizePrompt(record.prompt);
	const rootIssueId = normalizeIssueId(record.root_issue_id);

	return {
		v: 1,
		queue_id: queueId,
		dedupe_key: dedupeKey,
		mode,
		state,
		prompt,
		root_issue_id: rootIssueId,
		max_steps: normalizeMaxSteps(record.max_steps, DEFAULT_MAX_STEPS),
		command_id: normalizeString(record.command_id),
		source: normalizeRunSource(record.source),
		job_id: normalizeString(record.job_id),
		started_at_ms: normalizeNullableTimestamp(record.started_at_ms),
		updated_at_ms: updatedAt,
		finished_at_ms: normalizeNullableTimestamp(record.finished_at_ms),
		exit_code: normalizeNullableInt(record.exit_code),
		pid: normalizeNullableInt(record.pid),
		last_progress: normalizeString(record.last_progress),
		created_at_ms: createdAt,
		revision,
		applied_operation_ids: normalizeAppliedOperationIds(record.applied_operation_ids, maxOperationIds),
	};
}

function queueSnapshotFromRunSnapshotRecord(row: unknown, nowMs: number): DurableRunQueueSnapshot | null {
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		return null;
	}
	const record = row as Record<string, unknown>;
	const mode = normalizeRunMode(record.mode);
	const status = normalizeRunStatus(record.status);
	const jobId = normalizeString(record.job_id);
	if (!mode || !status || !jobId) {
		return null;
	}

	const createdAt = normalizeTimestamp(record.started_at_ms, nowMs);
	const updatedAt = normalizeTimestamp(record.updated_at_ms, createdAt);
	const queueId = normalizeString(record.queue_id) ?? `rq-sync-${jobId}`;

	return {
		v: 1,
		queue_id: queueId,
		dedupe_key: `runtime:${jobId}`,
		mode,
		state: queueStateFromRunStatus(status),
		prompt: normalizePrompt(record.prompt),
		root_issue_id: normalizeIssueId(record.root_issue_id),
		max_steps: normalizeMaxSteps(record.max_steps, DEFAULT_MAX_STEPS),
		command_id: normalizeString(record.command_id),
		source: normalizeRunSource(record.source),
		job_id: jobId,
		started_at_ms: normalizeNullableTimestamp(record.started_at_ms),
		updated_at_ms: updatedAt,
		finished_at_ms: normalizeNullableTimestamp(record.finished_at_ms),
		exit_code: normalizeNullableInt(record.exit_code),
		pid: normalizeNullableInt(record.pid),
		last_progress: normalizeString(record.last_progress),
		created_at_ms: createdAt,
		revision: 1,
		applied_operation_ids: [],
	};
}

function mergeQueueAndRunSnapshot(
	queue: DurableRunQueueSnapshot,
	run: ControlPlaneRunSnapshot | null,
): ControlPlaneRunSnapshot {
	const status = runStatusFromQueueState(queue.state);
	const startedAt = queue.started_at_ms ?? queue.created_at_ms;
	const runtimeUpdatedAt = run?.updated_at_ms ?? 0;
	const updatedAt = Math.max(queue.updated_at_ms, runtimeUpdatedAt);
	const base: ControlPlaneRunSnapshot = {
		job_id: queue.job_id ?? queue.queue_id,
		mode: queue.mode,
		status,
		prompt: queue.prompt,
		root_issue_id: queue.root_issue_id,
		max_steps: queue.max_steps,
		command_id: queue.command_id,
		source: queue.source,
		started_at_ms: startedAt,
		updated_at_ms: updatedAt,
		finished_at_ms: queue.finished_at_ms,
		exit_code: queue.exit_code,
		pid: queue.pid,
		last_progress: queue.last_progress,
		queue_id: queue.queue_id,
		queue_state: queue.state,
	};
	if (!run) {
		return base;
	}
	return {
		...base,
		pid: run.pid ?? base.pid,
		last_progress: run.last_progress ?? base.last_progress,
		exit_code: run.exit_code ?? base.exit_code,
		finished_at_ms: run.finished_at_ms ?? base.finished_at_ms,
		updated_at_ms: Math.max(base.updated_at_ms, run.updated_at_ms),
	};
}

export function runSnapshotFromQueueSnapshot(
	queue: DurableRunQueueSnapshot,
	runtime: ControlPlaneRunSnapshot | null = null,
): ControlPlaneRunSnapshot {
	return mergeQueueAndRunSnapshot(queue, runtime);
}

export class DurableRunQueue {
	readonly #store: JsonlStore<unknown>;
	readonly #nowMs: () => number;
	readonly #maxOperationIds: number;
	readonly #rowsById = new Map<string, DurableRunQueueSnapshot>();
	readonly #idByDedupeKey = new Map<string, string>();
	readonly #idByJobId = new Map<string, string>();
	readonly #idsByRootIssueId = new Map<string, Set<string>>();
	#loaded: Promise<void> | null = null;
	#tail: Promise<void> = Promise.resolve();

	public constructor(opts: DurableRunQueueOpts) {
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#maxOperationIds = Math.max(8, Math.trunc(opts.maxOperationIds ?? DEFAULT_MAX_OPERATION_IDS));
		this.#store = opts.store ?? new FsJsonlStore<DurableRunQueueSnapshot>(runQueuePath(opts.repoRoot));
	}

	async #runSerialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(fn, fn);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return await run;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			this.#loaded = this.#load();
		}
		await this.#loaded;
	}

	#rebuildIndexes(): void {
		this.#idByDedupeKey.clear();
		this.#idByJobId.clear();
		this.#idsByRootIssueId.clear();
		for (const row of this.#rowsById.values()) {
			this.#idByDedupeKey.set(row.dedupe_key, row.queue_id);
			if (row.job_id) {
				this.#idByJobId.set(row.job_id, row.queue_id);
			}
			if (row.root_issue_id) {
				const set = this.#idsByRootIssueId.get(row.root_issue_id) ?? new Set<string>();
				set.add(row.queue_id);
				this.#idsByRootIssueId.set(row.root_issue_id, set);
			}
		}
	}

	#replaceRow(next: DurableRunQueueSnapshot): void {
		this.#rowsById.set(next.queue_id, next);
		this.#rebuildIndexes();
	}

	#allRowsSorted(): DurableRunQueueSnapshot[] {
		return [...this.#rowsById.values()].sort(stableCompare);
	}

	#latestByRootIssueId(rootIssueId: string, preferRunning: boolean): DurableRunQueueSnapshot | null {
		const set = this.#idsByRootIssueId.get(rootIssueId);
		if (!set || set.size === 0) {
			return null;
		}
		const candidates: DurableRunQueueSnapshot[] = [];
		for (const queueId of set) {
			const row = this.#rowsById.get(queueId);
			if (row) {
				candidates.push(row);
			}
		}
		if (candidates.length === 0) {
			return null;
		}
		const running = preferRunning ? candidates.filter((row) => RUNNING_QUEUE_STATES.has(row.state)) : [];
		const pool = running.length > 0 ? running : candidates;
		return pool.reduce<DurableRunQueueSnapshot | null>((best, row) => {
			if (!best) {
				return row;
			}
			if (row.updated_at_ms !== best.updated_at_ms) {
				return row.updated_at_ms > best.updated_at_ms ? row : best;
			}
			return row.queue_id.localeCompare(best.queue_id) > 0 ? row : best;
		}, null);
	}

	#rememberOperation(row: DurableRunQueueSnapshot, operationId: string | null): void {
		if (!operationId) {
			return;
		}
		if (row.applied_operation_ids.includes(operationId)) {
			return;
		}
		row.applied_operation_ids.push(operationId);
		if (row.applied_operation_ids.length <= this.#maxOperationIds) {
			return;
		}
		row.applied_operation_ids.splice(0, row.applied_operation_ids.length - this.#maxOperationIds);
	}

	#isOperationReplay(row: DurableRunQueueSnapshot, operationId: string | null): boolean {
		if (!operationId) {
			return false;
		}
		return row.applied_operation_ids.includes(operationId);
	}

	async #load(): Promise<void> {
		const rows = await this.#store.read();
		const byId = new Map<string, DurableRunQueueSnapshot>();
		const nowMs = Math.trunc(this.#nowMs());
		for (const row of rows) {
			const normalized = normalizeQueueRecordRow(row, nowMs, this.#maxOperationIds);
			if (!normalized) {
				continue;
			}
			const existing = byId.get(normalized.queue_id);
			if (!existing) {
				byId.set(normalized.queue_id, normalized);
				continue;
			}
			byId.set(normalized.queue_id, chooseLatest(existing, normalized));
		}

		this.#rowsById.clear();
		for (const row of byId.values()) {
			this.#rowsById.set(row.queue_id, row);
		}
		this.#rebuildIndexes();
	}

	async #persist(): Promise<void> {
		const rows = this.#allRowsSorted().map((row) => snapshotClone(row));
		await this.#store.write(rows);
	}

	#newQueueId(): string {
		return `rq-${crypto.randomUUID().slice(0, 12)}`;
	}

	#applyRunSnapshot(
		row: DurableRunQueueSnapshot,
		run: ControlPlaneRunSnapshot,
		nowMs: number,
		operationId: string | null,
	): DurableRunQueueSnapshot {
		if (this.#isOperationReplay(row, operationId)) {
			return row;
		}

		const next = snapshotClone(row);
		let changed = false;
		const targetState = queueStateFromRunStatus(run.status);

		if (next.state !== targetState) {
			if (canTransition(next.state, targetState)) {
				next.state = targetState;
				changed = true;
			}
		}

		if (next.mode !== run.mode) {
			next.mode = run.mode;
			changed = true;
		}

		const prompt = normalizePrompt(run.prompt);
		if (next.prompt !== prompt) {
			next.prompt = prompt;
			changed = true;
		}

		const rootIssueId = normalizeIssueId(run.root_issue_id);
		if (rootIssueId && next.root_issue_id !== rootIssueId) {
			next.root_issue_id = rootIssueId;
			changed = true;
		}

		const maxSteps = normalizeMaxSteps(run.max_steps, next.max_steps || DEFAULT_MAX_STEPS);
		if (next.max_steps !== maxSteps) {
			next.max_steps = maxSteps;
			changed = true;
		}

		const commandId = normalizeString(run.command_id);
		if (next.command_id !== commandId) {
			next.command_id = commandId;
			changed = true;
		}

		if (next.source !== run.source) {
			next.source = run.source;
			changed = true;
		}

		const jobId = normalizeString(run.job_id);
		if (jobId && next.job_id !== jobId) {
			next.job_id = jobId;
			changed = true;
		}

		const startedAt = normalizeNullableTimestamp(run.started_at_ms);
		if (startedAt != null && next.started_at_ms !== startedAt) {
			next.started_at_ms = startedAt;
			changed = true;
		}

		const updatedAt = Math.max(next.updated_at_ms, normalizeTimestamp(run.updated_at_ms, nowMs), nowMs);
		if (updatedAt !== next.updated_at_ms) {
			next.updated_at_ms = updatedAt;
			changed = true;
		}

		const finishedAt = normalizeNullableTimestamp(run.finished_at_ms);
		if (finishedAt !== next.finished_at_ms) {
			next.finished_at_ms = finishedAt;
			changed = true;
		}

		const exitCode = normalizeNullableInt(run.exit_code);
		if (exitCode !== next.exit_code) {
			next.exit_code = exitCode;
			changed = true;
		}

		const pid = normalizeNullableInt(run.pid);
		if (pid !== next.pid) {
			next.pid = pid;
			changed = true;
		}

		const progress = normalizeString(run.last_progress);
		if (progress !== next.last_progress) {
			next.last_progress = progress;
			changed = true;
		}

		if (isTerminalState(next.state) && next.finished_at_ms == null) {
			next.finished_at_ms = nowMs;
			changed = true;
		}

		if (!changed && !operationId) {
			return row;
		}

		next.revision = next.revision + 1;
		this.#rememberOperation(next, operationId);
		return next;
	}

	#findByAnyId(idOrRoot: string): DurableRunQueueSnapshot | null {
		const trimmed = idOrRoot.trim();
		if (!trimmed) {
			return null;
		}
		const byQueueId = this.#rowsById.get(trimmed);
		if (byQueueId) {
			return byQueueId;
		}
		const byJobId = this.#idByJobId.get(trimmed);
		if (byJobId) {
			return this.#rowsById.get(byJobId) ?? null;
		}
		const normalizedRoot = normalizeIssueId(trimmed);
		if (!normalizedRoot) {
			return null;
		}
		return this.#latestByRootIssueId(normalizedRoot, false);
	}

	public async enqueue(opts: DurableRunQueueEnqueueOpts): Promise<DurableRunQueueSnapshot> {
		return await this.#runSerialized(async () => {
			await this.#ensureLoaded();
			const dedupeKey = normalizeString(opts.dedupeKey);
			if (!dedupeKey) {
				throw new Error("run_queue_dedupe_key_required");
			}
			const operationId = normalizeOperationId(opts.operationId);
			const existingId = this.#idByDedupeKey.get(dedupeKey);
			if (existingId) {
				const existing = this.#rowsById.get(existingId);
				if (!existing) {
					throw new Error("run_queue_internal_missing_existing_record");
				}
				return snapshotClone(existing);
			}

			const mode = normalizeRunMode(opts.mode);
			if (!mode) {
				throw new Error("run_queue_invalid_mode");
			}

			const nowMs = normalizeTimestamp(opts.nowMs, this.#nowMs());
			const row: DurableRunQueueSnapshot = {
				v: 1,
				queue_id: this.#newQueueId(),
				dedupe_key: dedupeKey,
				mode,
				state: "queued",
				prompt: normalizePrompt(opts.prompt),
				root_issue_id: normalizeIssueId(opts.rootIssueId),
				max_steps: normalizeMaxSteps(opts.maxSteps, DEFAULT_MAX_STEPS),
				command_id: normalizeString(opts.commandId),
				source: normalizeRunSource(opts.source),
				job_id: null,
				started_at_ms: null,
				updated_at_ms: nowMs,
				finished_at_ms: null,
				exit_code: null,
				pid: null,
				last_progress: null,
				created_at_ms: nowMs,
				revision: 1,
				applied_operation_ids: [],
			};
			this.#rememberOperation(row, operationId);
			this.#replaceRow(row);
			await this.#persist();
			return snapshotClone(row);
		});
	}

	public async claim(opts: DurableRunQueueClaimOpts = {}): Promise<DurableRunQueueSnapshot | null> {
		return await this.#runSerialized(async () => {
			await this.#ensureLoaded();
			const operationId = normalizeOperationId(opts.operationId);
			const nowMs = normalizeTimestamp(opts.nowMs, this.#nowMs());
			const queueId = normalizeString(opts.queueId);

			const row =
				(queueId ? this.#rowsById.get(queueId) : null) ??
				this.#allRowsSorted().find((candidate) => candidate.state === "queued") ??
				null;
			if (!row) {
				return null;
			}
			if (row.state !== "queued") {
				if (row.state === "active") {
					return snapshotClone(row);
				}
				return null;
			}

			if (this.#isOperationReplay(row, operationId)) {
				return snapshotClone(row);
			}

			const next = snapshotClone(row);
			next.state = "active";
			next.updated_at_ms = nowMs;
			next.started_at_ms = next.started_at_ms ?? nowMs;
			next.revision += 1;
			this.#rememberOperation(next, operationId);
			this.#replaceRow(next);
			await this.#persist();
			return snapshotClone(next);
		});
	}

	public async activate(opts: DurableRunQueueClaimOpts): Promise<DurableRunQueueSnapshot | null> {
		return await this.claim(opts);
	}

	public async transition(opts: DurableRunQueueTransitionOpts): Promise<DurableRunQueueSnapshot> {
		return await this.#runSerialized(async () => {
			await this.#ensureLoaded();
			const queueId = normalizeString(opts.queueId);
			if (!queueId) {
				throw new Error("run_queue_missing_queue_id");
			}
			const row = this.#rowsById.get(queueId);
			if (!row) {
				throw new Error("run_queue_not_found");
			}
			const operationId = normalizeOperationId(opts.operationId);
			if (this.#isOperationReplay(row, operationId)) {
				return snapshotClone(row);
			}

			const toState = normalizeQueueState(opts.toState);
			if (!toState) {
				throw new Error("run_queue_invalid_state");
			}
			if (!canTransition(row.state, toState)) {
				throw new Error(`invalid_run_queue_transition:${row.state}->${toState}`);
			}

			if (row.state === toState && !operationId) {
				return snapshotClone(row);
			}

			const nowMs = normalizeTimestamp(opts.nowMs, this.#nowMs());
			const next = snapshotClone(row);
			next.state = toState;
			next.updated_at_ms = nowMs;
			if (toState === "active" && next.started_at_ms == null) {
				next.started_at_ms = nowMs;
			}
			if (isTerminalState(toState) && next.finished_at_ms == null) {
				next.finished_at_ms = nowMs;
			}
			next.revision += 1;
			this.#rememberOperation(next, operationId);
			this.#replaceRow(next);
			await this.#persist();
			return snapshotClone(next);
		});
	}

	public async bindRunSnapshot(opts: {
		queueId: string;
		run: ControlPlaneRunSnapshot;
		operationId?: string | null;
		nowMs?: number;
	}): Promise<DurableRunQueueSnapshot> {
		return await this.#runSerialized(async () => {
			await this.#ensureLoaded();
			const queueId = normalizeString(opts.queueId);
			if (!queueId) {
				throw new Error("run_queue_missing_queue_id");
			}
			const row = this.#rowsById.get(queueId);
			if (!row) {
				throw new Error("run_queue_not_found");
			}
			const nowMs = normalizeTimestamp(opts.nowMs, this.#nowMs());
			const operationId = normalizeOperationId(opts.operationId);
			const next = this.#applyRunSnapshot(row, opts.run, nowMs, operationId);
			if (next === row) {
				return snapshotClone(row);
			}
			this.#replaceRow(next);
			await this.#persist();
			return snapshotClone(next);
		});
	}

	public async applyRunSnapshot(opts: {
		run: ControlPlaneRunSnapshot;
		queueId?: string | null;
		operationId?: string | null;
		nowMs?: number;
		createIfMissing?: boolean;
	}): Promise<DurableRunQueueSnapshot | null> {
		return await this.#runSerialized(async () => {
			await this.#ensureLoaded();
			const nowMs = normalizeTimestamp(opts.nowMs, this.#nowMs());
			const operationId = normalizeOperationId(opts.operationId);
			const queueId = normalizeString(opts.queueId);

			let row: DurableRunQueueSnapshot | null = null;
			if (queueId) {
				row = this.#rowsById.get(queueId) ?? null;
			}
			if (!row) {
				const jobId = normalizeString(opts.run.job_id);
				if (jobId) {
					const existingQueueId = this.#idByJobId.get(jobId);
					if (existingQueueId) {
						row = this.#rowsById.get(existingQueueId) ?? null;
					}
				}
			}
			if (!row) {
				const rootIssueId = normalizeIssueId(opts.run.root_issue_id);
				if (rootIssueId) {
					row = this.#latestByRootIssueId(rootIssueId, opts.run.status === "running");
				}
			}

			if (!row && opts.createIfMissing) {
				const next = queueSnapshotFromRunSnapshotRecord(opts.run as unknown, nowMs);
				if (!next) {
					return null;
				}
				if (operationId) {
					this.#rememberOperation(next, operationId);
					next.revision += 1;
				}
				this.#replaceRow(next);
				await this.#persist();
				return snapshotClone(next);
			}
			if (!row) {
				return null;
			}

			const next = this.#applyRunSnapshot(row, opts.run, nowMs, operationId);
			if (next === row) {
				return snapshotClone(row);
			}
			this.#replaceRow(next);
			await this.#persist();
			return snapshotClone(next);
		});
	}

	public async get(idOrRoot: string): Promise<DurableRunQueueSnapshot | null> {
		await this.#ensureLoaded();
		const row = this.#findByAnyId(idOrRoot);
		return row ? snapshotClone(row) : null;
	}

	public async list(
		opts: { states?: readonly DurableRunQueueState[]; limit?: number } = {},
	): Promise<DurableRunQueueSnapshot[]> {
		await this.#ensureLoaded();
		const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
		const stateFilter =
			opts.states && opts.states.length > 0
				? new Set(opts.states.filter((state) => RUN_QUEUE_STATE_VALUES.includes(state as DurableRunQueueState)))
				: null;
		const rows = this.#allRowsSorted().filter((row) => {
			if (!stateFilter) {
				return true;
			}
			return stateFilter.has(row.state);
		});
		return rows
			.slice(-limit)
			.reverse()
			.map((row) => snapshotClone(row));
	}

	public async listRunSnapshots(
		opts: { status?: string; limit?: number; runtimeByJobId?: Map<string, ControlPlaneRunSnapshot> } = {},
	): Promise<ControlPlaneRunSnapshot[]> {
		const queueStates = queueStatesForRunStatusFilter(opts.status);
		if (Array.isArray(queueStates) && queueStates.length === 0) {
			return [];
		}
		const rows = await this.list({ states: queueStates ?? undefined, limit: opts.limit });
		return rows.map((row) => {
			const runtime = row.job_id ? (opts.runtimeByJobId?.get(row.job_id) ?? null) : null;
			return runSnapshotFromQueueSnapshot(row, runtime);
		});
	}
}
