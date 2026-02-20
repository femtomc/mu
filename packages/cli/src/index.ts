import { dirname, join } from "node:path";
import chalk from "chalk";
import type { BackendRunner } from "@femtomc/mu-agent";
import type { EventLog, StorePaths } from "@femtomc/mu-core/node";
import type { ForumStore } from "@femtomc/mu-forum";
import type { IssueStore } from "@femtomc/mu-issue";
import type { ModelOverrides } from "@femtomc/mu-orchestrator";
import { cmdControl as cmdControlCommand } from "./commands/control.js";
import { cmdEvents as cmdEventsCommand } from "./commands/events.js";
import { cmdForum as cmdForumCommand } from "./commands/forum.js";
import { cmdIssues as cmdIssuesCommand } from "./commands/issues.js";
import { cmdOperatorSession as cmdOperatorSessionCommand } from "./commands/operator_session.js";
import { cmdReplay as cmdReplayCommand } from "./commands/replay.js";
import { cmdResume as cmdResumeCommand } from "./commands/resume.js";
import { cmdRun as cmdRunCommand } from "./commands/run.js";
import { cmdRunDirect as cmdRunDirectCommand } from "./commands/run_direct.js";
import { cmdServe as cmdServeCommand, cmdStop as cmdStopCommand } from "./commands/serve.js";
import { cmdSession as cmdSessionCommand } from "./commands/session.js";
import { cmdStore as cmdStoreCommand } from "./commands/store.js";
import { cmdStatus as cmdStatusCommand } from "./commands/status.js";
import {
	cmdCron as cmdCronCommand,
	cmdHeartbeats as cmdHeartbeatsCommand,
	cmdRuns as cmdRunsCommand,
} from "./commands/scheduling.js";
import { cmdMemory as cmdMemoryCommand } from "./commands/memory.js";
import { cmdLogin as cmdLoginCommand } from "./commands/login.js";
import { cmdTurn as cmdTurnCommand } from "./commands/turn.js";
import {
	controlCommandDeps,
	eventsCommandDeps,
	forumCommandDeps,
	issuesCommandDeps,
	loginCommandDeps,
	memoryCommandDeps,
	operatorSessionCommandDeps,
	replayCommandDeps,
	resumeCommandDeps,
	runCommandDeps,
	runDirectCommandDeps,
	schedulingCommandDeps,
	sessionCommandDeps,
	serveCommandDeps,
	statusCommandDeps,
	storeCommandDeps,
	turnCommandDeps,
} from "./command_deps.js";
import { detectRunningServer, requestServerJson as requestServerJsonHelper } from "./server_helpers.js";
import {
	buildServeDeps as buildServeDepsRuntime,
	runServeLifecycle as runServeLifecycleRuntime,
	type OperatorSessionStartMode,
	type OperatorSessionStartOpts,
	type ServeDeps,
	type ServeLifecycleOptions,
} from "./serve_runtime.js";
import {
	defaultOperatorSessionStart,
	ensureCtx,
	ensureStoreInitialized,
	readServeOperatorDefaults,
} from "./workspace_runtime.js";
import { formatRecovery, hasHelpFlag, jsonError, ok } from "./cli_primitives.js";
import { resolveIssueId as resolveIssueIdCore } from "./issue_resolution.js";
import { mainHelp } from "./main_help.js";
import { routeCommand } from "./command_router.js";
import { delayMs, describeError, signalExitCode } from "./cli_utils.js";

export type RunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type CliWriter = {
	write: (chunk: string) => void;
};

type CliIO = {
	stdout?: CliWriter;
	stderr?: CliWriter;
};

type OperatorSession = {
	subscribe: (listener: (event: any) => void) => () => void;
	prompt: (text: string, options?: { expandPromptTemplates?: boolean }) => Promise<void>;
	dispose: () => void;
	bindExtensions: (bindings: any) => Promise<void>;
	agent: { waitForIdle: () => Promise<void> };
};

type CliCtx = {
	cwd: string;
	repoRoot: string;
	store: IssueStore;
	forum: ForumStore;
	events: EventLog;
	paths: StorePaths;
	io?: CliIO;
	backend?: BackendRunner;
	operatorSessionFactory?: (opts: {
		cwd: string;
		systemPrompt: string;
		provider?: string;
		model?: string;
		thinking?: string;
	}) => Promise<OperatorSession>;
	serveDeps?: Partial<ServeDeps>;
	serveExtensionPaths?: string[];
};

type OperatorSessionCommandOptions = {
	onInteractiveReady?: () => void;
	session?: OperatorSessionStartOpts;
};

async function resolveIssueId(
	store: IssueStore,
	rawId: string,
): Promise<{ issueId: string | null; error: string | null }> {
	return await resolveIssueIdCore(store, rawId, { formatRecovery });
}

