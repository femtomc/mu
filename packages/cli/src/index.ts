import { dirname, join } from "node:path";
import chalk from "chalk";
import type { IssueStore } from "@femtomc/mu-issue";
import { formatRecovery, hasHelpFlag, jsonError, ok } from "./cli_primitives.js";
import { resolveIssueId as resolveIssueIdCore } from "./issue_resolution.js";
import { mainHelp } from "./main_help.js";
import { routeCommand } from "./command_router.js";
import type { CliCtx, CliIO, RunResult } from "./types.js";
import type { OperatorSessionStartOpts, ServeDeps, ServeLifecycleOptions } from "./serve_runtime.js";
import { delayMs, describeError, signalExitCode } from "./cli_utils.js";

const KNOWN_COMMANDS = new Set([
	"guide",
	"status",
	"store",
	"issues",
	"forum",
	"events",
	"heartbeats",
	"cron",
	"memory",
	"turn",
	"exec",
	"login",
	"replay",
	"control",
	"session",
	"serve",
	"stop",
]);

const COMMANDS_WITHOUT_CLI_CTX = new Set(["guide", "login"]);
const COMMANDS_REQUIRING_FULL_CTX = new Set(["status", "issues", "forum"]);

async function resolveIssueId(
	store: IssueStore,
	rawId: string,
): Promise<{ issueId: string | null; error: string | null }> {
	return await resolveIssueIdCore(store, rawId, { formatRecovery });
}

type RunOptions = {
	cwd?: string;
	io?: CliIO;
	backend?: CliCtx["backend"];
	operatorSessionFactory?: CliCtx["operatorSessionFactory"];
	serveDeps?: Partial<ServeDeps>;
};

type CliRuntimeCtx = Omit<CliCtx, "store" | "forum" | "events">;

async function createCliBareCtx(cwd: string, opts: RunOptions): Promise<CliRuntimeCtx> {
	const [{ findRepoRoot }, { getStorePaths }] = await Promise.all([
		import("./workspace_runtime.js"),
		import("@femtomc/mu-core/node"),
	]);
	const repoRoot = await findRepoRoot(cwd);
	const paths = getStorePaths(repoRoot);
	return {
		cwd,
		repoRoot,
		paths,
		io: opts.io,
		backend: opts.backend,
		operatorSessionFactory: opts.operatorSessionFactory,
		serveDeps: opts.serveDeps,
	};
}

async function createCliRuntimeCtx(cwd: string, opts: RunOptions): Promise<CliRuntimeCtx> {
	const [{ ensureStoreInitialized }, bareCtx] = await Promise.all([
		import("./workspace_runtime.js"),
		createCliBareCtx(cwd, opts),
	]);
	await ensureStoreInitialized({ paths: bareCtx.paths });
	return bareCtx;
}

async function createCliCtx(cwd: string, opts: RunOptions): Promise<CliCtx> {
	const runtimeCtx = await createCliRuntimeCtx(cwd, opts);
	const [coreNode, issueModule, forumModule] = await Promise.all([
		import("@femtomc/mu-core/node"),
		import("@femtomc/mu-issue"),
		import("@femtomc/mu-forum"),
	]);
	const { FsJsonlStore, fsEventLog } = coreNode;
	const { IssueStore } = issueModule;
	const { ForumStore } = forumModule;
	const events = fsEventLog(runtimeCtx.paths.eventsPath);
	const store = new IssueStore(new FsJsonlStore(runtimeCtx.paths.issuesPath), { events });
	const forum = new ForumStore(new FsJsonlStore(runtimeCtx.paths.forumPath), { events });
	return {
		...runtimeCtx,
		store,
		forum,
		events,
	};
}

async function runGuide(argv: string[]): Promise<RunResult> {
	if (argv.length > 0 && !hasHelpFlag(argv)) {
		return jsonError(`unknown args: ${argv.join(" ")}`, { recovery: ["mu guide"] });
	}
	const { guideText } = await import("./guide.js");
	return ok(`${guideText()}\n`);
}

async function runLogin(argv: string[]): Promise<RunResult> {
	const [{ cmdLogin }, { loginCommandDeps }] = await Promise.all([
		import("./commands/login.js"),
		import("./command_deps.js"),
	]);
	return await cmdLogin(argv, loginCommandDeps());
}

