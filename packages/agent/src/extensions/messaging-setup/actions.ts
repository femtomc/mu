/**
 * Config write/reload actions for mu-messaging-setup.
 */

import { adapterById, missingRequiredFields, normalizePublicBaseUrl } from "./adapters.js";
import { resetChecksCache } from "./runtime.js";
import type {
	AdapterCheck,
	AdapterId,
	ApplyOutcome,
	ConfigPresence,
	ConfigWriteResponse,
	ControlPlaneGenerationIdentity,
	ControlPlaneReloadApiResponse,
	ControlPlaneReloadGenerationSummary,
	ControlPlaneReloadOutcome,
	VerifyOutcome,
} from "./types.js";
import { fetchMuJson, muServerUrl } from "../shared.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isControlPlaneGenerationIdentity(value: unknown): value is ControlPlaneGenerationIdentity {
	if (!isRecord(value)) return false;
	return typeof value.generation_id === "string" && typeof value.generation_seq === "number";
}

function isControlPlaneReloadGenerationSummary(value: unknown): value is ControlPlaneReloadGenerationSummary {
	if (!isRecord(value)) return false;
	if (typeof value.attempt_id !== "string") return false;
	if (typeof value.coalesced !== "boolean") return false;
	if (value.from_generation !== null && !isControlPlaneGenerationIdentity(value.from_generation)) return false;
	if (!isControlPlaneGenerationIdentity(value.to_generation)) return false;
	if (value.active_generation !== null && !isControlPlaneGenerationIdentity(value.active_generation)) return false;
	return value.outcome === "success" || value.outcome === "failure";
}

export function parseControlPlaneReloadApiResponse(raw: string): {
	response: ControlPlaneReloadApiResponse | null;
	error: string | null;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return {
			response: null,
			error: "control-plane reload returned invalid JSON response",
		};
	}

	if (!isRecord(parsed)) {
		return {
			response: null,
			error: "control-plane reload returned non-object payload",
		};
	}

	if (!isControlPlaneReloadGenerationSummary(parsed.generation)) {
		return {
			response: null,
			error: "control-plane reload response missing generation metadata (expected generation-scoped contract)",
		};
	}

	const parsedRecord = parsed as Record<string, unknown>;
	const response = {
		...(parsed as ControlPlaneReloadApiResponse),
		telegram_generation:
			(parsedRecord.telegram_generation as ControlPlaneReloadApiResponse["telegram_generation"] | undefined) ?? null,
	};
	return {
		response,
		error: null,
	};
}

export async function reloadControlPlaneInProcess(reason: string): Promise<ControlPlaneReloadOutcome> {
	const base = muServerUrl();
	if (!base) {
		return {
			ok: false,
			response: null,
			error: "MU_SERVER_URL not set",
		};
	}

	try {
		const response = await fetch(`${base}/api/control-plane/reload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason }),
		});
		const raw = await response.text();
		const parsedResult = parseControlPlaneReloadApiResponse(raw);
		const parsed = parsedResult.response;

		if (parsedResult.error) {
			return {
				ok: false,
				response: null,
				error: parsedResult.error,
			};
		}

		if (!parsed) {
			return {
				ok: false,
				response: null,
				error: "control-plane reload response missing payload",
			};
		}

		if (!response.ok || !parsed.ok) {
			return {
				ok: false,
				response: parsed,
				error: parsed.error ?? `control-plane reload failed (${response.status})`,
			};
		}

		return {
			ok: true,
			response: parsed,
			error: null,
		};
	} catch (err) {
		return {
			ok: false,
			response: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function reloadOutcomeSummary(reload: ControlPlaneReloadOutcome): string {
	if (!reload.ok) {
		return `Control-plane reload failed: ${reload.error ?? "unknown error"}.`;
	}
	const response = reload.response;
	if (!response) {
		return "Control-plane reload failed: missing reload response payload.";
	}

	const adapters = response.control_plane?.adapters.join(", ") || "(none)";
	const generationSummary = `${response.generation.outcome} (${response.generation.active_generation?.generation_id ?? response.generation.to_generation.generation_id})`;
	const telegramRollbackTrigger = response.telegram_generation?.rollback.trigger;
	const telegramNote =
		response.telegram_generation?.handled && telegramRollbackTrigger
			? ` rollback_trigger=${telegramRollbackTrigger}`
			: "";
	return `Control-plane reloaded in-process. Active adapters: ${adapters}. Generation: ${generationSummary}.${telegramNote}`;
}

export function patchForAdapterValues(adapterId: AdapterId, values: Record<string, string>): Record<string, unknown> {
	switch (adapterId) {
		case "slack":
			return {
				control_plane: {
					adapters: {
						slack: {
							signing_secret: values.signing_secret ?? null,
						},
					},
				},
			};
		case "discord":
			return {
				control_plane: {
					adapters: {
						discord: {
							signing_secret: values.signing_secret ?? null,
						},
					},
				},
			};
		case "telegram":
			return {
				control_plane: {
					adapters: {
						telegram: {
							webhook_secret: values.webhook_secret ?? null,
							bot_token: values.bot_token ?? null,
							bot_username: values.bot_username ?? null,
						},
					},
				},
			};
	}
}

export async function writeConfigPatch(patch: Record<string, unknown>): Promise<ConfigWriteResponse> {
	return await fetchMuJson<ConfigWriteResponse>("/api/config", {
		method: "POST",
		body: { patch },
		timeoutMs: 6_000,
	});
}

export async function applyAdapterConfig(opts: {
	adapterId: AdapterId;
	overrides?: Record<string, string>;
	presence: ConfigPresence;
}): Promise<ApplyOutcome> {
	const adapter = adapterById(opts.adapterId);
	if (adapter.support === "planned") {
		return {
			ok: false,
			adapter: adapter.id,
			reason: "adapter_planned",
			missing_required_fields: adapter.fields.filter((field) => field.required).map((field) => field.key),
		};
	}

	const missingRequired = missingRequiredFields(adapter, opts.presence);
	const overrides = opts.overrides ?? {};
	const unresolved = missingRequired.filter((field) => !(field in overrides));
	if (unresolved.length > 0) {
		return {
			ok: false,
			adapter: adapter.id,
			reason: "missing_required_fields",
			missing_required_fields: unresolved,
		};
	}

	const patchValues: Record<string, string> = {};
	for (const [key, value] of Object.entries(overrides)) {
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			patchValues[key] = trimmed;
		}
	}

	let configPath: string | null = null;
	const updatedFields = Object.keys(patchValues);
	if (updatedFields.length > 0) {
		const patch = patchForAdapterValues(adapter.id, patchValues);
		const writeResult = await writeConfigPatch(patch);
		configPath = writeResult.config_path;
	}

	resetChecksCache();

	const reload = await reloadControlPlaneInProcess(`mu_setup_apply_${adapter.id}`);
	return {
		ok: true,
		adapter: adapter.id,
		updated_fields: updatedFields,
		config_path: configPath,
		reload,
	};
}

export function buildVerifyOutcome(
	checks: AdapterCheck[],
	opts: { adapterId?: AdapterId; publicBaseUrl?: string },
): VerifyOutcome {
	const targets = opts.adapterId ? checks.filter((check) => check.id === opts.adapterId) : checks;
	const normalizedBase = normalizePublicBaseUrl(opts.publicBaseUrl);
	const ok = targets.every((check) => check.state === "active");
	return {
		ok,
		targets,
		public_base_url: normalizedBase,
	};
}
