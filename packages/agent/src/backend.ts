import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { findRepoRoot, getMuHomeDir, getStorePaths } from "@femtomc/mu-core/node";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	type CreateAgentSessionOptions,
	createAgentSession,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { MuRole } from "./mu_roles.js";
import { orchestratorToolExtensionPaths, workerToolExtensionPaths } from "./extensions/index.js";
import { MU_DEFAULT_THEME_NAME, MU_DEFAULT_THEME_PATH } from "./ui_defaults.js";

export type BackendRunOpts = {
	issueId: string;
	role: MuRole;
	systemPrompt: string;
	prompt: string;
	provider: string;
	model: string;
	thinking: string;
	cwd: string;
	logSuffix: string;
	onLine?: (line: string) => void;
	teePath?: string;
};

export interface BackendRunner {
	run(opts: BackendRunOpts): Promise<number>;
}

export function streamHasError(line: string): boolean {
	let event: any;
	try {
		event = JSON.parse(line) as any;
	} catch {
		return false;
	}

	const etype = event?.type;
	if (etype === "message_update") {
		const assistantEvent = event?.assistantMessageEvent;
		if (assistantEvent && typeof assistantEvent === "object" && assistantEvent.type === "error") {
			return true;
		}
	}

	if (etype === "message_end") {
		const message = event?.message;
		if (!message || typeof message !== "object") {
			return false;
		}
		if (message.role !== "assistant") {
			return false;
		}
		return message.stopReason === "error" || message.stopReason === "aborted";
	}

	return false;
}


/**
 * Resolve a bare model ID (e.g. "gpt-5.3-codex") to a pi-ai Model object.
 *
 * When multiple providers offer the same model ID, prefer providers that
 * have auth configured (env var, OAuth, or stored API key).
 */
export function resolveModel(
	modelId: string,
	authStorage: AuthStorage,
	providerConstraint?: string,
): Model<any> | undefined {
	if (providerConstraint) {
		const providers = getProviders();
		if (!providers.includes(providerConstraint as any)) {
			throw new Error(`Unknown provider "${providerConstraint}". Available: ${providers.join(", ")}`);
		}

		const models = getModels(providerConstraint as any);
		return models.find((m) => m.id === modelId);
	}

	let fallback: Model<any> | undefined;

	for (const provider of getProviders()) {
		const models = getModels(provider);
		const match = models.find((m) => m.id === modelId);
		if (!match) continue;

		// Prefer providers that have auth configured.
		if (authStorage.hasAuth(provider)) {
			return match;
		}
		// Keep first match as fallback.
		if (!fallback) {
			fallback = match;
		}
	}

	return fallback;
}

/**
 * In-process backend using the SDK.
 *
 * Uses `createAgentSession` from `@mariozechner/pi-coding-agent`.
 */
