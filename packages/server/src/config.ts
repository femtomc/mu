import { getStorePaths } from "@femtomc/mu-core/node";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type MuConfig = {
	version: 1;
	control_plane: {
		adapters: {
			slack: {
				signing_secret: string | null;
			};
			discord: {
				signing_secret: string | null;
			};
			telegram: {
				webhook_secret: string | null;
				bot_token: string | null;
				bot_username: string | null;
			};
			neovim: {
				shared_secret: string | null;
			};
		};
		operator: {
			enabled: boolean;
			run_triggers_enabled: boolean;
			provider: string | null;
			model: string | null;
			thinking: string | null;
		};
		memory_index: {
			enabled: boolean;
			every_ms: number;
		};
	};
};

export type MuConfigPatch = {
	control_plane?: {
		adapters?: {
			slack?: {
				signing_secret?: string | null;
			};
			discord?: {
				signing_secret?: string | null;
			};
			telegram?: {
				webhook_secret?: string | null;
				bot_token?: string | null;
				bot_username?: string | null;
			};
			neovim?: {
				shared_secret?: string | null;
			};
		};
		operator?: {
			enabled?: boolean;
			run_triggers_enabled?: boolean;
			provider?: string | null;
			model?: string | null;
			thinking?: string | null;
		};
		memory_index?: {
			enabled?: boolean;
			every_ms?: number;
		};
	};
};

type ControlPlanePatch = NonNullable<MuConfigPatch["control_plane"]>;
type AdaptersPatch = NonNullable<ControlPlanePatch["adapters"]>;
type TelegramPatch = NonNullable<AdaptersPatch["telegram"]>;
type NeovimPatch = NonNullable<AdaptersPatch["neovim"]>;
type MemoryIndexPatch = NonNullable<ControlPlanePatch["memory_index"]>;

export type MuConfigPresence = {
	control_plane: {
		adapters: {
			slack: {
				signing_secret: boolean;
			};
			discord: {
				signing_secret: boolean;
			};
			telegram: {
				webhook_secret: boolean;
				bot_token: boolean;
				bot_username: boolean;
			};
			neovim: {
				shared_secret: boolean;
			};
		};
		operator: {
			enabled: boolean;
			run_triggers_enabled: boolean;
			provider: boolean;
			model: boolean;
			thinking: boolean;
		};
		memory_index: {
			enabled: boolean;
			every_ms: number;
		};
	};
};

export const DEFAULT_MU_CONFIG: MuConfig = {
	version: 1,
	control_plane: {
		adapters: {
			slack: {
				signing_secret: null,
			},
			discord: {
				signing_secret: null,
			},
			telegram: {
				webhook_secret: null,
				bot_token: null,
				bot_username: null,
			},
			neovim: {
				shared_secret: null,
			},
		},
		operator: {
			enabled: true,
			run_triggers_enabled: true,
			provider: null,
			model: null,
			thinking: null,
		},
		memory_index: {
			enabled: true,
			every_ms: 300_000,
		},
	},
};

function cloneDefault(): MuConfig {
	return JSON.parse(JSON.stringify(DEFAULT_MU_CONFIG)) as MuConfig;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function normalizeNullableString(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
		if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	}
	return fallback;
}

function normalizeInteger(value: unknown, fallback: number, opts: { min?: number; max?: number } = {}): number {
	const min = opts.min ?? Number.NEGATIVE_INFINITY;
	const max = opts.max ?? Number.POSITIVE_INFINITY;
	const clamp = (next: number): number => Math.min(max, Math.max(min, Math.trunc(next)));

	if (typeof value === "number" && Number.isFinite(value)) {
		return clamp(value);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) {
			return clamp(parsed);
		}
	}
	return clamp(fallback);
}

