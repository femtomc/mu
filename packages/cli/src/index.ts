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
	issueJson,
	renderCronPayloadCompact,
	renderEventsCompactTable,
	renderForumPostCompact,
	renderForumReadCompact,
	renderForumTopicsCompact,
	renderHeartbeatsPayloadCompact,
	renderIssueCompactTable,
	renderIssueDepMutationCompact,
	renderIssueDetailCompact,
	renderIssueMutationCompact,
	renderRunPayloadCompact,
} from "./render.js";
import {
	cleanupStaleServerFiles,
	detectRunningServer,
	readApiError,
	requestServerJson as requestServerJsonHelper,
} from "./server_helpers.js";
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
	fileExists,
	nonEmptyString,
	readServeOperatorDefaults,
	storePathForRepoRoot,
} from "./workspace_runtime.js";
import {
	ensureInt,
	formatRecovery,
	getFlagValue,
	getRepeatFlagValues,
	hasHelpFlag,
	jsonError,
	jsonText,
	ok,
	popFlag,
} from "./cli_primitives.js";

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

function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function signalExitCode(signal: NodeJS.Signals): number {
	switch (signal) {
		case "SIGINT":
			return 130;
		case "SIGTERM":
			return 143;
		default:
			return 1;
	}
}

function delayMs(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function resolveIssueId(
	store: IssueStore,
	rawId: string,
): Promise<{ issueId: string | null; error: string | null }> {
	const direct = await store.get(rawId);
	if (direct) {
		return { issueId: direct.id, error: null };
	}

	const all = await store.list();
	const matches = all.map((i) => i.id).filter((id) => id.startsWith(rawId));
	if (matches.length === 0) {
		return {
			issueId: null,
			error:
				`not found: ${rawId}` +
				formatRecovery(["mu issues list --limit 20", "mu issues ready --root <root-id>", "mu status"]),
		};
	}
	if (matches.length > 1) {
		const sample = matches.slice(0, 5).join(",");
		const suffix = matches.length > 5 ? "..." : "";
		return {
			issueId: null,
			error:
				`ambiguous id prefix: ${rawId} (${sample}${suffix})` +
				formatRecovery(["use a longer id prefix", "mu issues list --limit 20"]),
		};
	}
	return { issueId: matches[0]!, error: null };
}

function mainHelp(): string {
	const cmd = (s: string) => chalk.cyan(s);
	const dim = (s: string) => chalk.dim(s);
	const h = (s: string) => chalk.bold(s);
	return [
		`${chalk.bold.magenta("mu")} ${dim("— personal agent for technical work")}`,
		"",
		`${h("Usage:")}  mu ${dim("<command> [args...]")}`,
		"",
		h("Getting started:"),
		`  ${dim("1)")} mu run ${dim('"Break down and execute this goal"')}`,
		`  ${dim("2)")} mu status --pretty`,
		`  ${dim("3)")} mu issues ready --root ${dim("<root-id>")} --pretty`,
		"",
		h("Agent quick navigation:"),
		`  ${dim("Inspect:")}   ${cmd("mu status --pretty")}`,
		`  ${dim("Work queue:")} ${cmd("mu issues ready --root <root-id> --tag role:worker --pretty")}`,
		`  ${dim("Memory:")}    ${cmd("mu memory search --query <text> --limit 20")}`,
		`  ${dim("Index:")}     ${cmd("mu memory index status")} ${dim("/ ")} ${cmd("mu memory index rebuild")}`,
		`  ${dim("Forensics:")} ${cmd("mu store tail events --limit 20")}`,
		"",
		h("Commands (grouped):"),
		`  ${cmd("guide")}                                 ${dim("In-CLI guide")}`,
		`  ${cmd("status")} ${dim("[--json] [--pretty]")}            Repo + work summary`,
		`  ${cmd("issues")} ${dim("<subcmd>")}                       Work-item lifecycle`,
		`  ${cmd("forum")} ${dim("<subcmd>")}                        Coordination topics/messages`,
		`  ${cmd("memory")} ${dim("<subcmd>")}                       Cross-store memory (search/timeline/stats/index)`,
		`  ${cmd("events")} ${dim("<subcmd>")}                       Event-log queries`,
		`  ${cmd("run")} ${dim("<prompt...>")}                       Queue run + attach operator session`,
		`  ${cmd("resume")} ${dim("<root-id>")}                      Resume a run`,
		`  ${cmd("runs")} ${dim("<subcmd>")}                         Queued-run management + traces`,
		`  ${cmd("heartbeats")} ${dim("<subcmd>")}                   Heartbeat program lifecycle`,
		`  ${cmd("cron")} ${dim("<subcmd>")}                         Cron program lifecycle`,
		`  ${cmd("control")} ${dim("<subcmd>")}                      Messaging integrations + identity`,
		`  ${cmd("turn")} ${dim("[opts]")}                            Inject prompt into existing session transcript`,
		`  ${cmd("session")} ${dim("[list|<id>] [opts]")}               Reconnect/list terminal operator sessions`,
		`  ${cmd("serve")} ${dim("[--port N]")}                    Start API + operator session`,
		`  ${cmd("stop")} ${dim("[--force]")}                        Stop background server`,
		`  ${cmd("store")} ${dim("<subcmd>")}                        Inspect workspace store files/logs`,
		`  ${cmd("replay")} ${dim("<id|path>")}                      Replay previous run log`,
		`  ${cmd("login")} ${dim("[<provider>] [--list]")}           Authenticate with an AI provider`,
		"",
		`${h("Output defaults:")} compact-by-default for most read/mutation commands; add --json for full records.`,
		`${dim("Run")} ${cmd("mu <command> --help")} ${dim("for command-specific options/examples.")}`,
		`${dim("Running")} ${cmd("mu")} ${dim("with no arguments starts")} ${cmd("mu serve")}${dim(".")}`,
		`${dim("Run")} ${cmd("mu guide")} ${dim("for the full in-CLI guide.")}`,
	].join("\n");
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

	switch (cmd) {
		case "guide":
			return await cmdGuide(rest);
		case "init":
			return jsonError(
				"`mu init` has been removed. mu now auto-initializes the workspace store on `mu run` and `mu serve`.",
				{
					recovery: ['mu run "Break down and execute this goal"', "mu serve", "mu --help"],
				},
			);
		case "status":
			return await cmdStatus(rest, ctx);
		case "store":
			return await cmdStore(rest, ctx);
		case "issues":
			return await cmdIssues(rest, ctx);
		case "forum":
			return await cmdForum(rest, ctx);
		case "events":
			return await cmdEvents(rest, ctx);
		case "runs":
			return await cmdRuns(rest, ctx);
		case "heartbeats":
			return await cmdHeartbeats(rest, ctx);
		case "cron":
			return await cmdCron(rest, ctx);
		case "memory":
			return await cmdMemoryDelegated(rest, ctx);
		case "context":
			return await cmdMemoryDelegated(rest, ctx);
		case "turn":
			return await cmdTurn(rest, ctx);
		case "run":
			return await cmdRun(rest, ctx);
		case "_run-direct":
			return await cmdRunDirect(rest, ctx);
		case "resume":
			return await cmdResume(rest, ctx);
		case "login":
			return await cmdLogin(rest);
		case "replay":
			return await cmdReplay(rest, ctx);
		case "control":
			return await cmdControl(rest, ctx);
		case "session":
			return await cmdSession(rest, ctx);
		case "serve":
			return await cmdServe(rest, ctx);
		case "stop":
			return await cmdStop(rest, ctx);
		default:
			return jsonError(`unknown command: ${cmd}`, {
				recovery: ["mu --help"],
			});
	}
}

async function cmdGuide(argv: string[]): Promise<RunResult> {
	if (argv.length > 0 && !hasHelpFlag(argv)) {
		return jsonError(`unknown args: ${argv.join(" ")}`, { recovery: ["mu guide"] });
	}
	const { guideText } = await import("./guide.js");
	return ok(`${guideText()}\n`);
}

function statusCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		jsonError,
		jsonText,
		ok,
	};
}

