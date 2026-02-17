export type HeartbeatRunResult =
	| { status: "ran"; durationMs?: number }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

export type HeartbeatTickHandler = (opts: {
	activityId: string;
	reason?: string;
}) => Promise<HeartbeatRunResult> | HeartbeatRunResult;

export type ActivityHeartbeatSchedulerOpts = {
	nowMs?: () => number;
	defaultCoalesceMs?: number;
	retryMs?: number;
	minIntervalMs?: number;
};

type WakeTimerKind = "normal" | "retry";

type PendingWakeReason = {
	reason: string;
	priority: number;
	requestedAt: number;
};

type ActivityState = {
	activityId: string;
	everyMs: number;
	coalesceMs: number;
	handler: HeartbeatTickHandler;
	pendingWake: PendingWakeReason | null;
	scheduled: boolean;
	running: boolean;
	intervalTimer: ReturnType<typeof setInterval> | null;
	wakeTimer: ReturnType<typeof setTimeout> | null;
	wakeDueAt: number | null;
	wakeKind: WakeTimerKind | null;
};

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MIN_INTERVAL_MS = 2_000;
const HOOK_REASON_PREFIX = "hook:";

const REASON_PRIORITY = {
	RETRY: 0,
	INTERVAL: 1,
	DEFAULT: 2,
	ACTION: 3,
} as const;

function defaultNowMs(): number {
	return Date.now();
}

function normalizeActivityId(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error("activity_id_required");
	}
	return trimmed;
}

function normalizeReason(reason?: string): string {
	if (typeof reason !== "string") {
		return "requested";
	}
	const trimmed = reason.trim();
	return trimmed.length > 0 ? trimmed : "requested";
}

function isActionReason(reason: string): boolean {
	if (reason === "manual" || reason === "exec-event") {
		return true;
	}
	return reason.startsWith(HOOK_REASON_PREFIX);
}

function resolveReasonPriority(reason: string): number {
	if (reason === "retry") {
		return REASON_PRIORITY.RETRY;
	}
	if (reason === "interval") {
		return REASON_PRIORITY.INTERVAL;
	}
	if (isActionReason(reason)) {
		return REASON_PRIORITY.ACTION;
	}
	return REASON_PRIORITY.DEFAULT;
}

function toMs(value: number | undefined, fallback: number, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.trunc(value));
}

export class ActivityHeartbeatScheduler {
	readonly #states = new Map<string, ActivityState>();
	readonly #nowMs: () => number;
	readonly #defaultCoalesceMs: number;
	readonly #retryMs: number;
	readonly #minIntervalMs: number;

	public constructor(opts: ActivityHeartbeatSchedulerOpts = {}) {
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#defaultCoalesceMs = Math.max(0, Math.trunc(opts.defaultCoalesceMs ?? DEFAULT_COALESCE_MS));
		this.#retryMs = Math.max(100, Math.trunc(opts.retryMs ?? DEFAULT_RETRY_MS));
		this.#minIntervalMs = Math.max(100, Math.trunc(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
	}