export function normalizeMuConfig(input: unknown): MuConfig {
	const next = cloneDefault();
	const root = asRecord(input);
	if (!root) return next;

	const controlPlane = asRecord(root.control_plane);
	if (!controlPlane) return next;

	const adapters = asRecord(controlPlane.adapters);
	if (adapters) {
		const slack = asRecord(adapters.slack);
		if (slack && "signing_secret" in slack) {
			next.control_plane.adapters.slack.signing_secret = normalizeNullableString(slack.signing_secret);
		}

		const discord = asRecord(adapters.discord);
		if (discord && "signing_secret" in discord) {
			next.control_plane.adapters.discord.signing_secret = normalizeNullableString(discord.signing_secret);
		}

		const telegram = asRecord(adapters.telegram);
		if (telegram) {
			if ("webhook_secret" in telegram) {
				next.control_plane.adapters.telegram.webhook_secret = normalizeNullableString(telegram.webhook_secret);
			}
			if ("bot_token" in telegram) {
				next.control_plane.adapters.telegram.bot_token = normalizeNullableString(telegram.bot_token);
			}
			if ("bot_username" in telegram) {
				next.control_plane.adapters.telegram.bot_username = normalizeNullableString(telegram.bot_username);
			}
		}

		const neovim = asRecord(adapters.neovim);
		if (neovim && "shared_secret" in neovim) {
			next.control_plane.adapters.neovim.shared_secret = normalizeNullableString(neovim.shared_secret);
		}
	}

	const operator = asRecord(controlPlane.operator);
	if (operator) {
		if ("enabled" in operator) {
			next.control_plane.operator.enabled = normalizeBoolean(operator.enabled, next.control_plane.operator.enabled);
		}
		if ("run_triggers_enabled" in operator) {
			next.control_plane.operator.run_triggers_enabled = normalizeBoolean(
				operator.run_triggers_enabled,
				next.control_plane.operator.run_triggers_enabled,
			);
		}
		if ("provider" in operator) {
			next.control_plane.operator.provider = normalizeNullableString(operator.provider);
		}
		if ("model" in operator) {
			next.control_plane.operator.model = normalizeNullableString(operator.model);
		}
		if ("thinking" in operator) {
			next.control_plane.operator.thinking = normalizeNullableString(operator.thinking);
		}
	}

	const memoryIndex = asRecord(controlPlane.memory_index);
	if (memoryIndex) {
		if ("enabled" in memoryIndex) {
			next.control_plane.memory_index.enabled = normalizeBoolean(
				memoryIndex.enabled,
				next.control_plane.memory_index.enabled,
			);
		}
		if ("every_ms" in memoryIndex) {
			next.control_plane.memory_index.every_ms = normalizeInteger(
				memoryIndex.every_ms,
				next.control_plane.memory_index.every_ms,
				{ min: 1_000, max: 86_400_000 },
			);
		}
	}

	return next;
}