async function cmdStatus(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStatusCommand(argv, ctx, statusCommandDeps());
}

function storeCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
	};
}

async function cmdStore(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStoreCommand(argv, ctx, storeCommandDeps());
}

function issuesCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		getRepeatFlagValues,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		resolveIssueId,
		issueJson,
		renderIssueCompactTable,
		renderIssueDetailCompact,
		renderIssueMutationCompact,
		renderIssueDepMutationCompact,
	};
}

async function cmdIssues(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdIssuesCommand(argv, ctx, issuesCommandDeps());
}

function forumCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		renderForumPostCompact,
		renderForumReadCompact,
		renderForumTopicsCompact,
	};
}

async function cmdForum(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdForumCommand(argv, ctx, forumCommandDeps());
}

function setSearchParamIfPresent(search: URLSearchParams, key: string, value: string | null | undefined): void {
	if (value == null) {
		return;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return;
	}
	search.set(key, trimmed);
}

function eventsCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		renderEventsCompactTable,
	};
}

async function cmdEvents(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdEventsCommand(argv, ctx, eventsCommandDeps());
}

function schedulingCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		setSearchParamIfPresent,
		jsonError,
		jsonText,
		ok,
		requestServerJson,
		renderRunPayloadCompact,
		renderHeartbeatsPayloadCompact,
		renderCronPayloadCompact,
	};
}

