import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { createMuResourceLoader, resolveModel } from "./backend.js";
import { MU_DEFAULT_THEME_NAME, MU_DEFAULT_THEME_PATH } from "./ui_defaults.js";

export type MuSessionPersistenceMode = "in-memory" | "continue-recent" | "new" | "open";

export type MuSessionPersistenceOpts = {
	mode?: MuSessionPersistenceMode;
	sessionDir?: string;
	sessionFile?: string;
};

export type CreateMuSessionOpts = {
	cwd: string;
	systemPrompt?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	extensionPaths?: string[];
	session?: MuSessionPersistenceOpts;
};

export type MuSession = {
	subscribe: (listener: (event: any) => void) => () => void;
	prompt: (text: string, options?: { expandPromptTemplates?: boolean }) => Promise<void>;
	dispose: () => void;
	bindExtensions: (bindings: any) => Promise<void>;
	agent: { waitForIdle: () => Promise<void> };
	sessionId?: string;
	sessionFile?: string;
	sessionManager?: {
		getLeafId?: () => string | null;
	};
};

type SessionManagerFactory = {
	inMemory: (cwd: string) => any;
	continueRecent: (cwd: string, sessionDir?: string) => any;
	create: (cwd: string, sessionDir?: string) => any;
	open: (sessionFile: string, sessionDir?: string) => any;
};

function createSessionManager(
	SessionManager: SessionManagerFactory,
	cwd: string,
	sessionOpts: MuSessionPersistenceOpts | undefined,
): any {
	const mode: MuSessionPersistenceMode = sessionOpts?.mode ?? (sessionOpts?.sessionFile ? "open" : "continue-recent");
	const sessionDir = sessionOpts?.sessionDir;

	switch (mode) {
		case "continue-recent":
			return SessionManager.continueRecent(cwd, sessionDir);
		case "new":
			return SessionManager.create(cwd, sessionDir);
		case "open": {
			const sessionFile = sessionOpts?.sessionFile?.trim();
			if (!sessionFile) {
				throw new Error("session.mode=open requires session.sessionFile");
			}
			return SessionManager.open(sessionFile, sessionDir);
		}
		default:
			return SessionManager.inMemory(cwd);
	}
}

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

	const settingsManager = SettingsManager.inMemory({ theme: MU_DEFAULT_THEME_NAME, quietStartup: true });
	const resourceLoader = createMuResourceLoader({
		cwd: opts.cwd,
		systemPrompt: opts.systemPrompt ?? "You are mu, an AI assistant.",
		settingsManager,
		additionalExtensionPaths: opts.extensionPaths,
		additionalThemePaths: [MU_DEFAULT_THEME_PATH],
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
		sessionManager: createSessionManager(SessionManager as SessionManagerFactory, opts.cwd, opts.session),
		settingsManager,
		resourceLoader,
		authStorage,
	});

	return session;
}