function normalizeMuConfigPatch(input: unknown): MuConfigPatch {
	const root = asRecord(input);
	if (!root) return {};

	const patch: MuConfigPatch = {};
	const controlPlane = asRecord(root.control_plane);
	if (!controlPlane) return patch;

	patch.control_plane = {};

	const adapters = asRecord(controlPlane.adapters);
	if (adapters) {
		patch.control_plane.adapters = {};

		const slack = asRecord(adapters.slack);
		if (slack && "signing_secret" in slack) {
			patch.control_plane.adapters.slack = {
				signing_secret: normalizeNullableString(slack.signing_secret),
			};
		}

		const discord = asRecord(adapters.discord);
		if (discord && "signing_secret" in discord) {
			patch.control_plane.adapters.discord = {
				signing_secret: normalizeNullableString(discord.signing_secret),
			};
		}

		const telegram = asRecord(adapters.telegram);
		if (telegram) {
			const telegramPatch: TelegramPatch = {};
			if ("webhook_secret" in telegram) {
				telegramPatch.webhook_secret = normalizeNullableString(telegram.webhook_secret);
			}
			if ("bot_token" in telegram) {
				telegramPatch.bot_token = normalizeNullableString(telegram.bot_token);
			}
			if ("bot_username" in telegram) {
				telegramPatch.bot_username = normalizeNullableString(telegram.bot_username);
			}
			if (Object.keys(telegramPatch).length > 0) {
				patch.control_plane.adapters.telegram = telegramPatch;
			}
		}

		const neovim = asRecord(adapters.neovim);
		if (neovim) {
			const neovimPatch: NeovimPatch = {};
			if ("shared_secret" in neovim) {
				neovimPatch.shared_secret = normalizeNullableString(neovim.shared_secret);
			}
			if (Object.keys(neovimPatch).length > 0) {
				patch.control_plane.adapters.neovim = neovimPatch;
			}
		}
	}

	const operator = asRecord(controlPlane.operator);
	if (operator) {
		patch.control_plane.operator = {};
		if ("enabled" in operator) {
			patch.control_plane.operator.enabled = normalizeBoolean(
				operator.enabled,
				DEFAULT_MU_CONFIG.control_plane.operator.enabled,
			);
		}
		if ("run_triggers_enabled" in operator) {
			patch.control_plane.operator.run_triggers_enabled = normalizeBoolean(
				operator.run_triggers_enabled,
				DEFAULT_MU_CONFIG.control_plane.operator.run_triggers_enabled,
			);
		}
		if ("provider" in operator) {
			patch.control_plane.operator.provider = normalizeNullableString(operator.provider);
		}
		if ("model" in operator) {
			patch.control_plane.operator.model = normalizeNullableString(operator.model);
		}
		if ("thinking" in operator) {
			patch.control_plane.operator.thinking = normalizeNullableString(operator.thinking);
		}
		if (Object.keys(patch.control_plane.operator).length === 0) {
			delete patch.control_plane.operator;
		}
	}

	const memoryIndex = asRecord(controlPlane.memory_index);
	if (memoryIndex) {
		const memoryIndexPatch: MemoryIndexPatch = {};
		if ("enabled" in memoryIndex) {
			memoryIndexPatch.enabled = normalizeBoolean(memoryIndex.enabled, DEFAULT_MU_CONFIG.control_plane.memory_index.enabled);
		}
		if ("every_ms" in memoryIndex) {
			memoryIndexPatch.every_ms = normalizeInteger(memoryIndex.every_ms, DEFAULT_MU_CONFIG.control_plane.memory_index.every_ms, {
				min: 1_000,
				max: 86_400_000,
			});
		}
		if (Object.keys(memoryIndexPatch).length > 0) {
			patch.control_plane.memory_index = memoryIndexPatch;
		}
	}

	if (patch.control_plane.adapters && Object.keys(patch.control_plane.adapters).length === 0) {
		delete patch.control_plane.adapters;
	}
	if (Object.keys(patch.control_plane).length === 0) {
		delete patch.control_plane;
	}

	return patch;
}

export function applyMuConfigPatch(base: MuConfig, patchInput: unknown): MuConfig {
	const patch = normalizeMuConfigPatch(patchInput);
	const next = normalizeMuConfig(base);

	if (!patch.control_plane) {
		return next;
	}

	const adapters = patch.control_plane.adapters;
	if (adapters) {
		if (adapters.slack && "signing_secret" in adapters.slack) {
			next.control_plane.adapters.slack.signing_secret = adapters.slack.signing_secret ?? null;
		}
		if (adapters.discord && "signing_secret" in adapters.discord) {
			next.control_plane.adapters.discord.signing_secret = adapters.discord.signing_secret ?? null;
		}
		if (adapters.telegram) {
			if ("webhook_secret" in adapters.telegram) {
				next.control_plane.adapters.telegram.webhook_secret = adapters.telegram.webhook_secret ?? null;
			}
			if ("bot_token" in adapters.telegram) {
				next.control_plane.adapters.telegram.bot_token = adapters.telegram.bot_token ?? null;
			}
			if ("bot_username" in adapters.telegram) {
				next.control_plane.adapters.telegram.bot_username = adapters.telegram.bot_username ?? null;
			}
		}
		if (adapters.neovim && "shared_secret" in adapters.neovim) {
			next.control_plane.adapters.neovim.shared_secret = adapters.neovim.shared_secret ?? null;
		}
	}

	const operator = patch.control_plane.operator;
	if (operator) {
		if ("enabled" in operator && typeof operator.enabled === "boolean") {
			next.control_plane.operator.enabled = operator.enabled;
		}
		if ("run_triggers_enabled" in operator && typeof operator.run_triggers_enabled === "boolean") {
			next.control_plane.operator.run_triggers_enabled = operator.run_triggers_enabled;
		}
		if ("provider" in operator) {
			next.control_plane.operator.provider = operator.provider ?? null;
		}
		if ("model" in operator) {
			next.control_plane.operator.model = operator.model ?? null;
		}
		if ("thinking" in operator) {
			next.control_plane.operator.thinking = operator.thinking ?? null;
		}
	}

	const memoryIndex = patch.control_plane.memory_index;
	if (memoryIndex) {
		if ("enabled" in memoryIndex && typeof memoryIndex.enabled === "boolean") {
			next.control_plane.memory_index.enabled = memoryIndex.enabled;
		}
		if ("every_ms" in memoryIndex && typeof memoryIndex.every_ms === "number" && Number.isFinite(memoryIndex.every_ms)) {
			next.control_plane.memory_index.every_ms = normalizeInteger(
				memoryIndex.every_ms,
				next.control_plane.memory_index.every_ms,
				{ min: 1_000, max: 86_400_000 },
			);
		}
	}

	return next;
}

