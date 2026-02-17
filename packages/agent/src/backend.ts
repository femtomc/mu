import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { MuRole } from "./mu_roles.js";

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
		const authStorage = new AuthStorage();
		const model = resolveModel(opts.model, authStorage, opts.provider);
		if (!model) {
			const scope = opts.provider ? ` in provider "${opts.provider}"` : "";
			throw new Error(`Model "${opts.model}" not found${scope} in pi-ai registry.`);
		}

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = createMuResourceLoader({
			cwd: opts.cwd,
			systemPrompt: opts.systemPrompt,
			settingsManager,
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
};

export function createMuResourceLoader(opts: CreateMuResourceLoaderOpts): DefaultResourceLoader {
	const skillPaths = new Set<string>();
	for (const p of opts.additionalSkillPaths ?? []) {
		skillPaths.add(p);
	}

	// If a repo has a top-level `skills/` dir (like workshop/), load it.
	const repoSkills = join(opts.cwd, "skills");
	if (existsSync(repoSkills)) {
		skillPaths.add(repoSkills);
	}

	return new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		settingsManager: opts.settingsManager ?? SettingsManager.inMemory(),
		additionalExtensionPaths: opts.additionalExtensionPaths,
		additionalSkillPaths: [...skillPaths],
		systemPromptOverride: (_base) => opts.systemPrompt,
		agentsFilesOverride: (base) => ({
			agentsFiles: base.agentsFiles.filter((f) => basename(f.path) === "AGENTS.md"),
		}),
	});
}