export async function run(
	argv: string[],
	opts: {
		cwd?: string;
		io?: CliIO;
		backend?: BackendRunner;
		operatorSessionFactory?: CliCtx["operatorSessionFactory"];
		serveDeps?: Partial<ServeDeps>;
	} = {},
): Promise<RunResult> {
	const cwd = opts.cwd ?? process.cwd();

	if (argv[0] === "--help" || argv[0] === "-h") {
		return ok(`${mainHelp()}\n`);
	}
	if (argv.length === 0) {
		const ctx0 = await ensureCtx(cwd);
		const ctx: CliCtx = {
			...ctx0,
			io: opts.io,
			backend: opts.backend,
			operatorSessionFactory: opts.operatorSessionFactory,
			serveDeps: opts.serveDeps,
		};
		return await cmdServe([], ctx);
	}
	if (argv.includes("--version")) {
		const pkgPath = join(dirname(new URL(import.meta.url).pathname), "..", "package.json");
		const { version } = JSON.parse(await Bun.file(pkgPath).text()) as { version: string };
		return ok(`${chalk.bold.magenta("mu")} ${chalk.dim(version)}\n`);
	}

	const cmd = argv[0]!;
	const rest = argv.slice(1);
	const ctx0 = await ensureCtx(cwd);
	const ctx: CliCtx = {
		...ctx0,
		io: opts.io,
		backend: opts.backend,
		operatorSessionFactory: opts.operatorSessionFactory,
		serveDeps: opts.serveDeps,
	};

	return await routeCommand(cmd, rest, ctx, {
		jsonError,
		cmdGuide,
		cmdStatus,
		cmdStore,
		cmdIssues,
		cmdForum,
		cmdEvents,
		cmdRuns,
		cmdHeartbeats,
		cmdCron,
		cmdMemoryDelegated,
		cmdTurn,
		cmdRun,
		cmdRunDirect,
		cmdResume,
		cmdLogin,
		cmdReplay,
		cmdControl,
		cmdSession,
		cmdServe,
		cmdStop,
	});
}

async function cmdGuide(argv: string[]): Promise<RunResult> {
	if (argv.length > 0 && !hasHelpFlag(argv)) {
		return jsonError(`unknown args: ${argv.join(" ")}`, { recovery: ["mu guide"] });
	}
	const { guideText } = await import("./guide.js");
	return ok(`${guideText()}\n`);
}

async function cmdStatus(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStatusCommand(argv, ctx, statusCommandDeps());
}

async function cmdStore(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStoreCommand(argv, ctx, storeCommandDeps());
}

async function cmdIssues(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdIssuesCommand(argv, ctx, issuesCommandDeps(resolveIssueId));
}

async function cmdForum(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdForumCommand(argv, ctx, forumCommandDeps());
}

async function cmdEvents(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdEventsCommand(argv, ctx, eventsCommandDeps());
}

async function cmdRuns(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunsCommand(argv, ctx, schedulingCommandDeps(requestServerJson));
}

async function cmdHeartbeats(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdHeartbeatsCommand(argv, ctx, schedulingCommandDeps(requestServerJson));
}

async function cmdCron(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdCronCommand(argv, ctx, schedulingCommandDeps(requestServerJson));
}

async function cmdMemoryDelegated(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdMemoryCommand(argv, ctx, memoryCommandDeps());
}

async function cmdTurn(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdTurnCommand(argv, ctx, turnCommandDeps());
}

async function cmdRun(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunCommand(argv, ctx, runCommandDeps(runServeLifecycle));
}

async function cmdRunDirect(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunDirectCommand(argv, ctx, runDirectCommandDeps());
}

async function cmdResume(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdResumeCommand(argv, ctx, resumeCommandDeps(resolveIssueId));
}

async function cmdReplay(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdReplayCommand(argv, ctx, replayCommandDeps());
}

async function cmdSession(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdSessionCommand(argv, ctx, sessionCommandDeps(runServeLifecycle));
}

async function cmdOperatorSession(
	argv: string[],
	ctx: CliCtx,
	options: OperatorSessionCommandOptions = {},
): Promise<RunResult> {
	return await cmdOperatorSessionCommand(argv, ctx, options, operatorSessionCommandDeps());
}

async function cmdLogin(argv: string[]): Promise<RunResult> {
	return await cmdLoginCommand(argv, loginCommandDeps());
}

async function requestServerJson<T>(opts: {
	ctx: CliCtx;
	pretty: boolean;
	method?: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	recoveryCommand: string;
}): Promise<{ ok: true; payload: T } | { ok: false; result: RunResult }> {
	return await requestServerJsonHelper<CliCtx, T, RunResult>({
		...opts,
		jsonError,
		describeError,
	});
}

function buildServeDeps(ctx: CliCtx): ServeDeps {
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
			return await cmdOperatorSession(
				operatorArgv,
				{ ...runtimeCtx, serveExtensionPaths: runtimeCtx.serveExtensionPaths ?? operatorExtensionPaths },
				{
					onInteractiveReady: opts.onReady,
					session: requestedSession,
				},
			);
		},
	});
}

async function runServeLifecycle(ctx: CliCtx, opts: ServeLifecycleOptions): Promise<RunResult> {
	return await runServeLifecycleRuntime(ctx, opts, {
		ensureStoreInitialized,
		readServeOperatorDefaults,
		defaultOperatorSessionStart,
		buildServeDeps,
		detectRunningServer,
		jsonError,
		describeError,
		signalExitCode,
		delayMs,
	});
}

async function cmdServe(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdServeCommand(argv, ctx, serveCommandDeps({ buildServeDeps, runServeLifecycle }));
}

async function cmdStop(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStopCommand(argv, ctx, serveCommandDeps({ buildServeDeps, runServeLifecycle }));
}

// ROLE_SCOPES lives in @femtomc/mu-control-plane; lazy-imported alongside IdentityStore.

async function cmdControl(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdControlCommand(argv, ctx, controlCommandDeps());
}
