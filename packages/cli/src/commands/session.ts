import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import chalk from "chalk";

export type SessionCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type OperatorSessionStartMode = "in-memory" | "continue-recent" | "new" | "open";

type OperatorSessionStartOpts = {
	mode: OperatorSessionStartMode;
	sessionDir?: string;
	sessionFile?: string;
};

type PersistedOperatorSessionRow = {
	id: string;
	path: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	name?: string;
};

export type SessionCommandCtx = {
	cwd: string;
	repoRoot: string;
	paths: {
		storeDir: string;
	};
};

export type SessionCommandDeps<Ctx extends SessionCommandCtx> = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => SessionCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => SessionCommandRunResult;
	fileExists: (path: string) => Promise<boolean>;
	trimForHeader: (text: string, maxLen: number) => string;
	runServeLifecycle: (
		ctx: Ctx,
		opts: {
			commandName: "serve" | "run" | "session";
			port: number;
			operatorProvider?: string;
			operatorModel?: string;
			operatorThinking?: string;
			operatorSession?: OperatorSessionStartOpts;
		},
	) => Promise<SessionCommandRunResult>;
};

function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed;
		}
	}
	return new Date(0);
}

type SessionKind = "operator" | "cp_operator";
const SESSION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type SessionThinkingLevel = (typeof SESSION_THINKING_LEVELS)[number];
const SESSION_THINKING_LEVEL_SET = new Set<string>(SESSION_THINKING_LEVELS);

function normalizeSessionKind(value: string | null | undefined): SessionKind | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase().replaceAll("-", "_");
	if (normalized === "operator") {
		return "operator";
	}
	if (normalized === "cpoperator" || normalized === "control_plane_operator" || normalized === "cp_operator") {
		return "cp_operator";
	}
	return null;
}

type SessionListKind = SessionKind | "all";

type SessionListWorkspace = {
	workspaceId: string;
	storeDir: string;
	isCurrent: boolean;
};

function normalizeSessionListKind(value: string | null | undefined): SessionListKind | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase().replaceAll("-", "_");
	if (normalized === "all") {
		return "all";
	}
	return normalizeSessionKind(normalized);
}

function sessionListTargetsForKind(storeDir: string, kind: SessionListKind): Array<{ sessionKind: SessionKind; sessionDir: string }> {
	if (kind === "all") {
		return [
			{ sessionKind: "operator", sessionDir: sessionDirForKind(storeDir, "operator") },
			{ sessionKind: "cp_operator", sessionDir: sessionDirForKind(storeDir, "cp_operator") },
		];
	}
	return [{ sessionKind: kind, sessionDir: sessionDirForKind(storeDir, kind) }];
}

async function resolveSessionListWorkspaces(storeDir: string, includeAllWorkspaces: boolean): Promise<SessionListWorkspace[]> {
	const currentStoreDir = resolve(storeDir);
	if (!includeAllWorkspaces) {
		return [
			{
				workspaceId: basename(currentStoreDir),
				storeDir: currentStoreDir,
				isCurrent: true,
			},
		];
	}

	const workspacesRoot = dirname(currentStoreDir);
	const out: SessionListWorkspace[] = [];
	const seen = new Set<string>();
	const push = (candidate: string): void => {
		const normalized = resolve(candidate);
		if (seen.has(normalized)) {
			return;
		}
		seen.add(normalized);
		out.push({
			workspaceId: basename(normalized),
			storeDir: normalized,
			isCurrent: normalized === currentStoreDir,
		});
	};

	push(currentStoreDir);
	try {
		const entries = await readdir(workspacesRoot, { withFileTypes: true });
		entries
			.filter((entry) => entry.isDirectory())
			.sort((left, right) => left.name.localeCompare(right.name))
			.forEach((entry) => push(join(workspacesRoot, entry.name)));
	} catch {
		// Best-effort only. Keep current workspace available even if workspace root listing fails.
	}

	out.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
	return out;
}

function normalizeSessionThinkingLevel(value: string | null | undefined): SessionThinkingLevel | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (!SESSION_THINKING_LEVEL_SET.has(normalized)) {
		return null;
	}
	return normalized as SessionThinkingLevel;
}

function isSafeSessionModelToken(value: string): boolean {
	return /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
}

function supportedThinkingLevelsForModel(opts: { reasoning: boolean; xhigh: boolean }): SessionThinkingLevel[] {
	const out: SessionThinkingLevel[] = ["off", "minimal"];
	if (opts.reasoning) {
		out.push("low", "medium", "high");
	}
	if (opts.xhigh) {
		out.push("xhigh");
	}
	return out;
}

function operatorSessionDir(storeDir: string): string {
	return join(storeDir, "operator", "sessions");
}

function cpOperatorSessionDir(storeDir: string): string {
	return join(storeDir, "control-plane", "operator-sessions");
}

function sessionDirForKind(storeDir: string, kind: SessionKind): string {
	return kind === "cp_operator" ? cpOperatorSessionDir(storeDir) : operatorSessionDir(storeDir);
}

function normalizePathForPrefixMatch(path: string): string {
	return resolve(path).replaceAll("\\", "/");
}

function inferSessionKindFromSessionPath(storeDir: string, sessionPath: string): SessionKind {
	const normalizedPath = normalizePathForPrefixMatch(sessionPath);
	const cpRoot = normalizePathForPrefixMatch(cpOperatorSessionDir(storeDir));
	if (normalizedPath === cpRoot || normalizedPath.startsWith(`${cpRoot}/`)) {
		return "cp_operator";
	}
	return "operator";
}

