type OperatorSessionStartMode = "in-memory" | "continue-recent" | "new" | "open";

type OperatorSessionStartOpts = {
	mode: OperatorSessionStartMode;
	sessionDir?: string;
	sessionFile?: string;
};

export type OperatorSessionCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type OperatorSessionCommandOptions = {
	onInteractiveReady?: () => void;
	session?: OperatorSessionStartOpts;
};

type OperatorSession = {
	subscribe: (listener: (event: unknown) => void) => () => void;
	prompt: (text: string, options?: { expandPromptTemplates?: boolean }) => Promise<void>;
	dispose: () => void;
};

export type OperatorSessionCommandCtx = {
	repoRoot: string;
	serveExtensionPaths?: string[];
	operatorSessionFactory?: (opts: {
		cwd: string;
		systemPrompt: string;
		provider?: string;
		model?: string;
		thinking?: string;
	}) => Promise<OperatorSession>;
};

export type OperatorSessionCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => OperatorSessionCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => OperatorSessionCommandRunResult;
	defaultOperatorSessionStart: (repoRoot: string) => OperatorSessionStartOpts;
};

function readAssistantTextFromEvent(event: unknown): string | null {
	if (typeof event !== "object" || event == null || Array.isArray(event)) {
		return null;
	}
	const row = event as Record<string, unknown>;
	if (row.type !== "message_end") {
		return null;
	}
	if (typeof row.message !== "object" || row.message == null || Array.isArray(row.message)) {
		return null;
	}
	const message = row.message as Record<string, unknown>;
	if (message.role !== "assistant") {
		return null;
	}
	if (typeof message.text === "string") {
		return message.text;
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return null;
}

export async function cmdOperatorSession<Ctx extends OperatorSessionCommandCtx>(
	argv: string[],
	ctx: Ctx,
	options: OperatorSessionCommandOptions,
	deps: OperatorSessionCommandDeps,
): Promise<OperatorSessionCommandRunResult> {
	const { hasHelpFlag, popFlag, getFlagValue, jsonError, jsonText, ok, defaultOperatorSessionStart } = deps;
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu serve - operator session (server + terminal)",
				"",
				"Usage:",
				"  mu serve [--port N] [--provider ID] [--model ID] [--thinking LEVEL]",
				"",
				"Options:",
				"  --port N               Server port (default: 3000)",
				"  --provider ID          LLM provider for operator session",
				"  --model ID             Model ID (default: gpt-5.3-codex)",
				"  --thinking LEVEL       Thinking level (minimal|low|medium|high)",
				"",
				"Examples:",
				"  mu serve",
				"  mu serve --port 8080",
				"",
				"See also: `mu guide`, `mu control status`",
			].join("\n") + "\n",
		);
	}

	const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
	const { value: messageLong, rest: argv1 } = getFlagValue(argv0, "--message");
	const { value: messageShort, rest: argv2 } = getFlagValue(argv1, "-m");
	const { value: providerRaw, rest: argv3 } = getFlagValue(argv2, "--provider");
	const { value: modelRaw, rest: argv4 } = getFlagValue(argv3, "--model");
	const { value: thinkingRaw, rest: argv5 } = getFlagValue(argv4, "--thinking");
	const { value: systemPromptRaw, rest } = getFlagValue(argv5, "--system-prompt");

	for (const [flagName, rawValue] of [
		["--message", messageLong],
		["-m", messageShort],
		["--provider", providerRaw],
		["--model", modelRaw],
		["--thinking", thinkingRaw],
		["--system-prompt", systemPromptRaw],
	] as const) {
		if (rawValue === "") {
			return jsonError(`missing value for ${flagName}`, {
				recovery: ["mu serve --help"],
			});
		}
	}

	let message = messageLong ?? messageShort;
	if (message != null && message.trim().length === 0) {
		return jsonError("message must not be empty", {
			recovery: ["mu serve --help"],
		});
	}

	if (rest.length > 0) {
		if (rest.some((arg) => arg.startsWith("-"))) {
			return jsonError(`unknown args: ${rest.join(" ")}`, {
				recovery: ["mu serve --help"],
			});
		}
		const positionalMessage = rest.join(" ").trim();
		if (positionalMessage.length > 0) {
			if (message != null) {
				return jsonError("provide either --message/-m or positional text, not both", {
					recovery: ["mu serve --help"],
				});
			}
			message = positionalMessage;
		}
	}

	if (jsonMode && message == null) {
		return jsonError("--json requires --message", {
			recovery: ["mu serve --help"],
		});
	}

	const { DEFAULT_OPERATOR_SYSTEM_PROMPT } = await import("@femtomc/mu-agent");
	const provider = providerRaw?.trim() || undefined;
	const model = modelRaw?.trim() || undefined;
	const thinking = thinkingRaw?.trim() || undefined;
	const systemPrompt = systemPromptRaw?.trim() || DEFAULT_OPERATOR_SYSTEM_PROMPT;

	const createOperatorSession = async (): Promise<OperatorSession> => {
		if (ctx.operatorSessionFactory) {
			return ctx.operatorSessionFactory({ cwd: ctx.repoRoot, systemPrompt, provider, model, thinking });
		}

		const { createMuSession } = await import("@femtomc/mu-agent");
		const requestedSession = options.session ?? defaultOperatorSessionStart(ctx.repoRoot);
		const session = await createMuSession({
			cwd: ctx.repoRoot,
			systemPrompt,
			provider,
			model,
			thinking,
			extensionPaths: ctx.serveExtensionPaths,
			session: {
				mode: requestedSession.mode,
				sessionDir: requestedSession.sessionDir,
				sessionFile: requestedSession.sessionFile,
			},
		});

		return session as unknown as OperatorSession;
	};

	if (message != null) {
		const session = await createOperatorSession();
		try {
			if (ctx.operatorSessionFactory) {
				let assistantText = "";
				const unsub = session.subscribe((event: unknown) => {
					const text = readAssistantTextFromEvent(event);
					if (text != null) {
						assistantText = text;
					}
				});
				try {
					await session.prompt(message, { expandPromptTemplates: false });
				} finally {
					unsub();
				}
				if (jsonMode) {
					return ok(jsonText({ role: "assistant", content: assistantText }, true));
				}
				return ok(assistantText.length > 0 ? `${assistantText}\n` : "");
			}
			const { runPrintMode } = await import("@mariozechner/pi-coding-agent");
			await runPrintMode(session as Parameters<typeof runPrintMode>[0], {
				mode: jsonMode ? "json" : "text",
				initialMessage: message,
			});
		} finally {
			session.dispose();
		}
		return ok();
	}

	if (!(process.stdin as { isTTY?: boolean }).isTTY) {
		return jsonError("interactive operator session requires a TTY; use --message for one-shot mode", {
			recovery: ["mu serve --help"],
		});
	}

	options.onInteractiveReady?.();

	const session = await createOperatorSession();
	try {
		const { InteractiveMode } = await import("@mariozechner/pi-coding-agent");
		const mode = new InteractiveMode(session as ConstructorParameters<typeof InteractiveMode>[0]);
		await mode.init();
		await mode.run();
	} finally {
		session.dispose();
	}
	return ok();
}
