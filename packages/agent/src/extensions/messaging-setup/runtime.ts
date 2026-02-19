/**
 * Runtime state fetching and adapter check collection for mu-messaging-setup.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ADAPTERS, configured, deriveState, missingRequiredFields, nextStepForState } from "./adapters.js";
import type { AdapterCheck, RuntimeState } from "./types.js";
import { summarizeChecks } from "./ui.js";
import { fetchMuJson, fetchMuStatus, muServerUrl } from "../shared.js";
import type { ConfigReadResponse } from "./types.js";

export async function fetchConfigPresence(): Promise<ConfigReadResponse> {
	return await fetchMuJson<ConfigReadResponse>("/api/config", { timeoutMs: 4_000 });
}

export async function fetchRuntimeState(): Promise<RuntimeState> {
	if (!muServerUrl()) {
		return {
			repoRoot: null,
			configPath: null,
			runtimeActive: false,
			routesByAdapter: new Map(),
			configPresence: null,
			fetchError: "MU_SERVER_URL not set",
		};
	}

	try {
		const [status, config] = await Promise.all([fetchMuStatus(2_000), fetchConfigPresence()]);
		const cp = status.control_plane ?? {
			active: false,
			adapters: [] as string[],
			routes: [] as { name: string; route: string }[],
		};
		const routesByAdapter = new Map<string, string>();
		for (const route of cp.routes ?? []) {
			routesByAdapter.set(route.name, route.route);
		}
		for (const adapter of cp.adapters) {
			if (!routesByAdapter.has(adapter)) {
				routesByAdapter.set(adapter, `/webhooks/${adapter}`);
			}
		}
		return {
			repoRoot: status.repo_root,
			configPath: config.config_path,
			runtimeActive: cp.active,
			routesByAdapter,
			configPresence: config.presence,
			fetchError: null,
		};
	} catch (err) {
		return {
			repoRoot: null,
			configPath: null,
			runtimeActive: false,
			routesByAdapter: new Map(),
			configPresence: null,
			fetchError: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function collectChecks(): Promise<{ checks: AdapterCheck[]; runtime: RuntimeState }> {
	const runtime = await fetchRuntimeState();
	const checks: AdapterCheck[] = ADAPTERS.map((adapter) => {
		const missing = missingRequiredFields(adapter, runtime.configPresence);
		const isConfigured = configured(adapter, runtime.configPresence);
		const active = runtime.routesByAdapter.has(adapter.id);
		const route = runtime.routesByAdapter.get(adapter.id) ?? null;
		const state = deriveState({ adapter, configured: isConfigured, active });
		const notes = [...(adapter.notes ?? [])];
		if (runtime.fetchError && runtime.fetchError !== "MU_SERVER_URL not set") {
			notes.push(`Runtime/config status unavailable: ${runtime.fetchError}`);
		}
		if (runtime.configPath) {
			notes.push(`Config path: ${runtime.configPath}`);
		}
		return {
			id: adapter.id,
			name: adapter.name,
			support: adapter.support,
			configured: isConfigured,
			missing,
			active,
			route,
			state,
			next_step: nextStepForState({ state, missing }),
			notes,
		};
	});
	return { checks, runtime };
}

let checksCache: { tsMs: number; value: Awaited<ReturnType<typeof collectChecks>> } | null = null;

export async function collectChecksCached(ttlMs: number = 4_000): Promise<Awaited<ReturnType<typeof collectChecks>>> {
	if (ttlMs <= 0) {
		const value = await collectChecks();
		checksCache = { tsMs: Date.now(), value };
		return value;
	}

	const now = Date.now();
	if (checksCache && now - checksCache.tsMs <= ttlMs) {
		return checksCache.value;
	}
	const value = await collectChecks();
	checksCache = { tsMs: now, value };
	return value;
}

export function resetChecksCache(): void {
	checksCache = null;
}

export async function refreshMessagingStatus(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const { checks } = await collectChecksCached();
	ctx.ui.setStatus("mu-messaging", ctx.ui.theme.fg("dim", summarizeChecks(checks)));
}
