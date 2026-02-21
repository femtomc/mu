type JsonErrorResult<Result> = (
	msg: string,
	opts?: { pretty?: boolean; recovery?: readonly string[] },
) => Result;

export type CommandRouterDeps<Ctx, Result> = {
	jsonError: JsonErrorResult<Result>;
	cmdGuide: (argv: string[]) => Promise<Result>;
	cmdStatus: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdStore: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdIssues: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdForum: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdEvents: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdHeartbeats: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdCron: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdMemoryDelegated: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdTurn: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdExec: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdLogin: (argv: string[]) => Promise<Result>;
	cmdReplay: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdControl: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdSession: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdServe: (argv: string[], ctx: Ctx) => Promise<Result>;
	cmdStop: (argv: string[], ctx: Ctx) => Promise<Result>;
};

export async function routeCommand<Ctx, Result>(
	cmd: string,
	rest: string[],
	ctx: Ctx,
	deps: CommandRouterDeps<Ctx, Result>,
): Promise<Result> {
	switch (cmd) {
		case "guide":
			return await deps.cmdGuide(rest);
		case "init":
			return deps.jsonError(
				"`mu init` has been removed. mu now auto-initializes the workspace store on `mu serve`.",
				{
					recovery: ["mu serve", "mu --help"],
				},
			);
		case "status":
			return await deps.cmdStatus(rest, ctx);
		case "store":
			return await deps.cmdStore(rest, ctx);
		case "issues":
			return await deps.cmdIssues(rest, ctx);
		case "forum":
			return await deps.cmdForum(rest, ctx);
		case "events":
			return await deps.cmdEvents(rest, ctx);
		case "heartbeats":
			return await deps.cmdHeartbeats(rest, ctx);
		case "cron":
			return await deps.cmdCron(rest, ctx);
		case "memory":
			return await deps.cmdMemoryDelegated(rest, ctx);
		case "context":
			return await deps.cmdMemoryDelegated(rest, ctx);
		case "turn":
			return await deps.cmdTurn(rest, ctx);
		case "exec":
			return await deps.cmdExec(rest, ctx);
		case "login":
			return await deps.cmdLogin(rest);
		case "replay":
			return await deps.cmdReplay(rest, ctx);
		case "control":
			return await deps.cmdControl(rest, ctx);
		case "session":
			return await deps.cmdSession(rest, ctx);
		case "serve":
			return await deps.cmdServe(rest, ctx);
		case "stop":
			return await deps.cmdStop(rest, ctx);
		default:
			return deps.jsonError(`unknown command: ${cmd}`, {
				recovery: ["mu --help"],
			});
	}
}