async function resolvePersistedSessionPathAcrossKinds(opts: {
	cwd: string;
	repoRoot: string;
	storeDir: string;
	selector: string;
	fileExists: (path: string) => Promise<boolean>;
}): Promise<{
	path: string | null;
	sessionKind: SessionKind | null;
	sessionDir: string | null;
	error?: string;
	recovery?: string[];
}> {
	const selector = opts.selector.trim();
	if (!selector) {
		return {
			path: null,
			sessionKind: null,
			sessionDir: null,
			error: "session selector must not be empty",
			recovery: ["mu session list --kind all"],
		};
	}

	if (isLikelySessionPath(selector)) {
		const candidate = resolveCliPath(opts.cwd, selector);
		if (!(await opts.fileExists(candidate))) {
			return {
				path: null,
				sessionKind: null,
				sessionDir: null,
				error: `session file not found: ${selector}`,
				recovery: ["mu session list --kind all", "mu session --new"],
			};
		}
		const inferredKind = inferSessionKindFromSessionPath(opts.storeDir, candidate);
		return {
			path: candidate,
			sessionKind: inferredKind,
			sessionDir: dirname(candidate),
		};
	}

	const targets: Array<{ sessionKind: SessionKind; sessionDir: string }> = [
		{ sessionKind: "operator", sessionDir: operatorSessionDir(opts.storeDir) },
		{ sessionKind: "cp_operator", sessionDir: cpOperatorSessionDir(opts.storeDir) },
	];
	const matches: Array<{ path: string; sessionKind: SessionKind; sessionDir: string }> = [];
	const ambiguities: Array<{ error: string; recovery: string[] }> = [];
	for (const target of targets) {
		const resolved = await resolvePersistedOperatorSessionPath({
			cwd: opts.cwd,
			repoRoot: opts.repoRoot,
			sessionDir: target.sessionDir,
			selector,
			fileExists: opts.fileExists,
		});
		if (resolved.path) {
			matches.push({
				path: resolved.path,
				sessionKind: target.sessionKind,
				sessionDir: target.sessionDir,
			});
			continue;
		}
		if (resolved.error?.startsWith("ambiguous session selector")) {
			ambiguities.push({
				error: resolved.error,
				recovery: resolved.recovery ?? ["mu session list --kind all"],
			});
		}
	}

	if (matches.length === 1) {
		const match = matches[0]!;
		return {
			path: match.path,
			sessionKind: match.sessionKind,
			sessionDir: match.sessionDir,
		};
	}
	if (matches.length > 1) {
		return {
			path: null,
			sessionKind: null,
			sessionDir: null,
			error: `ambiguous session selector across session kinds: ${selector}`,
			recovery: [
				"mu session list --kind all",
				...matches.slice(0, 10).map((match) => `mu session ${match.path}`),
			],
		};
	}
	if (ambiguities.length === 1) {
		return {
			path: null,
			sessionKind: null,
			sessionDir: null,
			error: ambiguities[0]!.error,
			recovery: ambiguities[0]!.recovery,
		};
	}
	if (ambiguities.length > 1) {
		return {
			path: null,
			sessionKind: null,
			sessionDir: null,
			error: `ambiguous session selector across session kinds: ${selector}`,
			recovery: ["mu session list --kind all"],
		};
	}

	return {
		path: null,
		sessionKind: null,
		sessionDir: null,
		error: `session not found in operator/cp_operator stores: ${selector}`,
		recovery: ["mu session list --kind all", "mu session --new"],
	};
}

function defaultOperatorSessionStart(storeDir: string, mostRecentSessionFile: string | null): OperatorSessionStartOpts {
	const sessionDir = operatorSessionDir(storeDir);
	if (mostRecentSessionFile) {
		return {
			mode: "open",
			sessionDir,
			sessionFile: mostRecentSessionFile,
		};
	}
	return {
		mode: "new",
		sessionDir,
	};
}

function resolveCliPath(cwd: string, rawPath: string): string {
	if (rawPath.startsWith("~/")) {
		const home = Bun.env.HOME ?? process.env.HOME;
		if (home) {
			return join(home, rawPath.slice(2));
		}
	}
	return resolve(cwd, rawPath);
}

function isLikelySessionPath(selector: string): boolean {
	return (
		selector.includes("/") ||
		selector.includes("\\") ||
		selector.endsWith(".jsonl") ||
		selector.startsWith(".") ||
		selector.startsWith("~")
	);
}

