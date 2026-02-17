export type MuControlPlaneRoute = {
	name: string;
	route: string;
};

export type MuStatusResponse = {
	repo_root: string;
	open_count: number;
	ready_count: number;
	control_plane?: {
		active: boolean;
		adapters: string[];
		routes?: MuControlPlaneRoute[];
	};
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

export async function fetchMuStatus(timeoutMs?: number): Promise<MuStatusResponse> {
	return await fetchMuJson<MuStatusResponse>("/api/status", { timeoutMs });
}

export function textResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function toJsonText(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