export class SdkBackend implements BackendRunner {
	async run(opts: BackendRunOpts): Promise<number> {
		const authStorage = AuthStorage.create();
		const model = resolveModel(opts.model, authStorage, opts.provider);
		if (!model) {
			const scope = opts.provider ? ` in provider "${opts.provider}"` : "";
			throw new Error(`Model "${opts.model}" not found${scope} in pi-ai registry.`);
		}

		const settingsManager = SettingsManager.inMemory({ theme: MU_DEFAULT_THEME_NAME, quietStartup: true });
		const roleExtensionPaths =
			opts.role === "orchestrator" ? orchestratorToolExtensionPaths : workerToolExtensionPaths;
		const resourceLoader = createMuResourceLoader({
			cwd: opts.cwd,
			systemPrompt: opts.systemPrompt,
			settingsManager,
			additionalExtensionPaths: roleExtensionPaths,
		});
		await resourceLoader.reload();

		const tools = [
			createBashTool(opts.cwd),
			createReadTool(opts.cwd),
			createWriteTool(opts.cwd),
			createEditTool(opts.cwd),
		];

		const sessionOpts: CreateAgentSessionOptions = {
			cwd: opts.cwd,
			model,
			thinkingLevel: opts.thinking as ThinkingLevel,
			tools,
			sessionManager: SessionManager.inMemory(opts.cwd),
			settingsManager,
			resourceLoader,
			authStorage,
		};

		const { session } = await createAgentSession(sessionOpts);

		let teeFh: Awaited<ReturnType<typeof open>> | null = null;
		try {
			if (opts.teePath) {
				await mkdir(dirname(opts.teePath), { recursive: true });
				teeFh = await open(opts.teePath, "w");
			}

			// Bind extensions (required for tools to work in print mode).
			await session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => session.agent.waitForIdle(),
					newSession: async () => ({ cancelled: true }),
					fork: async () => ({ cancelled: true }),
					navigateTree: async () => ({ cancelled: true }),
					switchSession: async () => ({ cancelled: true }),
					reload: async () => {},
				},
				onError: () => {},
			});

			let sawError = false;

			const DELTA_TYPES = new Set(["thinking_delta", "toolcall_delta", "text_delta"]);

			// Subscribe to events — serialize to JSONL for tee and error detection.
			const unsub = session.subscribe((event) => {
				const line = JSON.stringify(event);

				if (streamHasError(line)) {
					sawError = true;
				}

				// onLine gets everything (CLI needs deltas for live rendering).
				opts.onLine?.(line);

				// Tee file: skip streaming deltas (they carry the full accumulated
				// message state on every token, causing quadratic log growth).
				// Structural events (message_start/end, turn_start/end, tool_execution_*,
				// thinking_start/end, toolcall_start/end) are kept.
				if (teeFh) {
					const aType = (event as any)?.assistantMessageEvent?.type;
					if (!DELTA_TYPES.has(aType)) {
						teeFh.write(`${line}\n`).catch(() => {});
					}
				}
			});

			try {
				await session.prompt(opts.prompt, { expandPromptTemplates: false });
			} finally {
				unsub();
			}

			return sawError ? 1 : 0;
		} finally {
			session.dispose();
			if (teeFh) {
				await teeFh.close();
			}
		}
	}
}


export type CreateMuResourceLoaderOpts = {
	cwd: string;
	systemPrompt: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalThemePaths?: string[];
};

export function createMuResourceLoader(opts: CreateMuResourceLoaderOpts): DefaultResourceLoader {
	const repoRoot = findRepoRoot(opts.cwd);
	const storePaths = getStorePaths(repoRoot);
	const piAgentDir = opts.agentDir ?? getAgentDir();

	const skillPaths: string[] = [];
	const seenSkillPaths = new Set<string>();
	const addSkillPath = (path: string, requireExists: boolean): void => {
		if (requireExists && !existsSync(path)) {
			return;
		}
		if (seenSkillPaths.has(path)) {
			return;
		}
		seenSkillPaths.add(path);
		skillPaths.push(path);
	};

	// Preference order (first match wins on skill-name collisions):
	// mu workspace -> mu global -> repo top-level -> explicit additions -> pi project -> pi global.
	addSkillPath(join(storePaths.storeDir, "skills"), true);
	addSkillPath(join(getMuHomeDir(), "skills"), true);
	addSkillPath(join(repoRoot, "skills"), true);
	for (const p of opts.additionalSkillPaths ?? []) {
		addSkillPath(p, false);
	}
	addSkillPath(join(repoRoot, ".pi", "skills"), true);
	addSkillPath(join(piAgentDir, "skills"), true);

	const themePaths = new Set<string>([MU_DEFAULT_THEME_PATH]);
	for (const p of opts.additionalThemePaths ?? []) {
		themePaths.add(p);
	}

	return new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		settingsManager: opts.settingsManager ?? SettingsManager.inMemory({ theme: MU_DEFAULT_THEME_NAME, quietStartup: true }),
		additionalExtensionPaths: opts.additionalExtensionPaths,
		noSkills: true,
		additionalSkillPaths: skillPaths,
		additionalThemePaths: [...themePaths],
		systemPromptOverride: (_base) => opts.systemPrompt,
		agentsFilesOverride: (base) => ({
			agentsFiles: base.agentsFiles.filter((f) => basename(f.path) === "AGENTS.md"),
		}),
	});
}
