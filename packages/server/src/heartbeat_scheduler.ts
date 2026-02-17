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

type WakeTimer = {
	handle: ReturnType<typeof setTimeout>;
	dueAt: number;
	kind: WakeTimerKind;
	token: number;
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
	wakeTimer: WakeTimer | null;
	disposed: boolean;
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

function shouldRetry(result: HeartbeatRunResult): boolean {
	if (result.status === "failed") {
		return true;
	}
	return result.status === "skipped" && result.reason === "requests-in-flight";
}

export class ActivityHeartbeatScheduler {
	readonly #states = new Map<string, ActivityState>();
	readonly #nowMs: () => number;
	readonly #defaultCoalesceMs: number;
	readonly #retryMs: number;
	readonly #minIntervalMs: number;
	#wakeTimerToken = 0;

	public constructor(opts: ActivityHeartbeatSchedulerOpts = {}) {
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#defaultCoalesceMs = Math.max(0, Math.trunc(opts.defaultCoalesceMs ?? DEFAULT_COALESCE_MS));
		this.#retryMs = Math.max(100, Math.trunc(opts.retryMs ?? DEFAULT_RETRY_MS));
		this.#minIntervalMs = Math.max(100, Math.trunc(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
	}

	#isCurrentState(state: ActivityState): boolean {
		if (state.disposed) {
			return false;
		}
		return this.#states.get(state.activityId) === state;
	}

	#normalizeDelayMs(coalesceMs: number): number {
		if (!Number.isFinite(coalesceMs)) {
			return this.#defaultCoalesceMs;
		}
		return Math.max(0, Math.trunc(coalesceMs));
	}

	#clearWakeTimer(state: ActivityState): void {
		if (state.wakeTimer) {
			clearTimeout(state.wakeTimer.handle);
		}
		state.wakeTimer = null;
	}

	#disposeState(state: ActivityState): void {
		if (state.disposed) {
			return;
		}
		state.disposed = true;
		if (state.intervalTimer) {
			clearInterval(state.intervalTimer);
			state.intervalTimer = null;
		}
		this.#clearWakeTimer(state);
		state.pendingWake = null;
		state.scheduled = false;
		state.running = false;
	}

	#queuePendingWakeReason(state: ActivityState, reason?: string): void {
		if (!this.#isCurrentState(state)) {
			return;
		}
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

	#scheduleWake(state: ActivityState, coalesceMs: number, kind: WakeTimerKind = "normal"): void {
		if (!this.#isCurrentState(state)) {
			return;
		}

		const delay = this.#normalizeDelayMs(coalesceMs);
		const dueAt = this.#nowMs() + delay;
		const activeTimer = state.wakeTimer;
		if (activeTimer) {
			// Retry cooldown should remain in force.
			if (activeTimer.kind === "retry") {
				return;
			}
			if (activeTimer.dueAt <= dueAt) {
				return;
			}
			this.#clearWakeTimer(state);
		}

		const timerToken = ++this.#wakeTimerToken;
		const handle = setTimeout(() => {
			void this.#flushWake(state, {
				timerToken,
				delay,
				kind,
			});
		}, delay);
		handle.unref?.();

		state.wakeTimer = {
			handle,
			dueAt,
			kind,
			token: timerToken,
		};
	}

	async #invokeHandler(state: ActivityState, reason: string | undefined): Promise<HeartbeatRunResult> {
		const startedAt = this.#nowMs();
		try {
			const result = await state.handler({
				activityId: state.activityId,
				reason,
			});
			if (result.status === "ran" && result.durationMs == null) {
				return {
					status: "ran",
					durationMs: Math.max(0, Math.trunc(this.#nowMs() - startedAt)),
				};
			}
			return result;
		} catch (err) {
			return {
				status: "failed",
				reason: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async #flushWake(
		state: ActivityState,
		params: {
			timerToken: number;
			delay: number;
			kind: WakeTimerKind;
		},
	): Promise<void> {
		if (!this.#isCurrentState(state)) {
			return;
		}

		const activeTimer = state.wakeTimer;
		if (!activeTimer || activeTimer.token !== params.timerToken) {
			return;
		}

		this.#clearWakeTimer(state);
		state.scheduled = false;

		if (state.running) {
			state.scheduled = true;
			this.#scheduleWake(state, params.delay, params.kind);
			return;
		}

		const reason = state.pendingWake?.reason;
		state.pendingWake = null;
		state.running = true;
		const result = await this.#invokeHandler(state, reason ?? undefined);
		state.running = false;

		if (!this.#isCurrentState(state)) {
			return;
		}

		if (shouldRetry(result)) {
			this.#queuePendingWakeReason(state, reason ?? "retry");
			this.#scheduleWake(state, this.#retryMs, "retry");
		}

		if (state.pendingWake || state.scheduled) {
			this.#scheduleWake(state, state.coalesceMs, "normal");
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

		const hasInterval = Number.isFinite(opts.everyMs) && Math.trunc(opts.everyMs) > 0;
		const state: ActivityState = {
			activityId,
			everyMs: hasInterval ? toMs(opts.everyMs, this.#minIntervalMs, this.#minIntervalMs) : 0,
			coalesceMs: Math.max(0, Math.trunc(opts.coalesceMs ?? this.#defaultCoalesceMs)),
			handler: opts.handler,
			pendingWake: null,
			scheduled: false,
			running: false,
			intervalTimer: null,
			wakeTimer: null,
			disposed: false,
		};

		if (state.everyMs > 0) {
			state.intervalTimer = setInterval(() => {
				this.requestNow(activityId, { reason: "interval", coalesceMs: 0 });
			}, state.everyMs);
			state.intervalTimer.unref?.();
		}

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
		this.#scheduleWake(state, opts?.coalesceMs ?? state.coalesceMs, "normal");
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