async function buildCommandHandlers() {
	const [
		{ createCommandHandlers },
		{ cmdOperatorSession: cmdOperatorSessionCommand },
		{ operatorSessionCommandDeps },
		{ requestServerJson: requestServerJsonHelper, detectRunningServer },
		{ buildServeDeps: buildServeDepsRuntime, runServeLifecycle: runServeLifecycleRuntime },
		{ defaultOperatorSessionStart, readServeOperatorDefaults },
	] = await Promise.all([
		import("./command_handlers.js"),
		import("./commands/operator_session.js"),
		import("./command_deps.js"),
		import("./server_helpers.js"),
		import("./serve_runtime.js"),
		import("./workspace_runtime.js"),
	]);

	const requestServerJson = async <T>(opts: {
		ctx: CliCtx;
		pretty: boolean;
		method?: "GET" | "POST";
		path: string;
		body?: Record<string, unknown>;
		recoveryCommand: string;
		timeoutMs?: number;
	}): Promise<{ ok: true; payload: T } | { ok: false; result: RunResult }> => {
		return await requestServerJsonHelper<CliCtx, T, RunResult>({
			...opts,
			jsonError,
			describeError,
		});
	};

	const buildServeDeps = (ctx: CliCtx): ServeDeps => {
		return buildServeDepsRuntime(ctx, {
			defaultOperatorSessionStart,
			runOperatorSession: async (runtimeCtx, opts) => {
				const { operatorExtensionPaths } = await import("@femtomc/mu-agent");
				const operatorArgv: string[] = [];
				if (opts.provider) {
					operatorArgv.push("--provider", opts.provider);
				}
				if (opts.model) {
					operatorArgv.push("--model", opts.model);
				}
				if (opts.thinking) {
					operatorArgv.push("--thinking", opts.thinking);
				}
				const requestedSession: OperatorSessionStartOpts = opts.sessionMode
					? {
							mode: opts.sessionMode,
							sessionDir: opts.sessionDir,
							sessionFile: opts.sessionFile,
						}
					: defaultOperatorSessionStart(runtimeCtx.repoRoot);
				return await cmdOperatorSessionCommand(
					operatorArgv,
					{ ...runtimeCtx, serveExtensionPaths: runtimeCtx.serveExtensionPaths ?? operatorExtensionPaths },
					{
						onInteractiveReady: opts.onReady,
						session: requestedSession,
					},
					operatorSessionCommandDeps(),
				);
			},
		});
	};

	const runServeLifecycle = async (ctx: CliCtx, opts: ServeLifecycleOptions): Promise<RunResult> => {
		return await runServeLifecycleRuntime(ctx, opts, {
			readServeOperatorDefaults,
			defaultOperatorSessionStart,
			buildServeDeps,
			detectRunningServer,
			jsonError,
			describeError,
			signalExitCode,
			delayMs,
		});
	};

	return createCommandHandlers({
		resolveIssueId,
		requestServerJson,
		runServeLifecycle,
		buildServeDeps,
	});
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
	const cwd = opts.cwd ?? process.cwd();

	if (argv[0] === "--help" || argv[0] === "-h") {
		return ok(`${mainHelp()}\n`);
	}
	if (argv.length === 0) {
		const ctx = await createCliRuntimeCtx(cwd, opts);
		const handlers = await buildCommandHandlers();
		return await handlers.cmdServe([], ctx as unknown as CliCtx);
	}
	if (argv.includes("--version")) {
		const pkgPath = join(dirname(new URL(import.meta.url).pathname), "..", "package.json");
		const { version } = JSON.parse(await Bun.file(pkgPath).text()) as { version: string };
		return ok(`${chalk.bold.magenta("mu")} ${chalk.dim(version)}\n`);
	}

	const cmd = argv[0]!;
	const rest = argv.slice(1);
	if (!KNOWN_COMMANDS.has(cmd)) {
		return jsonError(`unknown command: ${cmd}`, {
			recovery: ["mu --help"],
		});
	}
	if (COMMANDS_WITHOUT_CLI_CTX.has(cmd)) {
		if (cmd === "guide") {
			return await runGuide(rest);
		}
		return await runLogin(rest);
	}

	const isHelpInvocation = hasHelpFlag(rest);
	const handlers = await buildCommandHandlers();
	if (isHelpInvocation) {
		const helpCtx = {
			cwd,
			repoRoot: cwd,
			paths: {} as CliCtx["paths"],
			io: opts.io,
			backend: opts.backend,
			operatorSessionFactory: opts.operatorSessionFactory,
			serveDeps: opts.serveDeps,
		} as unknown as CliCtx;
		return await routeCommand(cmd, rest, helpCtx, {
			jsonError,
			...handlers,
		});
	}
	const ctx = COMMANDS_REQUIRING_FULL_CTX.has(cmd)
		? await createCliCtx(cwd, opts)
		: await createCliRuntimeCtx(cwd, opts);
	return await routeCommand(cmd, rest, ctx as unknown as CliCtx, {
		jsonError,
		...handlers,
	});
}
