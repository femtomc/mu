import type { ReloadableGenerationIdentity } from "./reload_lifecycle.js";

export type GenerationTelemetryTags = ReloadableGenerationIdentity & {
	supervisor: string;
	component: string;
};

export type GenerationTelemetryFields = GenerationTelemetryTags & Record<string, unknown>;

export type GenerationTelemetryLogLevel = "debug" | "info" | "warn" | "error";

export type GenerationTelemetryLogRecord = {
	kind: "log";
	level: GenerationTelemetryLogLevel;
	message: string;
	ts_ms: number;
	fields: GenerationTelemetryFields;
};

export type GenerationTelemetryMetricRecord = {
	kind: "metric";
	name: string;
	value: number;
	unit: "count" | "ms";
	ts_ms: number;
	fields: GenerationTelemetryFields;
};

export type GenerationTelemetryTraceRecord = {
	kind: "trace";
	name: string;
	status: "ok" | "error";
	duration_ms: number;
	ts_ms: number;
	fields: GenerationTelemetryFields;
};

export type GenerationTelemetryRecord =
	| GenerationTelemetryLogRecord
	| GenerationTelemetryMetricRecord
	| GenerationTelemetryTraceRecord;

export type GenerationTelemetryCountersSnapshot = {
	reload_success_total: number;
	reload_failure_total: number;
	reload_drain_duration_ms_total: number;
	reload_drain_duration_samples_total: number;
	duplicate_signal_total: number;
	drop_signal_total: number;
};

export type GenerationObservabilityGateThresholds = {
	max_reload_failures?: number;
	max_duplicate_signals?: number;
	max_drop_signals?: number;
};

export type GenerationObservabilityGateStatus = {
	healthy: boolean;
	reasons: string[];
	counters: GenerationTelemetryCountersSnapshot;
};

export type ControlPlaneDuplicateSignal = {
	source: "outbox" | "telegram_ingress" | (string & {});
	signal: string;
	dedupe_key: string;
	record_id: string;
	ts_ms: number;
	metadata?: Record<string, unknown>;
};

export type ControlPlaneDropSignal = {
	source: "outbox" | "telegram_ingress" | (string & {});
	signal: string;
	record_id: string;
	reason: string;
	attempt_count: number;
	ts_ms: number;
	metadata?: Record<string, unknown>;
};

export type ControlPlaneSignalObserver = {
	onDuplicateSignal?: (signal: ControlPlaneDuplicateSignal) => void | Promise<void>;
	onDropSignal?: (signal: ControlPlaneDropSignal) => void | Promise<void>;
};

const DEFAULT_COUNTERS: GenerationTelemetryCountersSnapshot = {
	reload_success_total: 0,
	reload_failure_total: 0,
	reload_drain_duration_ms_total: 0,
	reload_drain_duration_samples_total: 0,
	duplicate_signal_total: 0,
	drop_signal_total: 0,
};

function pushBounded<T>(items: T[], value: T, max: number): void {
	items.push(value);
	if (items.length <= max) {
		return;
	}
	items.splice(0, items.length - max);
}

function cloneCounters(counters: GenerationTelemetryCountersSnapshot): GenerationTelemetryCountersSnapshot {
	return { ...counters };
}

function cloneRecord(record: GenerationTelemetryRecord): GenerationTelemetryRecord {
	return {
		...record,
		fields: { ...record.fields },
	};
}

function withTags(tags: GenerationTelemetryTags, metadata: Record<string, unknown> = {}): GenerationTelemetryFields {
	return {
		...metadata,
		generation_id: tags.generation_id,
		generation_seq: tags.generation_seq,
		supervisor: tags.supervisor,
		component: tags.component,
	};
}

export class GenerationTelemetryRecorder {
	readonly #nowMs: () => number;
	readonly #maxRecords: number;
	readonly #sink: ((record: GenerationTelemetryRecord) => void | Promise<void>) | null;
	readonly #records: GenerationTelemetryRecord[] = [];
	#counters: GenerationTelemetryCountersSnapshot = { ...DEFAULT_COUNTERS };

	public constructor(
		opts: {
			nowMs?: () => number;
			maxRecords?: number;
			sink?: (record: GenerationTelemetryRecord) => void | Promise<void>;
		} = {},
	) {
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#maxRecords = Math.max(10, Math.trunc(opts.maxRecords ?? 1_000));
		this.#sink = opts.sink ?? null;
	}