async function cmdRuns(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunsCommand(argv, ctx, schedulingCommandDeps());
}

async function cmdHeartbeats(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdHeartbeatsCommand(argv, ctx, schedulingCommandDeps());
}

async function cmdCron(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdCronCommand(argv, ctx, schedulingCommandDeps());
}

async function cmdMemoryDelegated(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdMemoryCommand(argv, ctx, {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		setSearchParamIfPresent,
		jsonError,
		jsonText,
		ok,
		describeError,
	});
}

async function cmdTurn(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdTurnCommand(argv, ctx, {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		jsonError,
		ok,
		jsonText,
		describeError,
	});
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function trimForHeader(text: string, maxLen: number): string {
	const t = oneLine(text);
	if (t.length <= maxLen) return t;
	if (maxLen <= 3) return t.slice(0, maxLen);
	return `${t.slice(0, maxLen - 3)}...`;
}

function ensureTrailingNewline(text: string): string {
	return text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
}

function runCommandDeps() {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		ok,
		runServeLifecycle,
	};
}

async function cmdRun(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunCommand(argv, ctx, runCommandDeps());
}

function runDirectCommandDeps() {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		trimForHeader,
		ensureTrailingNewline,
	};
}

async function cmdRunDirect(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunDirectCommand(argv, ctx, runDirectCommandDeps());
}

function resumeCommandDeps() {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		resolveIssueId,
		trimForHeader,
		ensureTrailingNewline,
	};
}

async function cmdResume(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdResumeCommand(argv, ctx, resumeCommandDeps());
}

function replayCommandDeps() {
	return {
		hasHelpFlag,
		getFlagValue,
		jsonError,
		ok,
		fileExists,
	};
}

async function cmdReplay(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdReplayCommand(argv, ctx, replayCommandDeps());
}

function sessionCommandDeps() {
	return {
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
	};
}

async function cmdSession(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdSessionCommand(argv, ctx, sessionCommandDeps());
}

function operatorSessionCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		jsonError,
		jsonText,
		ok,
		defaultOperatorSessionStart,
	};
}

async function cmdOperatorSession(
	argv: string[],
	ctx: CliCtx,
	options: OperatorSessionCommandOptions = {},
): Promise<RunResult> {
	return await cmdOperatorSessionCommand(argv, ctx, options, operatorSessionCommandDeps());
}

function loginCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		jsonError,
		ok,
	};
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

function serveCommandDeps() {
	return {
		hasHelpFlag,
		getFlagValue,
		popFlag,
		ensureInt,
		jsonError,
		ok,
		delayMs,
		detectRunningServer,
		buildServeDeps,
		cleanupStaleServerFiles,
		runServeLifecycle,
	};
}

async function cmdServe(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdServeCommand(argv, ctx, serveCommandDeps());
}

async function cmdStop(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStopCommand(argv, ctx, serveCommandDeps());
}

// ROLE_SCOPES lives in @femtomc/mu-control-plane; lazy-imported alongside IdentityStore.

function controlCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		getRepeatFlagValues,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
		nonEmptyString,
		describeError,
		storePathForRepoRoot,
		detectRunningServer,
		readApiError,
	};
}

async function cmdControl(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdControlCommand(argv, ctx, controlCommandDeps());
}
