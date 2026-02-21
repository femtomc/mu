import type { IssueStore } from "@femtomc/mu-issue";
import { cmdControl as cmdControlCommand } from "./commands/control.js";
import { cmdEvents as cmdEventsCommand } from "./commands/events.js";
import { cmdForum as cmdForumCommand } from "./commands/forum.js";
import { cmdIssues as cmdIssuesCommand } from "./commands/issues.js";
import { cmdReplay as cmdReplayCommand } from "./commands/replay.js";
import { cmdOperatorSession as cmdOperatorSessionCommand } from "./commands/operator_session.js";
import { cmdServe as cmdServeCommand, cmdStop as cmdStopCommand } from "./commands/serve.js";
import { cmdSession as cmdSessionCommand } from "./commands/session.js";
import { cmdStore as cmdStoreCommand } from "./commands/store.js";
import { cmdStatus as cmdStatusCommand } from "./commands/status.js";
import { cmdCron as cmdCronCommand, cmdHeartbeats as cmdHeartbeatsCommand } from "./commands/scheduling.js";
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
	schedulingCommandDeps,
	sessionCommandDeps,
	serveCommandDeps,
	statusCommandDeps,
	storeCommandDeps,
	turnCommandDeps,
} from "./command_deps.js";
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
			return await cmdStatusCommand(argv, ctx, statusCommandDeps());
		},
		cmdStore: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdStoreCommand(argv, ctx, storeCommandDeps());
		},
		cmdIssues: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdIssuesCommand(argv, ctx, issuesCommandDeps(deps.resolveIssueId));
		},
		cmdForum: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdForumCommand(argv, ctx, forumCommandDeps());
		},
		cmdEvents: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdEventsCommand(argv, ctx, eventsCommandDeps());
		},
		cmdHeartbeats: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdHeartbeatsCommand(argv, ctx, schedulingCommandDeps(deps.requestServerJson));
		},
		cmdCron: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdCronCommand(argv, ctx, schedulingCommandDeps(deps.requestServerJson));
		},
		cmdMemoryDelegated: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdMemoryCommand(argv, ctx, memoryCommandDeps());
		},
		cmdTurn: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdTurnCommand(argv, ctx, turnCommandDeps());
		},
		cmdExec: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdOperatorSessionCommand(
				argv,
				ctx,
				{ commandName: "exec", allowInteractive: false, session: { mode: "in-memory" } },
				operatorSessionCommandDeps(),
			);
		},
		cmdLogin: async (argv: string[]): Promise<RunResult> => {
			return await cmdLoginCommand(argv, loginCommandDeps());
		},
		cmdReplay: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdReplayCommand(argv, ctx, replayCommandDeps());
		},
		cmdControl: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdControlCommand(argv, ctx, controlCommandDeps());
		},
		cmdSession: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdSessionCommand(argv, ctx, sessionCommandDeps(deps.runServeLifecycle));
		},
		cmdServe: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdServeCommand(
				argv,
				ctx,
				serveCommandDeps({ buildServeDeps: deps.buildServeDeps, runServeLifecycle: deps.runServeLifecycle }),
			);
		},
		cmdStop: async (argv: string[], ctx: CliCtx): Promise<RunResult> => {
			return await cmdStopCommand(
				argv,
				ctx,
				serveCommandDeps({ buildServeDeps: deps.buildServeDeps, runServeLifecycle: deps.runServeLifecycle }),
			);
		},
	};
}
