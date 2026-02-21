import { rmSync } from "node:fs";
import { join } from "node:path";
import { getStorePaths as resolveStorePaths } from "@femtomc/mu-core/node";

function storePathForRepoRoot(repoRoot: string, ...parts: string[]): string {
	return join(resolveStorePaths(repoRoot).storeDir, ...parts);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

export async function readApiError(response: Response, payloadOverride?: unknown): Promise<string> {
	let detail = "";
	if (payloadOverride !== undefined) {
		const payload = asRecord(payloadOverride);
		const error = payload && typeof payload.error === "string" ? payload.error.trim() : "";
		if (error.length > 0) {
			detail = error;
		}
	} else {
		try {
			const payload = asRecord(await response.json());
			const error = payload && typeof payload.error === "string" ? payload.error.trim() : "";
			if (error.length > 0) {
				detail = error;
			}
		} catch {
			// Ignore invalid/empty JSON; fallback to HTTP status text.
		}
	}
	const statusText = `${response.status} ${response.statusText}`.trim();
	if (detail.length > 0) {
		return `${detail} (${statusText})`;
	}
	return statusText;
}

export async function detectRunningServer(repoRoot: string): Promise<{ url: string; port: number; pid: number } | null> {
	const discoveryPath = storePathForRepoRoot(repoRoot, "control-plane", "server.json");
	try {
		const raw = await Bun.file(discoveryPath).text();
		const parsed = JSON.parse(raw.trim());
		const pid = parsed?.pid;
		const port = parsed?.port;
		if (typeof pid !== "number" || typeof port !== "number") return null;

		// Check if PID is alive
		try {
			process.kill(pid, 0);
		} catch {
			// PID dead — clean up stale discovery files
			cleanupStaleServerFiles(repoRoot);
			return null;
		}

		// Probe health endpoint
		const url = `http://localhost:${port}`;
		try {
			const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return { url, port, pid };
		} catch {
			/* server not responding — PID alive but not healthy yet or different process */
		}
		return null;
	} catch {
		return null;
	}
}

export async function requireRunningServer<
	RunResult extends {
		stdout: string;
		stderr: string;
		exitCode: number;
	},
>(
	ctx: { repoRoot: string },
	opts: {
		pretty: boolean;
		recoveryCommand: string;
		jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => RunResult;
	},
): Promise<{ url: string } | RunResult> {
	const running = await detectRunningServer(ctx.repoRoot);
	if (running) {
		return { url: running.url };
	}
	return opts.jsonError("no running server found", {
		pretty: opts.pretty,
		recovery: [opts.recoveryCommand, "mu serve"],
	});
}

export async function requestServerJson<
	Ctx extends { repoRoot: string },
	T,
	RunResult extends {
		stdout: string;
		stderr: string;
		exitCode: number;
	},
>(opts: {
	ctx: Ctx;
	pretty: boolean;
	method?: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	recoveryCommand: string;
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => RunResult;
	describeError: (err: unknown) => string;
}): Promise<{ ok: true; payload: T } | { ok: false; result: RunResult }> {
	const resolved = await requireRunningServer(opts.ctx, {
		pretty: opts.pretty,
		recoveryCommand: opts.recoveryCommand,
		jsonError: opts.jsonError,
	});
	if ("exitCode" in resolved) {
		return { ok: false, result: resolved };
	}
	const url = `${resolved.url}${opts.path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: opts.method ?? "GET",
			headers: opts.body ? { "Content-Type": "application/json" } : undefined,
			body: opts.body ? JSON.stringify(opts.body) : undefined,
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		return {
			ok: false,
			result: opts.jsonError(`server request failed: ${opts.describeError(err)}`, {
				pretty: opts.pretty,
				recovery: [opts.recoveryCommand, "mu serve"],
			}),
		};
	}

	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}

	if (!response.ok) {
		const detail = await readApiError(response, payload);
		return {
			ok: false,
			result: opts.jsonError(`request failed: ${detail}`, {
				pretty: opts.pretty,
				recovery: [opts.recoveryCommand],
			}),
		};
	}

	return { ok: true, payload: payload as T };
}

export function cleanupStaleServerFiles(repoRoot: string): void {
	try {
		rmSync(storePathForRepoRoot(repoRoot, "control-plane", "server.json"), { force: true });
	} catch {
		// best-effort
	}
	try {
		rmSync(storePathForRepoRoot(repoRoot, "control-plane", "writer.lock"), { force: true });
	} catch {
		// best-effort
	}
}
