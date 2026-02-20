import { basename, join, relative, resolve } from "node:path";
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

function operatorSessionDir(storeDir: string): string {
	return join(storeDir, "operator", "sessions");
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

	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu session - reconnect/list terminal operator sessions",
				"",
				"Usage:",
				"  mu session [--new] [--resume <session-id|path>] [--port N]",
				"             [--provider ID] [--model ID] [--thinking LEVEL]",
				"  mu session <session-id|path>",
				"  mu session list [--limit N] [--json] [--pretty]",
				"",
				"Behavior:",
				"  - Default: reconnect to the most recent persisted operator session for this repo.",
				"  - --new: start a fresh operator session.",
				"  - --resume / positional selector: open a specific persisted session.",
				"",
				"Examples:",
				"  mu session",
				"  mu session list",
				"  mu session --new",
				"  mu session 8b7f1a2c",
				"  mu session --resume <store>/operator/sessions/session.jsonl",
				"",
				"See also: `mu serve --help`, `mu stop --help`",
			].join("\n") + "\n",
		);
	}

	const { value: portRaw, rest: argv0 } = getFlagValue(argv, "--port");
	const { present: listFlag, rest: argv2 } = popFlag(argv0, "--list");
	const { present: newFlag, rest: argv3 } = popFlag(argv2, "--new");
	const { value: resumeRaw, rest: argv4 } = getFlagValue(argv3, "--resume");
	const { value: limitRaw, rest: argv5 } = getFlagValue(argv4, "--limit");
	const { value: providerRaw, rest: argv6 } = getFlagValue(argv5, "--provider");
	const { value: modelRaw, rest: argv7 } = getFlagValue(argv6, "--model");
	const { value: thinkingRaw, rest: argv8 } = getFlagValue(argv7, "--thinking");
	const { present: jsonMode, rest: argv9 } = popFlag(argv8, "--json");
	const { present: pretty, rest: positionalRaw } = popFlag(argv9, "--pretty");

	for (const [flagName, rawValue] of [
		["--port", portRaw],
		["--resume", resumeRaw],
		["--limit", limitRaw],
		["--provider", providerRaw],
		["--model", modelRaw],
		["--thinking", thinkingRaw],
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

	if (listMode) {
		if (newMode || resumeRaw != null || selectorFromPositional != null) {
			return jsonError("cannot combine list mode with session selection flags", {
				recovery: ["mu session list", "mu session --help"],
			});
		}
		if (portRaw != null || providerRaw != null || modelRaw != null || thinkingRaw != null) {
			return jsonError("list mode only supports --limit/--json/--pretty", {
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

		const sessions = await loadPersistedOperatorSessions(ctx.repoRoot, sessionDir);
		const rows = sessions.slice(0, limit).map((session) => ({
			id: session.id,
			path: session.path,
			rel_path: relative(ctx.repoRoot, session.path).replaceAll("\\", "/"),
			created_at: session.created.toISOString(),
			modified_at: session.modified.toISOString(),
			message_count: session.messageCount,
			name: session.name ?? null,
			first_message: session.firstMessage,
		}));

		if (jsonMode) {
			return ok(
				jsonText(
					{
						repo_root: ctx.repoRoot,
						session_dir: sessionDir,
						count: rows.length,
						total: sessions.length,
						sessions: rows,
					},
					pretty,
				),
			);
		}

		let out = `Operator sessions (${rows.length}/${sessions.length})\n`;
		out += `Store: ${relative(ctx.repoRoot, sessionDir).replaceAll("\\", "/")}\n`;
		if (rows.length === 0) {
			out += "\nNo persisted operator sessions yet. Start one with `mu session --new`.\n";
			return ok(out);
		}

		out += "\n";
		for (const row of rows) {
			const preview = trimForHeader((row.name ?? row.first_message ?? "(no messages)").trim(), 88);
			out += `  ${chalk.cyan(row.id.slice(0, 12))}  msgs=${row.message_count}  ${chalk.dim(row.modified_at)}\n`;
			out += `    ${preview}\n`;
			out += `    ${chalk.dim(String(row.rel_path))}\n`;
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
		const resolved = await resolvePersistedOperatorSessionPath({
			cwd: ctx.cwd,
			repoRoot: ctx.repoRoot,
			sessionDir,
			selector,
			fileExists,
		});
		if (!resolved.path) {
			return jsonError(resolved.error ?? "unable to resolve session", {
				recovery: resolved.recovery ?? ["mu session list"],
			});
		}
		operatorSession = {
			mode: "open",
			sessionDir,
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