	#clearWakeTimer(state: ActivityState): void {
		if (state.wakeTimer) {
			clearTimeout(state.wakeTimer);
			state.wakeTimer = null;
		}
		state.wakeDueAt = null;
		state.wakeKind = null;
	}

	#disposeState(state: ActivityState): void {
		if (state.intervalTimer) {
			clearInterval(state.intervalTimer);
			state.intervalTimer = null;
		}
		this.#clearWakeTimer(state);
		state.pendingWake = null;
		state.running = false;
		state.scheduled = false;
	}

	#queuePendingWakeReason(state: ActivityState, reason?: string): void {
		const normalized = normalizeReason(reason);
		const next: PendingWakeReason = {
			reason: normalized,
			priority: resolveReasonPriority(normalized),
			requestedAt: this.#nowMs(),
		};
		if (!state.pendingWake) {
			state.pendingWake = next;
			return;
		}
		if (next.priority > state.pendingWake.priority) {
			state.pendingWake = next;
			return;
		}
		if (next.priority === state.pendingWake.priority && next.requestedAt >= state.pendingWake.requestedAt) {
			state.pendingWake = next;
		}
	}

	#schedule(state: ActivityState, coalesceMs: number, kind: WakeTimerKind = "normal"): void {
		const delay = Math.max(0, Math.trunc(Number.isFinite(coalesceMs) ? coalesceMs : this.#defaultCoalesceMs));
		const dueAt = this.#nowMs() + delay;
		if (state.wakeTimer) {
			// Retry cooldown should remain in force.
			if (state.wakeKind === "retry") {
				return;
			}
			if (typeof state.wakeDueAt === "number" && state.wakeDueAt <= dueAt) {
				return;
			}
			this.#clearWakeTimer(state);
		}

		state.wakeDueAt = dueAt;
		state.wakeKind = kind;
		state.wakeTimer = setTimeout(() => {
			void this.#flush(state.activityId, delay, kind);
		}, delay);
		state.wakeTimer.unref?.();
	}

	async #flush(activityId: string, delay: number, kind: WakeTimerKind): Promise<void> {
		const state = this.#states.get(activityId);
		if (!state) {
			return;
		}

		this.#clearWakeTimer(state);
		state.scheduled = false;

		if (state.running) {
			state.scheduled = true;
			this.#schedule(state, delay, kind);
			return;
		}

		const reason = state.pendingWake?.reason;
		state.pendingWake = null;
		state.running = true;

		let result: HeartbeatRunResult;
		const startedAt = this.#nowMs();
		try {
			result = await state.handler({ activityId, reason: reason ?? undefined });
			if (result.status === "ran" && result.durationMs == null) {
				result = {
					status: "ran",
					durationMs: Math.max(0, Math.trunc(this.#nowMs() - startedAt)),
				};
			}
		} catch (err) {
			result = {
				status: "failed",
				reason: err instanceof Error ? err.message : String(err),
			};
		}

		state.running = false;

		// If the activity was removed while the handler was running, bail out quietly.
		if (this.#states.get(activityId) !== state) {
			return;
		}

		if (result.status === "failed") {
			this.#queuePendingWakeReason(state, reason ?? "retry");
			this.#schedule(state, this.#retryMs, "retry");
		} else if (result.status === "skipped" && result.reason === "requests-in-flight") {
			this.#queuePendingWakeReason(state, reason ?? "retry");
			this.#schedule(state, this.#retryMs, "retry");
		}

		if (state.pendingWake || state.scheduled) {
			this.#schedule(state, state.coalesceMs, "normal");
		}
	}

	public register(opts: {
		activityId: string;
		everyMs: number;
		handler: HeartbeatTickHandler;
		coalesceMs?: number;
	}): void {
		const activityId = normalizeActivityId(opts.activityId);
		const existing = this.#states.get(activityId);
		if (existing) {
			this.#disposeState(existing);
			this.#states.delete(activityId);
		}

		const state: ActivityState = {
			activityId,
			everyMs: toMs(opts.everyMs, this.#minIntervalMs, this.#minIntervalMs),
			coalesceMs: Math.max(0, Math.trunc(opts.coalesceMs ?? this.#defaultCoalesceMs)),
			handler: opts.handler,
			pendingWake: null,
			scheduled: false,
			running: false,
			intervalTimer: null,
			wakeTimer: null,
			wakeDueAt: null,
			wakeKind: null,
		};

		state.intervalTimer = setInterval(() => {
			this.requestNow(activityId, { reason: "interval", coalesceMs: 0 });
		}, state.everyMs);
		state.intervalTimer.unref?.();
		this.#states.set(activityId, state);
	}

	public requestNow(activityIdRaw: string, opts?: { reason?: string; coalesceMs?: number }): boolean {
		const activityId = activityIdRaw.trim();
		if (activityId.length === 0) {
			return false;
		}
		const state = this.#states.get(activityId);
		if (!state) {
			return false;
		}
		this.#queuePendingWakeReason(state, opts?.reason);
		this.#schedule(state, opts?.coalesceMs ?? state.coalesceMs, "normal");
		return true;
	}

	public unregister(activityIdRaw: string): boolean {
		const activityId = activityIdRaw.trim();
		if (activityId.length === 0) {
			return false;
		}
		const state = this.#states.get(activityId);
		if (!state) {
			return false;
		}
		this.#disposeState(state);
		this.#states.delete(activityId);
		return true;
	}

	public has(activityIdRaw: string): boolean {
		const activityId = activityIdRaw.trim();
		if (activityId.length === 0) {
			return false;
		}
		return this.#states.has(activityId);
	}

	public listActivityIds(): string[] {
		return [...this.#states.keys()];
	}

	public stop(): void {
		for (const state of this.#states.values()) {
			this.#disposeState(state);
		}
		this.#states.clear();
	}
}