export function getMuConfigPath(repoRoot: string): string {
	return join(getStorePaths(repoRoot).storeDir, "config.json");
}

export async function readMuConfigFile(repoRoot: string): Promise<MuConfig> {
	const path = getMuConfigPath(repoRoot);
	try {
		const raw = await Bun.file(path).text();
		const parsed = JSON.parse(raw) as unknown;
		return normalizeMuConfig(parsed);
	} catch (err) {
		const code = (err as { code?: string })?.code;
		if (code === "ENOENT") {
			return cloneDefault();
		}
		throw err;
	}
}

export async function writeMuConfigFile(repoRoot: string, config: MuConfig): Promise<string> {
	const path = getMuConfigPath(repoRoot);
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, `${JSON.stringify(normalizeMuConfig(config), null, 2)}\n`);
	try {
		await chmod(path, 0o600);
	} catch {
		// Best effort only.
	}
	return path;
}

function redacted(value: string | null): string | null {
	if (!value) return null;
	return "***";
}

export function redactMuConfigSecrets(config: MuConfig): MuConfig {
	const next = normalizeMuConfig(config);
	next.control_plane.adapters.slack.signing_secret = redacted(next.control_plane.adapters.slack.signing_secret);
	next.control_plane.adapters.discord.signing_secret = redacted(next.control_plane.adapters.discord.signing_secret);
	next.control_plane.adapters.telegram.webhook_secret = redacted(next.control_plane.adapters.telegram.webhook_secret);
	next.control_plane.adapters.telegram.bot_token = redacted(next.control_plane.adapters.telegram.bot_token);
	next.control_plane.adapters.neovim.shared_secret = redacted(next.control_plane.adapters.neovim.shared_secret);
	return next;
}

function isPresent(value: string | null): boolean {
	return typeof value === "string" && value.length > 0;
}

export function muConfigPresence(config: MuConfig): MuConfigPresence {
	return {
		control_plane: {
			adapters: {
				slack: {
					signing_secret: isPresent(config.control_plane.adapters.slack.signing_secret),
				},
				discord: {
					signing_secret: isPresent(config.control_plane.adapters.discord.signing_secret),
				},
				telegram: {
					webhook_secret: isPresent(config.control_plane.adapters.telegram.webhook_secret),
					bot_token: isPresent(config.control_plane.adapters.telegram.bot_token),
					bot_username: isPresent(config.control_plane.adapters.telegram.bot_username),
				},
				neovim: {
					shared_secret: isPresent(config.control_plane.adapters.neovim.shared_secret),
				},
			},
			operator: {
				enabled: config.control_plane.operator.enabled,
				run_triggers_enabled: config.control_plane.operator.run_triggers_enabled,
				provider: isPresent(config.control_plane.operator.provider),
				model: isPresent(config.control_plane.operator.model),
				thinking: isPresent(config.control_plane.operator.thinking),
			},
			memory_index: {
				enabled: config.control_plane.memory_index.enabled,
				every_ms: config.control_plane.memory_index.every_ms,
			},
		},
	};
}
