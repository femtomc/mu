import { dirname, join } from "node:path";
import chalk from "chalk";
import type { IssueStore } from "@femtomc/mu-issue";
import { cmdOperatorSession as cmdOperatorSessionCommand } from "./commands/operator_session.js";
import { operatorSessionCommandDeps } from "./command_deps.js";
import { createCommandHandlers } from "./command_handlers.js";
import { detectRunningServer, requestServerJson as requestServerJsonHelper } from "./server_helpers.js";
import {
	buildServeDeps as buildServeDepsRuntime,
	runServeLifecycle as runServeLifecycleRuntime,
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
import { formatRecovery, jsonError, ok } from "./cli_primitives.js";
import { resolveIssueId as resolveIssueIdCore } from "./issue_resolution.js";
import { mainHelp } from "./main_help.js";
import { routeCommand } from "./command_router.js";
import type { CliCtx, CliIO, RunResult } from "./types.js";
import { delayMs, describeError, signalExitCode } from "./cli_utils.js";

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

async function createCliCtx(cwd: string, opts: RunOptions): Promise<CliCtx> {
	const ctx0 = await ensureCtx(cwd);
	return {
		...ctx0,
		io: opts.io,
		backend: opts.backend,
		operatorSessionFactory: opts.operatorSessionFactory,
		serveDeps: opts.serveDeps,
	};
}

function buildCommandHandlers() {
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
		const ctx = await createCliCtx(cwd, opts);
		return await buildCommandHandlers().cmdServe([], ctx);
	}
	if (argv.includes("--version")) {
		const pkgPath = join(dirname(new URL(import.meta.url).pathname), "..", "package.json");
		const { version } = JSON.parse(await Bun.file(pkgPath).text()) as { version: string };
		return ok(`${chalk.bold.magenta("mu")} ${chalk.dim(version)}\n`);
	}

	const cmd = argv[0]!;
	const rest = argv.slice(1);
	const ctx = await createCliCtx(cwd, opts);

	return await routeCommand(cmd, rest, ctx, {
		jsonError,
		...buildCommandHandlers(),
	});
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

