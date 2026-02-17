import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { createMuResourceLoader, resolveModel } from "./backend.js";

export type CreateMuSessionOpts = {
	cwd: string;
	systemPrompt?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	extensionPaths?: string[];
};

export type MuSession = {
	subscribe: (listener: (event: any) => void) => () => void;
	prompt: (text: string, options?: { expandPromptTemplates?: boolean }) => Promise<void>;
	dispose: () => void;
	bindExtensions: (bindings: any) => Promise<void>;
	agent: { waitForIdle: () => Promise<void> };
};

export async function createMuSession(opts: CreateMuSessionOpts): Promise<MuSession> {
	const { AuthStorage, createAgentSession, SessionManager, SettingsManager } = await import(
		"@mariozechner/pi-coding-agent"
	);

	const authStorage = AuthStorage.create();
	const defaultModel = "gpt-5.3-codex";
	const modelId = opts.model ?? defaultModel;
	const model = resolveModel(modelId, authStorage, opts.provider);
	if (!model) {
		const scope = opts.provider ? ` in provider "${opts.provider}"` : "";
		throw new Error(`Model "${modelId}" not found${scope} in pi-ai registry.`);
	}

	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = createMuResourceLoader({
		cwd: opts.cwd,
		systemPrompt: opts.systemPrompt ?? "You are mu, an AI assistant.",
		settingsManager,
		additionalExtensionPaths: opts.extensionPaths,
	});
	await resourceLoader.reload();

	const tools = [
		createBashTool(opts.cwd),
		createReadTool(opts.cwd),
		createWriteTool(opts.cwd),
		createEditTool(opts.cwd),
	];

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model,
		tools,
		thinkingLevel: (opts.thinking ?? "minimal") as ThinkingLevel,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
		resourceLoader,
		authStorage,
	});

	return session;
}
