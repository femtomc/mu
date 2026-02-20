export type RunCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type RunQueueSnapshot = {
	job_id: string;
	root_issue_id: string | null;
	max_steps: number;
};

type RunServeDeps = {
	queueRun: (opts: {
		serverUrl: string;
		prompt: string;
		maxSteps: number;
		provider?: string;
		model?: string;
		reasoning?: string;
	}) => Promise<RunQueueSnapshot>;
};

type RunServeLifecycleOpts = {
	commandName: "session" | "run" | "serve";
	port: number;
	operatorProvider?: string;
	operatorModel?: string;
	operatorThinking?: string;
	beforeOperatorSession?: (opts: {
		serverUrl: string;
		deps: RunServeDeps;
		io: { stderr?: { write: (chunk: string) => void } } | undefined;
	}) => Promise<void>;
};

export type RunCommandDeps<Ctx> = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => RunCommandRunResult;
	ok: (stdout?: string, exitCode?: number) => RunCommandRunResult;
	runServeLifecycle: (ctx: Ctx, opts: any) => Promise<RunCommandRunResult>;
};

export async function cmdRun<Ctx>(argv: string[], ctx: Ctx, deps: RunCommandDeps<Ctx>): Promise<RunCommandRunResult> {
	const { hasHelpFlag, ensureInt, jsonError, ok, runServeLifecycle } = deps;
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu run - start mu serve, queue a run, register heartbeat, and attach operator terminal",
				"",
				"Usage:",
				"  mu run <prompt...> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--port N]",
				"",
				"Run queue options:",
				"  --max-steps <N>    Max DAG steps for the queued run (default: 20)",
				"  --provider <id>    Provider intent for queued run + operator session",
				"  --model <id>       Model intent for queued run + operator session",
				"  --reasoning <lvl>  Thinking intent (queued run request + operator session)",
				"",
				"Serve passthrough:",
				"  --port <N>         Server port (default: 3000)",
				"",
				"Legacy note:",
				"  --json and --raw-stream are no longer supported on mu run.",
				"  Use `mu serve` + /api/control-plane/runs/* for machine integration, or `mu resume --json` for direct run state.",
				"",
				"See also: `mu serve --help`, `mu guide`",
			].join("\n") + "\n",
		);
	}

	let maxSteps = 20;
	let port = 3000;
	let modelFlag: string | undefined;
	let providerFlag: string | undefined;
	let reasoningFlag: string | undefined;
	const promptParts: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--") {
			promptParts.push(...argv.slice(i + 1));
			break;
		}
		if (a === "--json") {
			return jsonError(
				"`mu run --json` has been removed. Use `mu serve` + /api/control-plane/runs/* for machine integration, or `mu resume <root-id> --json` for direct run output.",
				{
					recovery: ['mu run "Break down and execute this goal"', "mu serve --help", "mu resume <root-id> --json"],
				},
			);
		}
		if (a === "--raw-stream") {
			return jsonError(
				"`mu run --raw-stream` has been removed. Use `mu serve` + /api/control-plane/runs/* for queued runs, or `mu resume <root-id> --raw-stream` for direct runner streaming.",
				{
					recovery: [
						'mu run "Break down and execute this goal"',
						"mu serve --help",
						"mu resume <root-id> --raw-stream",
					],
				},
			);
		}
		if (a === "--max-steps") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --max-steps", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			const n = ensureInt(next, { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			maxSteps = n;
			i += 1;
			continue;
		}
		if (a.startsWith("--max-steps=")) {
			const n = ensureInt(a.slice("--max-steps=".length), { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			maxSteps = n;
			continue;
		}
		if (a === "--port") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --port", { recovery: ['mu run --port 3000 "..."'] });
			}
			const p = ensureInt(next, { name: "--port", min: 1, max: 65535 });
			if (p == null) {
				return jsonError("port must be 1-65535", { recovery: ['mu run --port 3000 "..."'] });
			}
			port = p;
			i += 1;
			continue;
		}
		if (a.startsWith("--port=")) {
			const p = ensureInt(a.slice("--port=".length), { name: "--port", min: 1, max: 65535 });
			if (p == null) {
				return jsonError("port must be 1-65535", { recovery: ['mu run --port 3000 "..."'] });
			}
			port = p;
			continue;
		}
		if (a === "--model") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --model", { recovery: ['mu run "..." --model gpt-5.3-codex'] });
			}
			modelFlag = next;
			i += 1;
			continue;
		}
		if (a.startsWith("--model=")) {
			modelFlag = a.slice("--model=".length);
			continue;
		}
		if (a === "--provider") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --provider", { recovery: ['mu run "..." --provider openai-codex'] });
			}
			providerFlag = next;
			i += 1;
			continue;
		}
		if (a.startsWith("--provider=")) {
			providerFlag = a.slice("--provider=".length);
			continue;
		}
		if (a === "--reasoning") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --reasoning", {
					recovery: ['mu run "..." --reasoning high'],
				});
			}
			reasoningFlag = next;
			i += 1;
			continue;
		}
		if (a.startsWith("--reasoning=")) {
			reasoningFlag = a.slice("--reasoning=".length);
			continue;
		}
		if (a.startsWith("-")) {
			return jsonError(`unknown arg: ${a}`, {
				recovery: ["mu run --help", 'mu run "Break down and execute this goal"'],
			});
		}
		promptParts.push(a);
	}

	for (const [flagName, rawValue] of [
		["--provider", providerFlag],
		["--model", modelFlag],
		["--reasoning", reasoningFlag],
	] as const) {
		if (rawValue != null && rawValue.trim().length === 0) {
			return jsonError(`missing value for ${flagName}`, { recovery: ["mu run --help"] });
		}
	}

	const promptText = promptParts.join(" ").trim();
	if (!promptText) {
		return jsonError("missing prompt", { recovery: ['mu run "Break down and execute this goal"'] });
	}

	const provider = providerFlag?.trim() || undefined;
	const model = modelFlag?.trim() || undefined;
	const reasoning = reasoningFlag?.trim() || undefined;

	return await runServeLifecycle(ctx, {
		commandName: "run",
		port,
		operatorProvider: provider,
		operatorModel: model,
		operatorThinking: reasoning,
		beforeOperatorSession: async ({
			serverUrl,
			deps,
			io,
		}: {
			serverUrl: string;
			deps: RunServeDeps;
			io: { stderr?: { write: (chunk: string) => void } } | undefined;
		}) => {
			const queued = await deps.queueRun({
				serverUrl,
				prompt: promptText,
				maxSteps,
				provider,
				model,
				reasoning,
			});
			const rootText = queued.root_issue_id ? ` root=${queued.root_issue_id}` : "";
			io?.stderr?.write(`Queued run: ${queued.job_id}${rootText} max_steps=${queued.max_steps}\n`);
		},
	});
}
