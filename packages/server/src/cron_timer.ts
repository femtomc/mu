type CronTimerEntry = {
	programId: string;
	dueAtMs: number;
	handle: ReturnType<typeof setTimeout> | null;
	token: number;
	onDue: () => void | Promise<void>;
};

export type CronTimerSnapshot = {
	program_id: string;
	due_at_ms: number;
};

export type CronTimerRegistryOpts = {
	nowMs?: () => number;
	maxDelayMs?: number;
};

const DEFAULT_MAX_DELAY_MS = 60_000;

function defaultNowMs(): number {
	return Date.now();
}

export class CronTimerRegistry {
	readonly #entries = new Map<string, CronTimerEntry>();
	readonly #nowMs: () => number;
	readonly #maxDelayMs: number;
	#token = 0;

	public constructor(opts: CronTimerRegistryOpts = {}) {
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#maxDelayMs = Math.max(1_000, Math.trunc(opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
	}

	#clearTimer(entry: CronTimerEntry): void {
		if (entry.handle) {
			clearTimeout(entry.handle);
		}
		entry.handle = null;
	}

	#arm(entry: CronTimerEntry): void {
		this.#clearTimer(entry);
		const nowMs = Math.trunc(this.#nowMs());
		const remainingMs = Math.max(0, entry.dueAtMs - nowMs);
		const delayMs = Math.min(this.#maxDelayMs, remainingMs);
		const token = ++this.#token;
		entry.token = token;
		entry.handle = setTimeout(() => {
			void this.#onTimer(entry.programId, token);
		}, delayMs);
		entry.handle.unref?.();
	}

	async #onTimer(programId: string, token: number): Promise<void> {
		const entry = this.#entries.get(programId);
		if (!entry || entry.token !== token) {
			return;
		}

		const nowMs = Math.trunc(this.#nowMs());
		if (nowMs < entry.dueAtMs) {
			this.#arm(entry);
			return;
		}

		this.#clearTimer(entry);
		try {
			await entry.onDue();
		} catch {
			// Best effort callback execution.
		}
	}

	public arm(opts: {
		programId: string;
		dueAtMs: number;
		onDue: () => void | Promise<void>;
	}): void {
		const programId = opts.programId.trim();
		if (!programId) {
			return;
		}
		const dueAtMs = Math.max(0, Math.trunc(opts.dueAtMs));
		const existing = this.#entries.get(programId);
		const entry: CronTimerEntry =
			existing ??
			{
				programId,
				dueAtMs,
				handle: null,
				token: 0,
				onDue: opts.onDue,
			};
		entry.dueAtMs = dueAtMs;
		entry.onDue = opts.onDue;
		this.#entries.set(programId, entry);
		this.#arm(entry);
	}

	public disarm(programIdRaw: string): boolean {
		const programId = programIdRaw.trim();
		if (!programId) {
			return false;
		}
		const entry = this.#entries.get(programId);
		if (!entry) {
			return false;
		}
		this.#clearTimer(entry);
		this.#entries.delete(programId);
		return true;
	}

	public dueAt(programIdRaw: string): number | null {
		const programId = programIdRaw.trim();
		if (!programId) {
			return null;
		}
		return this.#entries.get(programId)?.dueAtMs ?? null;
	}

	public list(): CronTimerSnapshot[] {
		return [...this.#entries.values()]
			.map((entry) => ({
				program_id: entry.programId,
				due_at_ms: entry.dueAtMs,
			}))
			.sort((a, b) => {
				if (a.due_at_ms !== b.due_at_ms) {
					return a.due_at_ms - b.due_at_ms;
				}
				return a.program_id.localeCompare(b.program_id);
			});
	}

	public stop(): void {
		for (const entry of this.#entries.values()) {
			this.#clearTimer(entry);
		}
		this.#entries.clear();
	}
}
