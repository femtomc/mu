export type MuControlPlaneRoute = {
	name: string;
	route: string;
};

export type MuGenerationIdentity = {
	generation_id: string;
	generation_seq: number;
};

export type MuGenerationReloadAttempt = {
	attempt_id: string;
	reason: string;
	state: "planned" | "swapped" | "completed" | "failed";
	requested_at_ms: number;
	swapped_at_ms: number | null;
	finished_at_ms: number | null;
	from_generation: MuGenerationIdentity | null;
	to_generation: MuGenerationIdentity;
};

export type MuGenerationSupervisorSnapshot = {
	supervisor_id: string;
	active_generation: MuGenerationIdentity | null;
	pending_reload: MuGenerationReloadAttempt | null;
	last_reload: MuGenerationReloadAttempt | null;
};

export type MuGenerationObservabilityCounters = {
	reload_success_total: number;
	reload_failure_total: number;
	reload_drain_duration_ms_total: number;
	reload_drain_duration_samples_total: number;
	duplicate_signal_total: number;
	drop_signal_total: number;
};

export type MuControlPlaneStatus = {
	active: boolean;
	adapters: string[];
	routes?: MuControlPlaneRoute[];
	generation: MuGenerationSupervisorSnapshot;
	observability: {
		counters: MuGenerationObservabilityCounters;
	};
};

export type MuStatusResponse = {
	repo_root: string;
	control_plane: MuControlPlaneStatus;
	open_count?: number;
	ready_count?: number;
};

export function muServerUrl(): string | null {
	const url = Bun.env.MU_SERVER_URL?.trim();
	return url && url.length > 0 ? url : null;
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value == null || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function fetchMuJson<T>(
	path: string,
	opts: { timeoutMs?: number; method?: string; body?: unknown } = {},
): Promise<T> {
	const base = muServerUrl();
	if (!base) {
		throw new Error("MU_SERVER_URL not set — is mu serve running?");
	}
	const timeoutMs = clampInt(opts.timeoutMs, 10_000, 1_000, 60_000);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${base}${path}`, {
			method: opts.method ?? (opts.body == null ? "GET" : "POST"),
			headers: opts.body == null ? undefined : { "Content-Type": "application/json" },
			body: opts.body == null ? undefined : JSON.stringify(opts.body),
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`mu server ${res.status}: ${text}`);
		}
		return (await res.json()) as T;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`mu server request timed out after ${timeoutMs}ms (${path})`);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}

function ensureGenerationScopedStatus(status: MuStatusResponse): MuStatusResponse {
	const controlPlane = (status as { control_plane?: unknown }).control_plane;
	if (!controlPlane || typeof controlPlane !== "object") {
		throw new Error("mu server /api/status missing control_plane payload (expected generation-scoped contract)");
	}

	const controlPlaneRecord = controlPlane as Record<string, unknown>;
	if (!("generation" in controlPlaneRecord) || !controlPlaneRecord.generation) {
		throw new Error("mu server /api/status missing control_plane.generation (expected generation-scoped contract)");
	}
	if (!("observability" in controlPlaneRecord) || !controlPlaneRecord.observability) {
		throw new Error(
			"mu server /api/status missing control_plane.observability (expected generation-scoped contract)",
		);
	}

	const observability = controlPlaneRecord.observability;
	if (
		typeof observability !== "object" ||
		observability == null ||
		!("counters" in observability) ||
		!(observability as Record<string, unknown>).counters
	) {
		throw new Error(
			"mu server /api/status missing control_plane.observability.counters (expected generation-scoped contract)",
		);
	}

	return status;
}

export async function fetchMuStatus(timeoutMs?: number): Promise<MuStatusResponse> {
	const status = await fetchMuJson<MuStatusResponse>("/api/status", { timeoutMs });
	return ensureGenerationScopedStatus(status);
}