	#publish(record: GenerationTelemetryRecord): void {
		pushBounded(this.#records, cloneRecord(record), this.#maxRecords);
		if (!this.#sink) {
			return;
		}
		void Promise.resolve(this.#sink(record)).catch(() => {
			// Keep telemetry non-fatal.
		});
	}

	public log(opts: {
		level: GenerationTelemetryLogLevel;
		message: string;
		fields: GenerationTelemetryFields;
		tsMs?: number;
	}): GenerationTelemetryLogRecord {
		const record: GenerationTelemetryLogRecord = {
			kind: "log",
			level: opts.level,
			message: opts.message,
			ts_ms: Math.trunc(opts.tsMs ?? this.#nowMs()),
			fields: { ...opts.fields },
		};
		this.#publish(record);
		return cloneRecord(record) as GenerationTelemetryLogRecord;
	}

	public metric(opts: {
		name: string;
		value: number;
		unit: "count" | "ms";
		fields: GenerationTelemetryFields;
		tsMs?: number;
	}): GenerationTelemetryMetricRecord {
		const record: GenerationTelemetryMetricRecord = {
			kind: "metric",
			name: opts.name,
			value: opts.value,
			unit: opts.unit,
			ts_ms: Math.trunc(opts.tsMs ?? this.#nowMs()),
			fields: { ...opts.fields },
		};
		this.#publish(record);
		return cloneRecord(record) as GenerationTelemetryMetricRecord;
	}

	public trace(opts: {
		name: string;
		status: "ok" | "error";
		durationMs: number;
		fields: GenerationTelemetryFields;
		tsMs?: number;
	}): GenerationTelemetryTraceRecord {
		const record: GenerationTelemetryTraceRecord = {
			kind: "trace",
			name: opts.name,
			status: opts.status,
			duration_ms: Math.max(0, Math.trunc(opts.durationMs)),
			ts_ms: Math.trunc(opts.tsMs ?? this.#nowMs()),
			fields: { ...opts.fields },
		};
		this.#publish(record);
		return cloneRecord(record) as GenerationTelemetryTraceRecord;
	}

	public recordReloadSuccess(tags: GenerationTelemetryTags, metadata: Record<string, unknown> = {}): void {
		this.#counters.reload_success_total += 1;
		const fields = withTags(tags, metadata);
		this.metric({
			name: "reload_success_total",
			value: 1,
			unit: "count",
			fields,
		});
		this.log({
			level: "info",
			message: "control-plane reload succeeded",
			fields,
		});
	}

	public recordReloadFailure(tags: GenerationTelemetryTags, metadata: Record<string, unknown> = {}): void {
		this.#counters.reload_failure_total += 1;
		const fields = withTags(tags, metadata);
		this.metric({
			name: "reload_failure_total",
			value: 1,
			unit: "count",
			fields,
		});
		this.log({
			level: "error",
			message: "control-plane reload failed",
			fields,
		});
	}

	public recordDrainDuration(
		tags: GenerationTelemetryTags,
		opts: {
			durationMs: number;
			timedOut?: boolean;
			metadata?: Record<string, unknown>;
		},
	): void {
		const durationMs = Math.max(0, Math.trunc(opts.durationMs));
		this.#counters.reload_drain_duration_ms_total += durationMs;
		this.#counters.reload_drain_duration_samples_total += 1;
		const fields = withTags(tags, {
			drain_duration_ms: durationMs,
			drain_timed_out: opts.timedOut ?? false,
			...(opts.metadata ?? {}),
		});
		this.metric({
			name: "reload_drain_duration_ms",
			value: durationMs,
			unit: "ms",
			fields,
		});
		this.trace({
			name: "control_plane.reload.drain",
			status: opts.timedOut ? "error" : "ok",
			durationMs,
			fields,
		});
	}

	public recordDuplicateSignal(
		tags: GenerationTelemetryTags,
		signal: Omit<ControlPlaneDuplicateSignal, "ts_ms"> & { ts_ms?: number },
	): void {
		this.#counters.duplicate_signal_total += 1;
		const fields = withTags(tags, {
			signal: signal.signal,
			signal_source: signal.source,
			dedupe_key: signal.dedupe_key,
			record_id: signal.record_id,
			...(signal.metadata ?? {}),
		});
		this.metric({
			name: "duplicate_signal_total",
			value: 1,
			unit: "count",
			fields,
			tsMs: signal.ts_ms,
		});
		this.log({
			level: "warn",
			message: `duplicate signal: ${signal.signal}`,
			fields,
			tsMs: signal.ts_ms,
		});
	}

	public recordDropSignal(
		tags: GenerationTelemetryTags,
		signal: Omit<ControlPlaneDropSignal, "ts_ms"> & { ts_ms?: number },
	): void {
		this.#counters.drop_signal_total += 1;
		const fields = withTags(tags, {
			signal: signal.signal,
			signal_source: signal.source,
			record_id: signal.record_id,
			drop_reason: signal.reason,
			attempt_count: signal.attempt_count,
			...(signal.metadata ?? {}),
		});
		this.metric({
			name: "drop_signal_total",
			value: 1,
			unit: "count",
			fields,
			tsMs: signal.ts_ms,
		});
		this.log({
			level: "error",
			message: `drop signal: ${signal.signal}`,
			fields,
			tsMs: signal.ts_ms,
		});
	}

	public counters(): GenerationTelemetryCountersSnapshot {
		return cloneCounters(this.#counters);
	}

	public records(
		opts: { kind?: GenerationTelemetryRecord["kind"]; limit?: number } = {},
	): GenerationTelemetryRecord[] {
		const requested = opts.limit ?? this.#records.length;
		const limit = Math.max(1, Math.min(2_000, Math.trunc(requested || 1)));
		const filtered = opts.kind ? this.#records.filter((record) => record.kind === opts.kind) : this.#records;
		return filtered.slice(-limit).map((record) => cloneRecord(record));
	}

	public evaluateGates(opts: GenerationObservabilityGateThresholds = {}): GenerationObservabilityGateStatus {
		const counters = this.counters();
		const reasons: string[] = [];
		if (opts.max_reload_failures != null && counters.reload_failure_total > opts.max_reload_failures) {
			reasons.push("reload_failures_exceeded");
		}
		if (opts.max_duplicate_signals != null && counters.duplicate_signal_total > opts.max_duplicate_signals) {
			reasons.push("duplicate_signals_exceeded");
		}
		if (opts.max_drop_signals != null && counters.drop_signal_total > opts.max_drop_signals) {
			reasons.push("drop_signals_exceeded");
		}
		return {
			healthy: reasons.length === 0,
			reasons,
			counters,
		};
	}
}