async function loadPersistedOperatorSessions(repoRoot: string, sessionDir: string): Promise<PersistedOperatorSessionRow[]> {
	const { SessionManager } = await import("@mariozechner/pi-coding-agent");
	const rows = (await SessionManager.list(repoRoot, sessionDir)) as Array<{
		id: unknown;
		path: unknown;
		created: unknown;
		modified: unknown;
		messageCount: unknown;
		firstMessage: unknown;
		name?: unknown;
	}>;
	const sessions = rows
		.map((row): PersistedOperatorSessionRow | null => {
			const id = typeof row.id === "string" ? row.id : "";
			const path = typeof row.path === "string" ? row.path : "";
			if (!id || !path) {
				return null;
			}
			return {
				id,
				path,
				created: toDate(row.created),
				modified: toDate(row.modified),
				messageCount: typeof row.messageCount === "number" ? row.messageCount : 0,
				firstMessage: typeof row.firstMessage === "string" ? row.firstMessage : "",
				name: typeof row.name === "string" && row.name.trim().length > 0 ? row.name.trim() : undefined,
			};
		})
		.filter((row): row is PersistedOperatorSessionRow => row != null);
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

async function resolvePersistedOperatorSessionPath(opts: {
	cwd: string;
	repoRoot: string;
	sessionDir: string;
	selector: string;
	fileExists: (path: string) => Promise<boolean>;
}): Promise<{ path: string | null; error?: string; recovery?: string[] }> {
	const selector = opts.selector.trim();
	if (!selector) {
		return {
			path: null,
			error: "session selector must not be empty",
			recovery: ["mu session list"],
		};
	}

	if (isLikelySessionPath(selector)) {
		const candidate = resolveCliPath(opts.cwd, selector);
		if (await opts.fileExists(candidate)) {
			return { path: candidate };
		}
		return {
			path: null,
			error: `session file not found: ${selector}`,
			recovery: ["mu session list", "mu session --new"],
		};
	}

	const sessions = await loadPersistedOperatorSessions(opts.repoRoot, opts.sessionDir);
	const exact = sessions.filter((session) => session.id === selector);
	if (exact.length === 1) {
		return { path: exact[0]!.path };
	}

	const prefix = sessions.filter((session) => session.id.startsWith(selector));
	if (prefix.length === 1) {
		return { path: prefix[0]!.path };
	}
	if (prefix.length > 1) {
		return {
			path: null,
			error: `ambiguous session selector: ${selector}`,
			recovery: prefix.slice(0, 10).map((session) => `mu session ${session.id}`),
		};
	}

	const filePrefix = sessions.filter((session) => basename(session.path).startsWith(selector));
	if (filePrefix.length === 1) {
		return { path: filePrefix[0]!.path };
	}
	if (filePrefix.length > 1) {
		return {
			path: null,
			error: `ambiguous session selector: ${selector}`,
			recovery: filePrefix.slice(0, 10).map((session) => `mu session ${session.id}`),
		};
	}

	return {
		path: null,
		error: `session not found: ${selector}`,
		recovery: ["mu session list", "mu session --new"],
	};
}

function sessionConfigHelp(): string {
	return [
		"mu session config - inspect/update one session's model + thinking",
		"",
		"Usage:",
		"  mu session config get --session-id <id> [--session-kind operator|cp_operator]",
		"  mu session config set-model --session-id <id> --provider <id> --model <id> [--thinking <level>]",
		"  mu session config set-thinking --session-id <id> --thinking <level>",
		"",
		"Optional selectors:",
		"  --session-file <path>   Direct path to session file (overrides --session-id lookup)",
		"  --session-dir <path>    Explicit session directory for id lookup",
		"  --session-kind <kind>   operator or cp_operator (optional; auto-detected when omitted)",
		"",
		"Notes:",
		"  - Session config is session-scoped and does not modify workspace global defaults",
		"    from `mu control operator set` / `mu control operator thinking-set`.",
		"  - For active interactive sessions, reconnect after updates to guarantee live application.",
		"",
		"Examples:",
		"  mu session config get --session-id <id>",
		"  mu session config set-model --session-id <id> --provider openai-codex --model gpt-5.3-codex --thinking high",
		"  mu session config set-thinking --session-id <id> --thinking minimal",
		"  mu session config get --session-kind cp_operator --session-id <id>",
	].join("\n");
}

type ResolvedSessionConfigTarget = {
	sessionKind: SessionKind;
	sessionDir: string;
	sessionFile: string;
};

async function resolveSessionConfigTarget(opts: {
	cwd: string;
	repoRoot: string;
	storeDir: string;
	fileExists: (path: string) => Promise<boolean>;
	sessionId: string | null;
	sessionKindRaw: string | null;
	sessionDirRaw: string | null;
	sessionFileRaw: string | null;
}): Promise<{ ok: true; target: ResolvedSessionConfigTarget } | { ok: false; error: string; recovery: string[] }> {
	const explicitSessionKind = normalizeSessionKind(opts.sessionKindRaw);
	if (opts.sessionKindRaw != null && explicitSessionKind == null) {
		return {
			ok: false,
			error: `invalid --session-kind: ${JSON.stringify(opts.sessionKindRaw)} (supported: operator, cp_operator)`,
			recovery: ["mu session config --help"],
		};
	}

	if (opts.sessionFileRaw) {
		const sessionFile = resolveCliPath(opts.cwd, opts.sessionFileRaw);
		if (!(await opts.fileExists(sessionFile))) {
			return {
				ok: false,
				error: `session file not found: ${opts.sessionFileRaw}`,
				recovery: ["mu session list --kind all", "mu session config --help"],
			};
		}
		const sessionDir = opts.sessionDirRaw
			? resolveCliPath(opts.cwd, opts.sessionDirRaw)
			: explicitSessionKind
				? sessionDirForKind(opts.storeDir, explicitSessionKind)
				: dirname(sessionFile);
		const sessionKind = explicitSessionKind ?? inferSessionKindFromSessionPath(opts.storeDir, sessionFile);
		return {
			ok: true,
			target: {
				sessionKind,
				sessionDir,
				sessionFile,
			},
		};
	}

	const sessionId = opts.sessionId?.trim();
	if (!sessionId) {
		return {
			ok: false,
			error: "missing --session-id (or provide --session-file)",
			recovery: ["mu session config --help"],
		};
	}

	if (opts.sessionDirRaw || explicitSessionKind) {
		const sessionDir = opts.sessionDirRaw
			? resolveCliPath(opts.cwd, opts.sessionDirRaw)
			: sessionDirForKind(opts.storeDir, explicitSessionKind ?? "operator");
		const resolved = await resolvePersistedOperatorSessionPath({
			cwd: opts.cwd,
			repoRoot: opts.repoRoot,
			sessionDir,
			selector: sessionId,
			fileExists: opts.fileExists,
		});
		if (!resolved.path) {
			return {
				ok: false,
				error: resolved.error ?? "unable to resolve session",
				recovery: resolved.recovery ?? ["mu session list --kind all", "mu session config --help"],
			};
		}
		const sessionKind = explicitSessionKind ?? inferSessionKindFromSessionPath(opts.storeDir, resolved.path);
		return {
			ok: true,
			target: {
				sessionKind,
				sessionDir,
				sessionFile: resolved.path,
			},
		};
	}

	const resolved = await resolvePersistedSessionPathAcrossKinds({
		cwd: opts.cwd,
		repoRoot: opts.repoRoot,
		storeDir: opts.storeDir,
		selector: sessionId,
		fileExists: opts.fileExists,
	});
	if (!resolved.path) {
		return {
			ok: false,
			error: resolved.error ?? "unable to resolve session",
			recovery: resolved.recovery ?? ["mu session list --kind all", "mu session config --help"],
		};
	}
	const sessionDir = resolved.sessionDir ?? dirname(resolved.path);
	const sessionKind = resolved.sessionKind ?? inferSessionKindFromSessionPath(opts.storeDir, resolved.path);
	return {
		ok: true,
		target: {
			sessionKind,
			sessionDir,
			sessionFile: resolved.path,
		},
	};
}

type SessionConfigSnapshot = {
	session_id: string;
	session_file: string;
	session_dir: string;
	session_kind: SessionKind;
	model: {
		provider: string | null;
		id: string | null;
	};
	thinking: string;
};

async function readSessionConfigSnapshot(opts: ResolvedSessionConfigTarget): Promise<SessionConfigSnapshot> {
	const { SessionManager } = await import("@mariozechner/pi-coding-agent");
	const sessionManager = SessionManager.open(opts.sessionFile, opts.sessionDir);
	const context = sessionManager.buildSessionContext();
	return {
		session_id: sessionManager.getSessionId(),
		session_file: opts.sessionFile,
		session_dir: opts.sessionDir,
		session_kind: opts.sessionKind,
		model: {
			provider: context.model?.provider ?? null,
			id: context.model?.modelId ?? null,
		},
		thinking: context.thinkingLevel,
	};
}

function forcePersistSessionConfig(sessionManager: unknown): void {
	const maybeManager = sessionManager as { _rewriteFile?: () => void };
	maybeManager._rewriteFile?.();
}

async function runSessionConfigCommand<Ctx extends SessionCommandCtx>(opts: {
	ctx: Ctx;
	deps: SessionCommandDeps<Ctx>;
	subcommand: string;
	providerRaw: string | null;
	modelRaw: string | null;
	thinkingRaw: string | null;
	sessionIdRaw: string | null;
	sessionKindRaw: string | null;
	sessionDirRaw: string | null;
	sessionFileRaw: string | null;
	jsonMode: boolean;
	pretty: boolean;
	restArgs: string[];
}): Promise<SessionCommandRunResult> {
	const { ctx, deps } = opts;
	const { jsonError, ok, jsonText } = deps;

	if (opts.subcommand !== "get" && opts.subcommand !== "set-model" && opts.subcommand !== "set-thinking") {
		return jsonError(`unknown session config subcommand: ${opts.subcommand}`, {
			pretty: opts.pretty,
			recovery: ["mu session config --help"],
		});
	}

	const targetDecision = await resolveSessionConfigTarget({
		cwd: ctx.cwd,
		repoRoot: ctx.repoRoot,
		storeDir: ctx.paths.storeDir,
		fileExists: deps.fileExists,
		sessionId: opts.sessionIdRaw,
		sessionKindRaw: opts.sessionKindRaw,
		sessionDirRaw: opts.sessionDirRaw,
		sessionFileRaw: opts.sessionFileRaw,
	});
	if (!targetDecision.ok) {
		return jsonError(targetDecision.error, { pretty: opts.pretty, recovery: targetDecision.recovery });
	}
	const target = targetDecision.target;

	if (opts.subcommand === "get") {
		if (opts.providerRaw != null || opts.modelRaw != null || opts.thinkingRaw != null || opts.restArgs.length > 0) {
			return jsonError(`unknown args: ${opts.restArgs.join(" ")}`.trim(), {
				pretty: opts.pretty,
				recovery: ["mu session config get --help", "mu session config --help"],
			});
		}
		const snapshot = await readSessionConfigSnapshot(target);
		const payload = {
			ok: true,
			scope: "session",
			action: "get",
			session: snapshot,
		};
		if (opts.jsonMode) {
			return ok(jsonText(payload, opts.pretty));
		}
		return ok(
			[
				`Session config: ${snapshot.session_id}`,
				`  session_kind         ${snapshot.session_kind}`,
				`  session_file         ${snapshot.session_file}`,
				`  model                ${snapshot.model.provider && snapshot.model.id ? `${snapshot.model.provider}/${snapshot.model.id}` : "(unset)"}`,
				`  thinking             ${snapshot.thinking}`,
				"  scope                session-only (global defaults unchanged)",
			].join("\n") + "\n",
		);
	}

	if (opts.subcommand === "set-model") {
		if (opts.restArgs.length > 0) {
			return jsonError(`unknown args: ${opts.restArgs.join(" ")}`, {
				pretty: opts.pretty,
				recovery: ["mu session config set-model --help", "mu session config --help"],
			});
		}
		const provider = opts.providerRaw?.trim() ?? "";
		const modelId = opts.modelRaw?.trim() ?? "";
		if (!provider) {
			return jsonError("missing --provider", {
				pretty: opts.pretty,
				recovery: ["mu session config set-model --session-id <id> --provider <id> --model <id>"],
			});
		}
		if (!modelId) {
			return jsonError("missing --model", {
				pretty: opts.pretty,
				recovery: ["mu session config set-model --session-id <id> --provider <id> --model <id>"],
			});
		}
		if (!isSafeSessionModelToken(provider)) {
			return jsonError(`invalid provider: ${provider}`, {
				pretty: opts.pretty,
				recovery: ["mu control operator models"],
			});
		}
		if (!isSafeSessionModelToken(modelId)) {
			return jsonError(`invalid model id: ${modelId}`, {
				pretty: opts.pretty,
				recovery: ["mu control operator models"],
			});
		}

		const { getModels, getProviders, supportsXhigh } = await import("@mariozechner/pi-ai");
		const providers = getProviders().map((entry) => String(entry));
		if (!providers.includes(provider)) {
			return jsonError(`unknown provider: ${provider}`, {
				pretty: opts.pretty,
				recovery: ["mu control operator models"],
			});
		}
		const model = getModels(provider as never).find((candidate) => candidate.id === modelId);
		if (!model) {
			return jsonError(`model not found for provider ${provider}: ${modelId}`, {
				pretty: opts.pretty,
				recovery: [`mu control operator models ${provider}`],
			});
		}

		const parsedThinking = normalizeSessionThinkingLevel(opts.thinkingRaw);
		if (opts.thinkingRaw != null && !parsedThinking) {
			return jsonError(`invalid thinking level: ${opts.thinkingRaw}`, {
				pretty: opts.pretty,
				recovery: ["mu control operator thinking"],
			});
		}
		if (parsedThinking) {
			const supportedThinking = supportedThinkingLevelsForModel({
				reasoning: Boolean(model.reasoning),
				xhigh: supportsXhigh(model),
			});
			if (!supportedThinking.includes(parsedThinking)) {
				return jsonError(`thinking level ${parsedThinking} is not supported for ${provider}/${model.id}`, {
					pretty: opts.pretty,
					recovery: [`mu control operator thinking ${provider} ${model.id}`],
				});
			}
		}

		const { SessionManager } = await import("@mariozechner/pi-coding-agent");
		const sessionManager = SessionManager.open(target.sessionFile, target.sessionDir);
		const modelChangeEntryId = sessionManager.appendModelChange(provider, model.id);
		let thinkingChangeEntryId: string | null = null;
		if (parsedThinking) {
			thinkingChangeEntryId = sessionManager.appendThinkingLevelChange(parsedThinking);
		}
		forcePersistSessionConfig(sessionManager);
		const snapshot = await readSessionConfigSnapshot(target);
		const payload = {
			ok: true,
			scope: "session",
			action: "set-model",
			session: snapshot,
			updates: {
				model_change_entry_id: modelChangeEntryId,
				thinking_change_entry_id: thinkingChangeEntryId,
			},
		};
		if (opts.jsonMode) {
			return ok(jsonText(payload, opts.pretty));
		}
		return ok(
			[
				`Session model updated: ${snapshot.session_id}`,
				`  model                ${snapshot.model.provider && snapshot.model.id ? `${snapshot.model.provider}/${snapshot.model.id}` : "(unset)"}`,
				`  thinking             ${snapshot.thinking}`,
				`  session_file         ${snapshot.session_file}`,
				"  scope                session-only (global defaults unchanged)",
			].join("\n") + "\n",
		);
	}

	if (opts.subcommand === "set-thinking") {
		if (opts.providerRaw != null || opts.modelRaw != null || opts.restArgs.length > 0) {
			return jsonError(`unknown args: ${opts.restArgs.join(" ")}`.trim(), {
				pretty: opts.pretty,
				recovery: ["mu session config set-thinking --help", "mu session config --help"],
			});
		}
		const parsedThinking = normalizeSessionThinkingLevel(opts.thinkingRaw);
		if (!parsedThinking) {
			return jsonError(`invalid or missing --thinking: ${opts.thinkingRaw ?? "(none)"}`, {
				pretty: opts.pretty,
				recovery: ["mu session config set-thinking --session-id <id> --thinking minimal"],
			});
		}

		const { SessionManager } = await import("@mariozechner/pi-coding-agent");
		const sessionManager = SessionManager.open(target.sessionFile, target.sessionDir);
		const context = sessionManager.buildSessionContext();
		if (context.model) {
			const { getModels, getProviders, supportsXhigh } = await import("@mariozechner/pi-ai");
			const providers = getProviders().map((entry) => String(entry));
			if (providers.includes(context.model.provider)) {
				const model = getModels(context.model.provider as never).find((candidate) => candidate.id === context.model?.modelId);
				if (model) {
					const supported = supportedThinkingLevelsForModel({
						reasoning: Boolean(model.reasoning),
						xhigh: supportsXhigh(model),
					});
					if (!supported.includes(parsedThinking)) {
						return jsonError(
							`thinking level ${parsedThinking} is not supported for ${context.model.provider}/${context.model.modelId}`,
							{
								pretty: opts.pretty,
								recovery: [`mu control operator thinking ${context.model.provider} ${context.model.modelId}`],
							},
						);
					}
				}
			}
		}

		const thinkingChangeEntryId = sessionManager.appendThinkingLevelChange(parsedThinking);
		forcePersistSessionConfig(sessionManager);
		const snapshot = await readSessionConfigSnapshot(target);
		const payload = {
			ok: true,
			scope: "session",
			action: "set-thinking",
			session: snapshot,
			updates: {
				thinking_change_entry_id: thinkingChangeEntryId,
			},
		};
		if (opts.jsonMode) {
			return ok(jsonText(payload, opts.pretty));
		}
		return ok(
			[
				`Session thinking updated: ${snapshot.session_id}`,
				`  model                ${snapshot.model.provider && snapshot.model.id ? `${snapshot.model.provider}/${snapshot.model.id}` : "(unset)"}`,
				`  thinking             ${snapshot.thinking}`,
				`  session_file         ${snapshot.session_file}`,
				"  scope                session-only (global defaults unchanged)",
			].join("\n") + "\n",
		);
	}

	return jsonError(`unknown session config subcommand: ${opts.subcommand}`, {
		pretty: opts.pretty,
		recovery: ["mu session config --help"],
	});
}

export async function cmdSession<Ctx extends SessionCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: SessionCommandDeps<Ctx>,
): Promise<SessionCommandRunResult> {
	const {
		hasHelpFlag,
		getFlagValue,
		popFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
		trimForHeader,
		runServeLifecycle,
	} = deps;

	const firstPositionalToken = argv.find((token) => !token.startsWith("-"));
	if (hasHelpFlag(argv) && firstPositionalToken !== "config") {
		return ok(
			[
				"mu session - reconnect/list terminal operator sessions",
				"",
				"Usage:",
				"  mu session [--new] [--resume <session-id|path>] [--port N]",
				"             [--provider ID] [--model ID] [--thinking LEVEL]",
				"  mu session <session-id|path>",
				"  mu session list [--kind operator|cp_operator|all] [--all-workspaces] [--limit N] [--verbose|--debug] [--json] [--pretty]",
				"  mu session config <get|set-model|set-thinking> ...",
				"",
				"Behavior:",
				"  - Default: reconnect to the most recent persisted operator session for this repo.",
				"  - --new: start a fresh operator session.",
				"  - --resume / positional selector: open a specific persisted session (auto-resolves operator + cp_operator stores).",
				"  - --provider/--model/--thinking here are session-start overrides.",
				"  - list mode defaults to --kind all; use --kind operator|cp_operator to narrow.",
				"  - list text output is compact by default; --verbose/--debug adds kind chips + rel paths.",
				"  - list mode supports --all-workspaces for broader discovery.",
				"",
				"Config scopes:",
				"  - Global defaults: `mu control operator set|thinking-set` (workspace config)",
				"  - Session-scoped: `mu session config ...` (one session transcript)",
				"",
				"Examples:",
				"  mu session",
				"  mu session list",
				"  mu session list --kind cp_operator",
				"  mu session list --kind all --all-workspaces --limit 50",
				"  mu session list --verbose",
				"  mu session --new",
				"  mu session 8b7f1a2c",
				"  mu session --resume <store>/operator/sessions/session.jsonl",
				"  mu session config get --session-id <id>",
				"  mu session config set-model --session-id <id> --provider openai-codex --model gpt-5.3-codex",
				"",
				"See also: `mu serve --help`, `mu stop --help`, `mu control operator --help`",
			].join("\n") + "\n",
		);
	}

	const { value: portRaw, rest: argv0 } = getFlagValue(argv, "--port");
	const { present: listFlag, rest: argv2 } = popFlag(argv0, "--list");
	const { present: newFlag, rest: argv3 } = popFlag(argv2, "--new");
	const { value: resumeRaw, rest: argv4 } = getFlagValue(argv3, "--resume");
	const { value: limitRaw, rest: argv5 } = getFlagValue(argv4, "--limit");
	const { value: kindRaw, rest: argv6 } = getFlagValue(argv5, "--kind");
	const { present: allWorkspaces, rest: argv7 } = popFlag(argv6, "--all-workspaces");
	const { present: verbose, rest: argv8 } = popFlag(argv7, "--verbose");
	const { present: debug, rest: argv9 } = popFlag(argv8, "--debug");
	const { value: providerRaw, rest: argv10 } = getFlagValue(argv9, "--provider");
	const { value: modelRaw, rest: argv11 } = getFlagValue(argv10, "--model");
	const { value: thinkingRaw, rest: argv12 } = getFlagValue(argv11, "--thinking");
	const { value: sessionIdRaw, rest: argv13 } = getFlagValue(argv12, "--session-id");
	const { value: sessionKindRaw, rest: argv14 } = getFlagValue(argv13, "--session-kind");
	const { value: sessionFileRaw, rest: argv15 } = getFlagValue(argv14, "--session-file");
	const { value: sessionDirRaw, rest: argv16 } = getFlagValue(argv15, "--session-dir");
	const { present: jsonMode, rest: argv17 } = popFlag(argv16, "--json");
	const { present: pretty, rest: positionalRaw } = popFlag(argv17, "--pretty");

	for (const [flagName, rawValue] of [
		["--port", portRaw],
		["--resume", resumeRaw],
		["--limit", limitRaw],
		["--kind", kindRaw],
		["--provider", providerRaw],
		["--model", modelRaw],
		["--thinking", thinkingRaw],
		["--session-id", sessionIdRaw],
		["--session-kind", sessionKindRaw],
		["--session-file", sessionFileRaw],
		["--session-dir", sessionDirRaw],
	] as const) {
		if (rawValue === "") {
			return jsonError(`missing value for ${flagName}`, {
				recovery: ["mu session --help"],
			});
		}
	}

	let positional = [...positionalRaw];
	let listMode = listFlag;
	let newMode = newFlag;
	let selectorFromPositional: string | null = null;

	if (positional[0] === "config") {
		const configArgs = positional.slice(1);
		if (hasHelpFlag(configArgs) || configArgs.length === 0) {
			return ok(`${sessionConfigHelp()}\n`);
		}
		if (
			listFlag ||
			newFlag ||
			resumeRaw != null ||
			portRaw != null ||
			limitRaw != null ||
			kindRaw != null ||
			allWorkspaces ||
			verbose ||
			debug
		) {
			return jsonError("session config mode does not support --list/--new/--resume/--port/--limit/--kind/--all-workspaces/--verbose/--debug", {
				pretty,
				recovery: ["mu session config --help"],
			});
		}
		const subcommand = configArgs[0]!;
		const restArgs = configArgs.slice(1);
		return await runSessionConfigCommand({
			ctx,
			deps,
			subcommand,
			providerRaw,
			modelRaw,
			thinkingRaw,
			sessionIdRaw,
			sessionKindRaw,
			sessionDirRaw,
			sessionFileRaw,
			jsonMode,
			pretty,
			restArgs,
		});
	}

	if (positional[0] === "list" || positional[0] === "ls") {
		listMode = true;
		positional = positional.slice(1);
	} else if (positional[0] === "new") {
		newMode = true;
		positional = positional.slice(1);
	} else if (positional[0] === "open") {
		if (!positional[1]) {
			return jsonError("mu session open requires <session-id|path>", {
				recovery: ["mu session list", "mu session open <session-id>"],
			});
		}
		selectorFromPositional = positional[1];
		positional = positional.slice(2);
	}

	const sessionDir = operatorSessionDir(ctx.paths.storeDir);
	const listKind = kindRaw != null ? normalizeSessionListKind(kindRaw) : "all";
	if (kindRaw != null && listKind == null) {
		return jsonError(`invalid --kind: ${JSON.stringify(kindRaw)} (supported: operator, cp_operator, all)`, {
			recovery: ["mu session list --help"],
		});
	}

	if (listMode) {
		if (newMode || resumeRaw != null || selectorFromPositional != null) {
			return jsonError("cannot combine list mode with session selection flags", {
				recovery: ["mu session list", "mu session --help"],
			});
		}
		if (
			portRaw != null ||
			providerRaw != null ||
			modelRaw != null ||
			thinkingRaw != null ||
			sessionIdRaw != null ||
			sessionKindRaw != null ||
			sessionFileRaw != null ||
			sessionDirRaw != null
		) {
			return jsonError("list mode only supports --kind/--all-workspaces/--limit/--verbose/--debug/--json/--pretty", {
				recovery: ["mu session list --help"],
			});
		}
		if (positional.length > 0) {
			return jsonError(`unknown args: ${positional.join(" ")}`, {
				recovery: ["mu session list --help"],
			});
		}
		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 20;
		if (limit == null) {
			return jsonError("limit must be 1-500", { recovery: ["mu session list --limit 20"] });
		}
		const resolvedListKind = listKind ?? "all";
		const workspaces = await resolveSessionListWorkspaces(ctx.paths.storeDir, allWorkspaces);
		const workspacesRoot = dirname(resolve(ctx.paths.storeDir));
		const sessions: Array<
			PersistedOperatorSessionRow & {
				sessionKind: SessionKind;
				sessionDir: string;
				workspaceId: string;
				workspaceStoreDir: string;
				workspaceCurrent: boolean;
			}
		> = [];
		const discoveredSessionDirs: string[] = [];
		for (const workspace of workspaces) {
			for (const target of sessionListTargetsForKind(workspace.storeDir, resolvedListKind)) {
				discoveredSessionDirs.push(target.sessionDir);
				const listed = await loadPersistedOperatorSessions(ctx.repoRoot, target.sessionDir);
				for (const session of listed) {
					sessions.push({
						...session,
						sessionKind: target.sessionKind,
						sessionDir: target.sessionDir,
						workspaceId: workspace.workspaceId,
						workspaceStoreDir: workspace.storeDir,
						workspaceCurrent: workspace.isCurrent,
					});
				}
			}
		}
		sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());

		const rows = sessions.slice(0, limit).map((session) => ({
			id: session.id,
			path: session.path,
			rel_path: relative(ctx.repoRoot, session.path).replaceAll("\\", "/"),
			created_at: session.created.toISOString(),
			modified_at: session.modified.toISOString(),
			message_count: session.messageCount,
			name: session.name ?? null,
			first_message: session.firstMessage,
			session_kind: session.sessionKind,
			session_dir: session.sessionDir,
			workspace_id: session.workspaceId,
			workspace_store_dir: session.workspaceStoreDir,
			workspace_rel_path: relative(workspacesRoot, session.workspaceStoreDir).replaceAll("\\", "/"),
			workspace_current: session.workspaceCurrent,
		}));

		const sessionDirs = [...new Set(discoveredSessionDirs)];
		const payload = {
			repo_root: ctx.repoRoot,
			kind: resolvedListKind,
			all_workspaces: allWorkspaces,
			workspace_scope: allWorkspaces ? "all" : "current",
			workspace_count: workspaces.length,
			session_dir: sessionDirs.length === 1 ? sessionDirs[0] : null,
			session_dirs: sessionDirs,
			count: rows.length,
			total: sessions.length,
			sessions: rows,
		};

		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}

		const heading =
			resolvedListKind === "operator"
				? "Operator sessions"
				: resolvedListKind === "cp_operator"
					? "Control-plane operator sessions"
					: "Sessions";
		let out = `${heading} (${rows.length}/${sessions.length})\n`;
		if (!allWorkspaces && payload.session_dir) {
			out += `Store: ${relative(ctx.repoRoot, payload.session_dir).replaceAll("\\", "/")}\n`;
		} else {
			out += `Workspace scope: ${allWorkspaces ? "all workspaces" : "current workspace"}\n`;
		}
		if (rows.length === 0) {
			if (resolvedListKind === "cp_operator") {
				out += "\nNo persisted control-plane operator sessions yet in the selected scope.\n";
			} else if (resolvedListKind === "all") {
				out += "\nNo persisted sessions found for selected scope/kind.\n";
			} else {
				out += "\nNo persisted operator sessions yet. Start one with `mu session --new`.\n";
			}
			return ok(out);
		}

		out += "\n";
		const showDetails = verbose || debug;
		const showKindChip = showDetails;
		for (const row of rows) {
			const previewBase = String(row.name ?? row.first_message ?? "(no messages)")
				.replace(/\s+/g, " ")
				.trim();
			const preview = trimForHeader(previewBase.length > 0 ? previewBase : "(no messages)", showDetails ? 88 : 56);
			const kindChip = row.session_kind === "cp_operator" ? "cp" : "op";
			const kindSegment = showKindChip ? `${kindChip} ` : "";
			const workspaceSuffix = allWorkspaces
				? `  ${chalk.dim(`${row.workspace_id}${row.workspace_current ? "*" : ""}`)}`
				: "";
			if (showDetails) {
				out += `  ${chalk.cyan(row.id.slice(0, 12))}  ${kindSegment}msgs=${row.message_count}  ${chalk.dim(row.modified_at)}${workspaceSuffix}\n`;
				out += `    ${preview}\n`;
				out += `    ${chalk.dim(String(row.rel_path))}\n`;
				continue;
			}
			out += `  ${chalk.cyan(row.id.slice(0, 12))}  msgs=${row.message_count}  ${chalk.dim(row.modified_at)}${workspaceSuffix}  ${preview}\n`;
		}
		return ok(out);
	}

	if (jsonMode || pretty) {
		return jsonError("--json/--pretty are only supported with `mu session list`", {
			recovery: ["mu session list --json --pretty", "mu session --help"],
		});
	}
	if (limitRaw != null) {
		return jsonError("--limit is only supported with `mu session list`", {
			recovery: ["mu session list --limit 20"],
		});
	}
	if (kindRaw != null || allWorkspaces) {
		return jsonError("--kind/--all-workspaces are only supported with `mu session list`", {
			recovery: ["mu session list --kind operator", "mu session list --all-workspaces"],
		});
	}
	if (verbose || debug) {
		return jsonError("--verbose/--debug are only supported with `mu session list`", {
			recovery: ["mu session list --verbose"],
		});
	}
	if (sessionIdRaw != null || sessionKindRaw != null || sessionFileRaw != null || sessionDirRaw != null) {
		return jsonError("--session-id/--session-kind/--session-file/--session-dir are only supported with `mu session config`", {
			recovery: ["mu session config --help"],
		});
	}

	if (!selectorFromPositional && positional.length > 0) {
		selectorFromPositional = positional[0]!;
		positional = positional.slice(1);
	}
	if (positional.length > 0) {
		return jsonError(`unknown args: ${positional.join(" ")}`, {
			recovery: ["mu session --help"],
		});
	}

	const selectorFromFlag = resumeRaw?.trim() || null;
	if (selectorFromFlag && selectorFromPositional) {
		return jsonError("provide either --resume or positional session selector, not both", {
			recovery: ["mu session --resume <session-id>", "mu session <session-id>"],
		});
	}
	const selector = selectorFromFlag ?? selectorFromPositional;
	if (newMode && selector) {
		return jsonError("cannot combine --new with a session selector", {
			recovery: ["mu session --new", "mu session <session-id>"],
		});
	}

	const provider = providerRaw?.trim() || undefined;
	const model = modelRaw?.trim() || undefined;
	const thinking = thinkingRaw?.trim() || undefined;

	const port = portRaw ? ensureInt(portRaw, { name: "--port", min: 1, max: 65535 }) : 3000;
	if (port == null) {
		return jsonError("port must be 1-65535", { recovery: ["mu session --port 3000"] });
	}

	let operatorSession: OperatorSessionStartOpts;
	if (newMode) {
		operatorSession = {
			mode: "new",
			sessionDir,
		};
	} else if (selector) {
		const resolved = await resolvePersistedSessionPathAcrossKinds({
			cwd: ctx.cwd,
			repoRoot: ctx.repoRoot,
			storeDir: ctx.paths.storeDir,
			selector,
			fileExists,
		});
		if (!resolved.path) {
			return jsonError(resolved.error ?? "unable to resolve session", {
				recovery: resolved.recovery ?? ["mu session list --kind all"],
			});
		}
		operatorSession = {
			mode: "open",
			sessionDir: resolved.sessionDir ?? dirname(resolved.path),
			sessionFile: resolved.path,
		};
	} else {
		const persistedSessions = await loadPersistedOperatorSessions(ctx.repoRoot, sessionDir);
		operatorSession = defaultOperatorSessionStart(ctx.paths.storeDir, persistedSessions[0]?.path ?? null);
	}

	return await runServeLifecycle(ctx, {
		commandName: "session",
		port,
		operatorProvider: provider,
		operatorModel: model,
		operatorThinking: thinking,
		operatorSession,
	});
}
