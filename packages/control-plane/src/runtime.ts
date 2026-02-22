import { type IdempotencyClaimDecision, type IdempotencyClaimRecord, IdempotencyLedger } from "./idempotency_ledger.js";
import { type ControlPlanePaths, getControlPlanePaths } from "./paths.js";
import { WriterLock } from "./writer_lock.js";

export type ControlPlaneRuntimeOpts = {
	repoRoot: string;
	ownerId?: string;
	nowMs?: () => number;
	idempotency?: IdempotencyLedger;
};

export class ControlPlaneRuntime {
	public readonly paths: ControlPlanePaths;
	public readonly idempotency: IdempotencyLedger;
	readonly #ownerId: string | undefined;
	readonly #nowMs: () => number;
	#writerLock: WriterLock | null = null;
	#started = false;

	public constructor(opts: ControlPlaneRuntimeOpts) {
		this.paths = getControlPlanePaths(opts.repoRoot);
		this.idempotency = opts.idempotency ?? new IdempotencyLedger(this.paths.idempotencyPath);
		this.#ownerId = opts.ownerId;
		this.#nowMs = opts.nowMs ?? Date.now;
	}

	public async start(): Promise<void> {
		if (this.#started) {
			return;
		}
		this.#writerLock = await WriterLock.acquire(this.paths.writerLockPath, {
			ownerId: this.#ownerId,
			repoRoot: this.paths.repoRoot,
			nowMs: Math.trunc(this.#nowMs()),
		});
		await this.idempotency.load();
		this.#started = true;
	}

	public async stop(): Promise<void> {
		if (!this.#started) {
			return;
		}
		if (this.#writerLock) {
			await this.#writerLock.release();
			this.#writerLock = null;
		}
		this.#started = false;
	}

	#assertStarted(): void {
		if (!this.#started) {
			throw new Error("control-plane runtime not started");
		}
	}

	public async claimIdempotency(opts: {
		key: string;
		fingerprint: string;
		commandId: string;
		ttlMs: number;
		nowMs?: number;
	}): Promise<IdempotencyClaimDecision> {
		this.#assertStarted();
		return await this.idempotency.claim(opts);
	}

	public async lookupIdempotency(key: string, opts: { nowMs?: number } = {}): Promise<IdempotencyClaimRecord | null> {
		this.#assertStarted();
		return await this.idempotency.lookup(key, opts);
	}
}
