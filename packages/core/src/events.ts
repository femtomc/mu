import type { JsonlStore } from "./persistence";

export const EVENT_VERSION = 1;

export type EventEnvelope = {
	v: number;
	ts_ms: number;
	type: string;
	source: string;
	payload: Record<string, unknown>;
	run_id?: string;
	issue_id?: string;
};

export type RunIdProvider = () => string | null;

export type EventSink = {
	emit(event: EventEnvelope): Promise<void>;
};

export class NullEventSink implements EventSink {
	public async emit(_event: EventEnvelope): Promise<void> {}
}

export class JsonlEventSink implements EventSink {
	readonly #store: Pick<JsonlStore<EventEnvelope>, "append">;

	public constructor(store: Pick<JsonlStore<EventEnvelope>, "append">) {
		this.#store = store;
	}

	public async emit(event: EventEnvelope): Promise<void> {
		await this.#store.append(event);
	}
}

const runIdStack: (string | null)[] = [];

export function currentRunId(): string | null {
	if (runIdStack.length === 0) {
		return null;
	}
	return runIdStack[runIdStack.length - 1] ?? null;
}

export function runContext<T>(opts: { runId: string | null }, fn: () => T): T;
export function runContext<T>(opts: { runId: string | null }, fn: () => Promise<T>): Promise<T>;
export function runContext<T>(opts: { runId: string | null }, fn: () => T | Promise<T>): T | Promise<T> {
	runIdStack.push(opts.runId);
	let popped = false;
	const pop = () => {
		if (!popped) {
			popped = true;
			runIdStack.pop();
		}
	};

	try {
		const out = fn();
		if (out && typeof (out as any).then === "function") {
			return (out as Promise<T>).finally(pop);
		}
		pop();
		return out;
	} catch (err) {
		pop();
		throw err;
	}
}

export class EventLog {
	readonly #sink: EventSink;
	readonly #runIdProvider: RunIdProvider;

	public constructor(sink: EventSink, opts: { runIdProvider?: RunIdProvider } = {}) {
		this.#sink = sink;
		this.#runIdProvider = opts.runIdProvider ?? currentRunId;
	}

	public async emit(
		eventType: string,
		opts: {
			source: string;
			payload?: Record<string, unknown>;
			issueId?: string;
			runId?: string | null;
			tsMs?: number;
		},
	): Promise<EventEnvelope> {
		const payload = opts.payload ?? {};
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			throw new TypeError("payload must be an object");
		}

		const resolvedRunId = opts.runId != null ? opts.runId : this.#runIdProvider();
		const event: EventEnvelope = {
			v: EVENT_VERSION,
			ts_ms: Math.trunc(opts.tsMs ?? Date.now()),
			type: eventType,
			source: opts.source,
			payload,
		};
		if (resolvedRunId != null) {
			event.run_id = resolvedRunId;
		}
		if (opts.issueId != null) {
			event.issue_id = opts.issueId;
		}

		await this.#sink.emit(event);
		return event;
	}
}
