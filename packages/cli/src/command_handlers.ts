import type { IssueStore } from "@femtomc/mu-issue";
import { hasHelpFlag, jsonError, ok } from "./cli_primitives.js";
import type { ServeDeps, ServeLifecycleOptions } from "./serve_runtime.js";
import type { CliCtx, RunResult } from "./types.js";

type ResolveIssueIdFn = (
	store: IssueStore,
	rawId: string,
) => Promise<{ issueId: string | null; error: string | null }>;

type RequestServerJsonFn = <T>(opts: {
	ctx: CliCtx;
	pretty: boolean;
	method?: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	recoveryCommand: string;
	timeoutMs?: number;
}) => Promise<{ ok: true; payload: T } | { ok: false; result: RunResult }>;

type CreateCommandHandlersDeps = {
	resolveIssueId: ResolveIssueIdFn;
	requestServerJson: RequestServerJsonFn;
	runServeLifecycle: (ctx: CliCtx, opts: ServeLifecycleOptions) => Promise<RunResult>;
	buildServeDeps: (ctx: CliCtx) => ServeDeps;
};

export function createCommandHandlers(deps: CreateCommandHandlersDeps) {
	return {
		cmdGuide: async (argv: string[]): Promise<RunResult> => {
			if (argv.length > 0 && !hasHelpFlag(argv)) {
				return jsonError(`unknown args: ${argv.join(" ")}`, { recovery: ["mu guide"] });
			}
			const { guideText } = await import("./guide.js");
			return ok(`${guideText()}\n`);
		},
		cmdStatus: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdStatus: cmdStatusCommand }, { statusCommandDeps }] = await Promise.all([
				import("./commands/status.js"),
				import("./command_deps.js"),
			]);
			return await cmdStatusCommand(argv, ctx, statusCommandDeps());
		},
		cmdStore: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdStore: cmdStoreCommand }, { storeCommandDeps }] = await Promise.all([
				import("./commands/store.js"),
				import("./command_deps.js"),
			]);
			return await cmdStoreCommand(argv, ctx, storeCommandDeps());
		},
		cmdIssues: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdIssues: cmdIssuesCommand }, { issuesCommandDeps }] = await Promise.all([
				import("./commands/issues.js"),
				import("./command_deps.js"),
			]);
			return await cmdIssuesCommand(argv, ctx, issuesCommandDeps(deps.resolveIssueId));
		},
		cmdForum: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdForum: cmdForumCommand }, { forumCommandDeps }] = await Promise.all([
				import("./commands/forum.js"),
				import("./command_deps.js"),
			]);
			return await cmdForumCommand(argv, ctx, forumCommandDeps());
		},
		cmdEvents: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdEvents: cmdEventsCommand }, { eventsCommandDeps }] = await Promise.all([
				import("./commands/events.js"),
				import("./command_deps.js"),
			]);
			return await cmdEventsCommand(argv, ctx, eventsCommandDeps());
		},
		cmdHeartbeats: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdHeartbeats: cmdHeartbeatsCommand }, { schedulingCommandDeps }] = await Promise.all([
				import("./commands/scheduling.js"),
				import("./command_deps.js"),
			]);
			return await cmdHeartbeatsCommand(argv, ctx, schedulingCommandDeps(deps.requestServerJson));
		},
		cmdCron: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdCron: cmdCronCommand }, { schedulingCommandDeps }] = await Promise.all([
				import("./commands/scheduling.js"),
				import("./command_deps.js"),
			]);
			return await cmdCronCommand(argv, ctx, schedulingCommandDeps(deps.requestServerJson));
		},
		cmdMemoryDelegated: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdMemory: cmdMemoryCommand }, { memoryCommandDeps }] = await Promise.all([
				import("./commands/memory.js"),
				import("./command_deps.js"),
			]);
			return await cmdMemoryCommand(argv, ctx, memoryCommandDeps());
		},
		cmdTurn: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdTurn: cmdTurnCommand }, { turnCommandDeps }] = await Promise.all([
				import("./commands/turn.js"),
				import("./command_deps.js"),
			]);
			return await cmdTurnCommand(argv, ctx, turnCommandDeps());
		},
		cmdExec: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [
				{ cmdOperatorSession: cmdOperatorSessionCommand },
				{ operatorSessionCommandDeps },
			] = await Promise.all([
				import("./commands/operator_session.js"),
				import("./command_deps.js"),
			]);
			return await cmdOperatorSessionCommand(
				argv,
				ctx,
				{ commandName: "exec", allowInteractive: false, session: { mode: "in-memory" } },
				operatorSessionCommandDeps(),
			);
		},
		cmdLogin: async (argv: string[]): Promise<RunResult> => {
			const [{ cmdLogin: cmdLoginCommand }, { loginCommandDeps }] = await Promise.all([
				import("./commands/login.js"),
				import("./command_deps.js"),
			]);
			return await cmdLoginCommand(argv, loginCommandDeps());
		},
		cmdReplay: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdReplay: cmdReplayCommand }, { replayCommandDeps }] = await Promise.all([
				import("./commands/replay.js"),
				import("./command_deps.js"),
			]);
			return await cmdReplayCommand(argv, ctx, replayCommandDeps());
		},
		cmdControl: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdControl: cmdControlCommand }, { controlCommandDeps }] = await Promise.all([
				import("./commands/control.js"),
				import("./command_deps.js"),
			]);
			return await cmdControlCommand(argv, ctx, controlCommandDeps());
		},
		cmdSession: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdSession: cmdSessionCommand }, { sessionCommandDeps }] = await Promise.all([
				import("./commands/session.js"),
				import("./command_deps.js"),
			]);
			return await cmdSessionCommand(argv, ctx, sessionCommandDeps(deps.runServeLifecycle));
		},
		cmdServe: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdServe: cmdServeCommand }, { serveCommandDeps }] = await Promise.all([
				import("./commands/serve.js"),
				import("./command_deps.js"),
			]);
			return await cmdServeCommand(
				argv,
				ctx,
				serveCommandDeps({ buildServeDeps: deps.buildServeDeps, runServeLifecycle: deps.runServeLifecycle }),
			);
		},
		cmdStop: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			const [{ cmdStop: cmdStopCommand }, { serveCommandDeps }] = await Promise.all([
				import("./commands/serve.js"),
				import("./command_deps.js"),
			]);
			return await cmdStopCommand(
				argv,
				ctx,
				serveCommandDeps({ buildServeDeps: deps.buildServeDeps, runServeLifecycle: deps.runServeLifecycle }),
			);
		},
	};
}
