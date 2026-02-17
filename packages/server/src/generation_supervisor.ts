import type {
	GenerationReloadAttempt,
	GenerationSupervisorSnapshot,
	ReloadableGenerationIdentity,
	ReloadLifecycleReason,
} from "@femtomc/mu-control-plane";

export type ControlPlaneGenerationSupervisorOpts = {
	supervisorId?: string;
	nowMs?: () => number;
	initialGeneration?: ReloadableGenerationIdentity | null;
};

export type BeginGenerationReloadResult = {
	attempt: GenerationReloadAttempt;
	coalesced: boolean;
};

function cloneGeneration(generation: ReloadableGenerationIdentity | null): ReloadableGenerationIdentity | null {
	if (!generation) {
		return null;
	}
	return { ...generation };
}

function cloneAttempt(attempt: GenerationReloadAttempt | null): GenerationReloadAttempt | null {
	if (!attempt) {
		return null;
	}
	return {
		...attempt,
		from_generation: cloneGeneration(attempt.from_generation),
		to_generation: { ...attempt.to_generation },
	};
}

export class ControlPlaneGenerationSupervisor {
	readonly #supervisorId: string;
	readonly #nowMs: () => number;
	#generationSeq: number;
	#attemptSeq = 0;
	#activeGeneration: ReloadableGenerationIdentity | null;
	#pendingReload: GenerationReloadAttempt | null = null;
	#lastReload: GenerationReloadAttempt | null = null;

	public constructor(opts: ControlPlaneGenerationSupervisorOpts = {}) {
		this.#supervisorId = opts.supervisorId?.trim() || "control-plane";
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#activeGeneration = cloneGeneration(opts.initialGeneration ?? null);
		this.#generationSeq = this.#activeGeneration?.generation_seq ?? -1;
	}

	#nextGeneration(): ReloadableGenerationIdentity {
		const nextSeq = this.#generationSeq + 1;
		return {
			generation_id: `${this.#supervisorId}-gen-${nextSeq}`,
			generation_seq: nextSeq,
		};
	}

	public beginReload(reason: ReloadLifecycleReason): BeginGenerationReloadResult {
		if (this.#pendingReload) {
			return {
				attempt: cloneAttempt(this.#pendingReload) as GenerationReloadAttempt,
				coalesced: true,
			};
		}
		this.#attemptSeq += 1;
		const nowMs = Math.trunc(this.#nowMs());
		const attempt: GenerationReloadAttempt = {
			attempt_id: `${this.#supervisorId}-reload-${this.#attemptSeq.toString(36)}`,
			reason,
			state: "planned",
			requested_at_ms: nowMs,
			swapped_at_ms: null,
			finished_at_ms: null,
			from_generation: cloneGeneration(this.#activeGeneration),
			to_generation: this.#nextGeneration(),
		};
		this.#pendingReload = attempt;
		return {
			attempt: cloneAttempt(attempt) as GenerationReloadAttempt,
			coalesced: false,
		};
	}

	public markSwapInstalled(attemptId: string): boolean {
		if (!this.#pendingReload || this.#pendingReload.attempt_id !== attemptId) {
			return false;
		}
		this.#pendingReload.state = "swapped";
		this.#pendingReload.swapped_at_ms = Math.trunc(this.#nowMs());
		this.#activeGeneration = { ...this.#pendingReload.to_generation };
		this.#generationSeq = this.#pendingReload.to_generation.generation_seq;
		return true;
	}

	public rollbackSwapInstalled(attemptId: string): boolean {
		if (
			!this.#pendingReload ||
			this.#pendingReload.attempt_id !== attemptId ||
			this.#pendingReload.swapped_at_ms == null
		) {
			return false;
		}
		this.#activeGeneration = cloneGeneration(this.#pendingReload.from_generation);
		this.#generationSeq = this.#activeGeneration?.generation_seq ?? -1;
		return true;
	}

	public finishReload(attemptId: string, outcome: "success" | "failure"): boolean {
		if (!this.#pendingReload || this.#pendingReload.attempt_id !== attemptId) {
			return false;
		}
		this.#pendingReload.state = outcome === "success" ? "completed" : "failed";
		this.#pendingReload.finished_at_ms = Math.trunc(this.#nowMs());
		this.#lastReload = cloneAttempt(this.#pendingReload);
		this.#pendingReload = null;
		return true;
	}

	public activeGeneration(): ReloadableGenerationIdentity | null {
		return cloneGeneration(this.#activeGeneration);
	}

	public pendingReload(): GenerationReloadAttempt | null {
		return cloneAttempt(this.#pendingReload);
	}

	public snapshot(): GenerationSupervisorSnapshot {
		return {
			supervisor_id: this.#supervisorId,
			active_generation: cloneGeneration(this.#activeGeneration),
			pending_reload: cloneAttempt(this.#pendingReload),
			last_reload: cloneAttempt(this.#lastReload),
		};
	}
}
