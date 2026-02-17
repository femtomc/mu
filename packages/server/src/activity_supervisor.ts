import { ActivityHeartbeatScheduler, type HeartbeatRunResult } from "./heartbeat_scheduler.js";

export type ControlPlaneActivityStatus = "running" | "completed" | "failed" | "cancelled";

export type ControlPlaneActivitySnapshot = {
	activity_id: string;
	kind: string;
	title: string;
	status: ControlPlaneActivityStatus;
	heartbeat_every_ms: number;
	heartbeat_count: number;
	last_heartbeat_at_ms: number | null;
	last_heartbeat_reason: string | null;
	last_progress: string | null;
	final_message: string | null;
	metadata: Record<string, unknown>;
	source: "api" | "command" | "system";
	started_at_ms: number;
	updated_at_ms: number;
	finished_at_ms: number | null;
};

export type ControlPlaneActivityEventKind =
	| "activity_started"
	| "activity_progress"
	| "activity_heartbeat"
	| "activity_completed"
	| "activity_failed"
	| "activity_cancelled";

export type ControlPlaneActivityEvent = {
	seq: number;
	ts_ms: number;
	kind: ControlPlaneActivityEventKind;
	message: string;
	activity: ControlPlaneActivitySnapshot;
};

export type ControlPlaneActivityMutationResult = {
	ok: boolean;
	reason: "not_found" | "not_running" | "missing_target" | null;
	activity: ControlPlaneActivitySnapshot | null;
};

export type ControlPlaneActivitySupervisorOpts = {
	nowMs?: () => number;
	heartbeatScheduler?: ActivityHeartbeatScheduler;
	defaultHeartbeatEveryMs?: number;
	maxHistory?: number;
	maxEventsPerActivity?: number;
	onEvent?: (event: ControlPlaneActivityEvent) => void | Promise<void>;
};

type InternalActivity = {
	snapshot: ControlPlaneActivitySnapshot;
	events: ControlPlaneActivityEvent[];
};

const DEFAULT_HEARTBEAT_EVERY_MS = 15_000;

function defaultNowMs(): number {
	return Date.now();
}

function normalizeKind(value: string | undefined): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		return "generic";
	}
	return trimmed.toLowerCase();
}

function normalizeTitle(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error("activity_title_required");
	}
	return trimmed;
}

function normalizeHeartbeatEveryMs(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.trunc(value));
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Math.max(0, Number.parseInt(value.trim(), 10));
	}
	return fallback;
}

function toSafeMetadata(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return { ...(value as Record<string, unknown>) };
}

function pushBounded<T>(items: T[], value: T, max: number): void {
	items.push(value);
	if (items.length <= max) {
		return;
	}
	items.splice(0, items.length - max);
}

function elapsedSeconds(snapshot: ControlPlaneActivitySnapshot, nowMs: number): number {
	return Math.max(0, Math.trunc((nowMs - snapshot.started_at_ms) / 1_000));
}

export class ControlPlaneActivitySupervisor {
	readonly #nowMs: () => number;
	readonly #heartbeatScheduler: ActivityHeartbeatScheduler;
	readonly #ownsHeartbeatScheduler: boolean;
	readonly #defaultHeartbeatEveryMs: number;
	readonly #maxHistory: number;
	readonly #maxEventsPerActivity: number;
	readonly #onEvent: ((event: ControlPlaneActivityEvent) => void | Promise<void>) | null;
	readonly #activities = new Map<string, InternalActivity>();
	#seq = 0;
	#counter = 0;

