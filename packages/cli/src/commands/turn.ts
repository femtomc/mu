import { executeSessionTurn, SessionTurnError, type SessionTurnRequest } from "@femtomc/mu-agent";

export type TurnCommandCtx = {
	repoRoot: string;
};

export type TurnCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type TurnCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => TurnCommandRunResult;
	ok: (stdout?: string, exitCode?: number) => TurnCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	describeError: (err: unknown) => string;
};

export async function cmdTurn(argv: string[], ctx: TurnCommandCtx, deps: TurnCommandDeps): Promise<TurnCommandRunResult> {
	const { hasHelpFlag, popFlag, getFlagValue, jsonError, ok, jsonText, describeError } = deps;
	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
	if (hasHelpFlag(argv0)) {
		return ok(
			[
				"mu turn - inject one prompt turn into an existing session transcript",
				"",
				"Usage:",
				"  mu turn --session-id <id> --body <text> [--session-kind KIND] [--source SRC] [--provider ID] [--model ID] [--thinking LVL]",
			].join("\n") + "\n",
		);
	}

	const { value: sessionId, rest: argv1 } = getFlagValue(argv0, "--session-id");
	const { value: sessionKind, rest: argv2 } = getFlagValue(argv1, "--session-kind");
	const { value: body, rest: argv3 } = getFlagValue(argv2, "--body");
	const { value: source, rest: argv4 } = getFlagValue(argv3, "--source");
	const { value: provider, rest: argv5 } = getFlagValue(argv4, "--provider");
	const { value: model, rest: argv6 } = getFlagValue(argv5, "--model");
	const { value: thinking, rest: argv7 } = getFlagValue(argv6, "--thinking");
	const { value: sessionFile, rest: argv8 } = getFlagValue(argv7, "--session-file");
	const { value: sessionDir, rest: argv9 } = getFlagValue(argv8, "--session-dir");
	const { value: extensionProfile, rest } = getFlagValue(argv9, "--extension-profile");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu turn --help"] });
	}
	if (!sessionId) {
		return jsonError("missing --session-id", {
			pretty,
			recovery: ["mu turn --session-id <id> --body <text>"],
		});
	}
	if (!body) {
		return jsonError("missing --body", {
			pretty,
			recovery: ["mu turn --session-id <id> --body <text>"],
		});
	}

	const request: SessionTurnRequest = {
		session_id: sessionId,
		session_kind: sessionKind ?? null,
		body,
		source: source ?? null,
		provider: provider ?? null,
		model: model ?? null,
		thinking: thinking ?? null,
		session_file: sessionFile ?? null,
		session_dir: sessionDir ?? null,
		extension_profile: extensionProfile ?? null,
	};

	try {
		const turn = await executeSessionTurn({
			repoRoot: ctx.repoRoot,
			request,
		});
		return ok(jsonText({ ok: true, turn }, pretty));
	} catch (err) {
		if (err instanceof SessionTurnError) {
			return jsonError(err.message, {
				pretty,
				recovery: ["mu turn --session-id <id> --body <text>"],
			});
		}
		return jsonError(`session turn failed: ${describeError(err)}`, {
			pretty,
			recovery: ["mu turn --session-id <id> --body <text>"],
		});
	}
}
