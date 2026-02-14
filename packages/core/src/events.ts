import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

export const EVENT_VERSION = 1;

const runIdStore = new AsyncLocalStorage<string | null>();

export function nowTsMs(): number {
	// Milliseconds since Unix epoch.
	return Date.now();
}

export function newRunId(): string {
	// Python uses uuid4().hex (no dashes).
	return randomUUID().replaceAll("-", "");
}

export function currentRunId(): string | null {
	return runIdStore.getStore() ?? null;
}

export function runContext<T>(opts: { runId: string | null }, fn: () => T): T {
	return runIdStore.run(opts.runId, fn);
}

export type EventEnvelope = {
	v: number;
	ts_ms: number;
	type: string;
	source: string;
	payload: Record<string, unknown>;
	run_id?: string;
	issue_id?: string;
};

export class EventLog {
	public readonly path: string;

	public constructor(path: string) {
		this.path = path;
	}

	public static fromRepoRoot(repoRoot: string): EventLog {
		return new EventLog(join(repoRoot, ".inshallah", "events.jsonl"));
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

		const resolvedRunId = opts.runId != null ? opts.runId : currentRunId();
		const event: EventEnvelope = {
			v: EVENT_VERSION,
			ts_ms: Math.trunc(opts.tsMs ?? nowTsMs()),
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

		await this.#append(event);
		return event;
	}

	async #append(event: EventEnvelope): Promise<void> {
		// Keep each event to a single JSON line.
		const line = `${JSON.stringify(event)}\n`;
		const data = Buffer.from(line, "utf8");

		await mkdir(dirname(this.path), { recursive: true });
		const fh = await open(this.path, "a");
		try {
			let written = 0;
			while (written < data.length) {
				const { bytesWritten } = await fh.write(data, written, data.length - written);
				if (bytesWritten <= 0) {
					throw new Error("short write while appending event log");
				}
				written += bytesWritten;
			}
		} finally {
			await fh.close();
		}
	}
}