	public constructor(opts: ControlPlaneActivitySupervisorOpts = {}) {
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#heartbeatScheduler = opts.heartbeatScheduler ?? new ActivityHeartbeatScheduler();
		this.#ownsHeartbeatScheduler = !opts.heartbeatScheduler;
		this.#defaultHeartbeatEveryMs = Math.max(
			0,
			Math.trunc(opts.defaultHeartbeatEveryMs ?? DEFAULT_HEARTBEAT_EVERY_MS),
		);
		this.#maxHistory = Math.max(20, Math.trunc(opts.maxHistory ?? 200));
		this.#maxEventsPerActivity = Math.max(20, Math.trunc(opts.maxEventsPerActivity ?? 400));
		this.#onEvent = opts.onEvent ?? null;
	}

	#nextActivityId(): string {
		this.#counter += 1;
		return `activity-${this.#counter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
	}

	#snapshot(activity: InternalActivity): ControlPlaneActivitySnapshot {
		return {
			...activity.snapshot,
			metadata: { ...activity.snapshot.metadata },
		};
	}

	#touch(activity: InternalActivity): void {
		activity.snapshot.updated_at_ms = Math.trunc(this.#nowMs());
	}

	#emit(kind: ControlPlaneActivityEventKind, activity: InternalActivity, message: string): void {
		const event: ControlPlaneActivityEvent = {
			seq: ++this.#seq,
			ts_ms: Math.trunc(this.#nowMs()),
			kind,
			message,
			activity: this.#snapshot(activity),
		};
		pushBounded(activity.events, event, this.#maxEventsPerActivity);
		if (!this.#onEvent) {
			return;
		}
		void Promise.resolve(this.#onEvent(event)).catch(() => {
			// Do not crash on notifier failures.
		});
	}

	#pruneHistory(): void {
		const rows = [...this.#activities.values()].sort((a, b) => {
			if (a.snapshot.started_at_ms !== b.snapshot.started_at_ms) {
				return b.snapshot.started_at_ms - a.snapshot.started_at_ms;
			}
			return a.snapshot.activity_id.localeCompare(b.snapshot.activity_id);
		});
		let kept = 0;
		for (const row of rows) {
			if (row.snapshot.status === "running") {
				kept += 1;
				continue;
			}
			kept += 1;
			if (kept <= this.#maxHistory) {
				continue;
			}
			this.#heartbeatScheduler.unregister(row.snapshot.activity_id);
			this.#activities.delete(row.snapshot.activity_id);
		}
	}

	#resolveActivity(activityIdRaw: string | null | undefined): InternalActivity | null {
		const id = activityIdRaw?.trim() ?? "";
		if (id.length === 0) {
			return null;
		}
		return this.#activities.get(id) ?? null;
	}

	#heartbeatMessage(activity: InternalActivity): string {
		const nowMs = Math.trunc(this.#nowMs());
		const elapsed = elapsedSeconds(activity.snapshot, nowMs);
		const progress = activity.snapshot.last_progress ? ` · ${activity.snapshot.last_progress}` : "";
		return `⏱ ${activity.snapshot.title} running for ${elapsed}s${progress}`;
	}

	#emitHeartbeat(activity: InternalActivity, reason?: string): void {
		activity.snapshot.heartbeat_count += 1;
		activity.snapshot.last_heartbeat_at_ms = Math.trunc(this.#nowMs());
		activity.snapshot.last_heartbeat_reason = reason?.trim() || "requested";
		this.#touch(activity);
		this.#emit("activity_heartbeat", activity, this.#heartbeatMessage(activity));
	}

	#registerHeartbeat(activity: InternalActivity): void {
		if (activity.snapshot.heartbeat_every_ms <= 0) {
			return;
		}
		this.#heartbeatScheduler.register({
			activityId: activity.snapshot.activity_id,
			everyMs: activity.snapshot.heartbeat_every_ms,
			handler: async ({ reason }): Promise<HeartbeatRunResult> => {
				if (activity.snapshot.status !== "running") {
					return { status: "skipped", reason: "not_running" };
				}
				this.#emitHeartbeat(activity, reason);
				return { status: "ran" };
			},
		});
	}

	public start(opts: {
		title: string;
		kind?: string;
		heartbeatEveryMs?: number;
		metadata?: Record<string, unknown>;
		source?: "api" | "command" | "system";
	}): ControlPlaneActivitySnapshot {
		const nowMs = Math.trunc(this.#nowMs());
		const snapshot: ControlPlaneActivitySnapshot = {
			activity_id: this.#nextActivityId(),
			kind: normalizeKind(opts.kind),
			title: normalizeTitle(opts.title),
			status: "running",
			heartbeat_every_ms: normalizeHeartbeatEveryMs(opts.heartbeatEveryMs, this.#defaultHeartbeatEveryMs),
			heartbeat_count: 0,
			last_heartbeat_at_ms: null,
			last_heartbeat_reason: null,
			last_progress: null,
			final_message: null,
			metadata: toSafeMetadata(opts.metadata),
			source: opts.source ?? "api",
			started_at_ms: nowMs,
			updated_at_ms: nowMs,
			finished_at_ms: null,
		};
		const activity: InternalActivity = {
			snapshot,
			events: [],
		};
		this.#activities.set(snapshot.activity_id, activity);
		this.#registerHeartbeat(activity);
		this.#emit("activity_started", activity, `🚀 Started activity ${snapshot.title} (${snapshot.activity_id}).`);
		return this.#snapshot(activity);
	}

	public list(opts: { status?: ControlPlaneActivityStatus; kind?: string; limit?: number } = {}): ControlPlaneActivitySnapshot[] {
		const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
		const kind = opts.kind?.trim().toLowerCase() || null;
		return [...this.#activities.values()]
			.filter((activity) => {
				if (opts.status && activity.snapshot.status !== opts.status) {
					return false;
				}
				if (kind && activity.snapshot.kind !== kind) {
					return false;
				}
				return true;
			})
			.sort((a, b) => {
				if (a.snapshot.started_at_ms !== b.snapshot.started_at_ms) {
					return b.snapshot.started_at_ms - a.snapshot.started_at_ms;
				}
				return a.snapshot.activity_id.localeCompare(b.snapshot.activity_id);
			})
			.slice(0, limit)
			.map((activity) => this.#snapshot(activity));
	}

	public get(activityId: string): ControlPlaneActivitySnapshot | null {
		const activity = this.#resolveActivity(activityId);
		return activity ? this.#snapshot(activity) : null;
	}

	public events(activityId: string, opts: { limit?: number } = {}): ControlPlaneActivityEvent[] | null {
		const activity = this.#resolveActivity(activityId);
		if (!activity) {
			return null;
		}
		const limit = Math.max(1, Math.min(2_000, Math.trunc(opts.limit ?? 200)));
		return activity.events.slice(-limit).map((event) => ({
			...event,
			activity: {
				...event.activity,
				metadata: { ...event.activity.metadata },
			},
		}));
	}

	public progress(opts: { activityId?: string | null; message?: string | null }): ControlPlaneActivityMutationResult {
		const activity = this.#resolveActivity(opts.activityId);
		if (!opts.activityId?.trim()) {
			return { ok: false, reason: "missing_target", activity: null };
		}
		if (!activity) {
			return { ok: false, reason: "not_found", activity: null };
		}
		if (activity.snapshot.status !== "running") {
			return { ok: false, reason: "not_running", activity: this.#snapshot(activity) };
		}
		const message = opts.message?.trim() || "progress updated";
		activity.snapshot.last_progress = message;
		this.#touch(activity);
		this.#emit("activity_progress", activity, `📈 ${message}`);
		return { ok: true, reason: null, activity: this.#snapshot(activity) };
	}

	public heartbeat(opts: {
		activityId?: string | null;
		reason?: string | null;
	}): ControlPlaneActivityMutationResult {
		const activityId = opts.activityId?.trim() || "";
		if (activityId.length === 0) {
			return { ok: false, reason: "missing_target", activity: null };
		}
		const activity = this.#activities.get(activityId) ?? null;
		if (!activity) {
			return { ok: false, reason: "not_found", activity: null };
		}
		if (activity.snapshot.status !== "running") {
			return { ok: false, reason: "not_running", activity: this.#snapshot(activity) };
		}

		const reason = opts.reason?.trim() || "manual";
		if (this.#heartbeatScheduler.has(activityId)) {
			this.#heartbeatScheduler.requestNow(activityId, { reason, coalesceMs: 0 });
		} else {
			this.#emitHeartbeat(activity, reason);
		}
		return { ok: true, reason: null, activity: this.#snapshot(activity) };
	}

	#finish(opts: {
		activityId?: string | null;
		status: "completed" | "failed" | "cancelled";
		message?: string | null;
	}): ControlPlaneActivityMutationResult {
		const activityId = opts.activityId?.trim() || "";
		if (activityId.length === 0) {
			return { ok: false, reason: "missing_target", activity: null };
		}
		const activity = this.#activities.get(activityId) ?? null;
		if (!activity) {
			return { ok: false, reason: "not_found", activity: null };
		}
		if (activity.snapshot.status !== "running") {
			return { ok: false, reason: "not_running", activity: this.#snapshot(activity) };
		}

		activity.snapshot.status = opts.status;
		activity.snapshot.final_message = opts.message?.trim() || null;
		activity.snapshot.finished_at_ms = Math.trunc(this.#nowMs());
		activity.snapshot.updated_at_ms = activity.snapshot.finished_at_ms;
		this.#heartbeatScheduler.unregister(activity.snapshot.activity_id);

		switch (opts.status) {
			case "completed":
				this.#emit(
					"activity_completed",
					activity,
					`✅ Activity completed: ${activity.snapshot.title}${
						activity.snapshot.final_message ? ` · ${activity.snapshot.final_message}` : ""
					}`,
				);
				break;
			case "failed":
				this.#emit(
					"activity_failed",
					activity,
					`❌ Activity failed: ${activity.snapshot.title}${
						activity.snapshot.final_message ? ` · ${activity.snapshot.final_message}` : ""
					}`,
				);
				break;
			case "cancelled":
				this.#emit(
					"activity_cancelled",
					activity,
					`🛑 Activity cancelled: ${activity.snapshot.title}${
						activity.snapshot.final_message ? ` · ${activity.snapshot.final_message}` : ""
					}`,
				);
				break;
		}

		this.#pruneHistory();
		return { ok: true, reason: null, activity: this.#snapshot(activity) };
	}

	public complete(opts: { activityId?: string | null; message?: string | null }): ControlPlaneActivityMutationResult {
		return this.#finish({ ...opts, status: "completed" });
	}

	public fail(opts: { activityId?: string | null; message?: string | null }): ControlPlaneActivityMutationResult {
		return this.#finish({ ...opts, status: "failed" });
	}

	public cancel(opts: { activityId?: string | null; message?: string | null }): ControlPlaneActivityMutationResult {
		return this.#finish({ ...opts, status: "cancelled" });
	}

	public stop(): void {
		for (const activity of this.#activities.values()) {
			this.#heartbeatScheduler.unregister(activity.snapshot.activity_id);
		}
		if (this.#ownsHeartbeatScheduler) {
			this.#heartbeatScheduler.stop();
		}
		this.#activities.clear();
	}
}
