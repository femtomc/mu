export type EventsCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type EventsCommandCtx = {
	paths: {
		eventsPath: string;
	};
};

export type EventsCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => EventsCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => EventsCommandRunResult;
	renderEventsCompactTable: (rows: readonly Record<string, unknown>[]) => string;
};

export async function cmdEvents<Ctx extends EventsCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: EventsCommandDeps,
): Promise<EventsCommandRunResult> {
	const { hasHelpFlag, popFlag, getFlagValue, ensureInt, jsonError, jsonText, ok, renderEventsCompactTable } = deps;

	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
	if (argv0.length === 0 || hasHelpFlag(argv0)) {
		return ok(
			[
				"mu events - query event log entries",
				"",
				"Usage:",
				"  mu events <list|trace> [filters...] [--json] [--pretty]",
				"",
				"Filters:",
				"  --type <TYPE>",
				"  --source <SOURCE>",
				"  --issue-id <ID>",
				"  --run-id <ID>",
				"  --contains <TEXT>",
				"  --since <EPOCH_MS>",
				"  --limit <N> (default: list=20, trace=40)",
				"  --json Emit full JSON payload (default is compact event table)",
			].join("\n") + "\n",
		);
	}

	const sub = argv0[0]!;
	const rest = argv0.slice(1);
	if (sub !== "list" && sub !== "trace") {
		return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu events --help"] });
	}

	const { value: type, rest: argv1 } = getFlagValue(rest, "--type");
	const { value: source, rest: argv2 } = getFlagValue(argv1, "--source");
	const { value: issueId, rest: argv3 } = getFlagValue(argv2, "--issue-id");
	const { value: runId, rest: argv4 } = getFlagValue(argv3, "--run-id");
	const { value: contains, rest: argv5 } = getFlagValue(argv4, "--contains");
	const { value: sinceRaw, rest: argv6 } = getFlagValue(argv5, "--since");
	const { value: limitRaw, rest: argv7 } = getFlagValue(argv6, "--limit");
	const { present: jsonMode, rest: argv8 } = popFlag(argv7, "--json");
	const { present: compact, rest: unknown } = popFlag(argv8, "--compact");
	if (unknown.length > 0) {
		return jsonError(`unknown args: ${unknown.join(" ")}`, { pretty, recovery: ["mu events --help"] });
	}

	const sinceMs = sinceRaw ? ensureInt(sinceRaw, { name: "--since", min: 0 }) : null;
	if (sinceRaw && sinceMs == null) {
		return jsonError("--since must be an integer >= 0", { pretty, recovery: ["mu events list --since 0"] });
	}
	const defaultLimit = sub === "trace" ? 40 : 20;
	const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : defaultLimit;
	if (limit == null) {
		return jsonError("--limit must be an integer between 1 and 500", {
			pretty,
			recovery: ["mu events list --limit 20"],
		});
	}

	const { readJsonl } = await import("@femtomc/mu-core/node");
	const rows = (await readJsonl(ctx.paths.eventsPath)) as Array<Record<string, unknown>>;
	const filtered = rows
		.filter((row) => (type ? row.type === type : true))
		.filter((row) => (source ? row.source === source : true))
		.filter((row) => (issueId ? row.issue_id === issueId : true))
		.filter((row) => (runId ? row.run_id === runId : true))
		.filter((row) => {
			if (sinceMs == null) return true;
			const ts = typeof row.ts_ms === "number" ? Math.trunc(row.ts_ms) : null;
			return ts != null && ts >= sinceMs;
		})
		.filter((row) => {
			if (!contains) {
				return true;
			}
			const needle = contains.toLowerCase();
			const haystack = [
				typeof row.type === "string" ? row.type : "",
				typeof row.source === "string" ? row.source : "",
				typeof row.issue_id === "string" ? row.issue_id : "",
				typeof row.run_id === "string" ? row.run_id : "",
				JSON.stringify(row.payload ?? null),
			]
				.join("\n")
				.toLowerCase();
			return haystack.includes(needle);
		});

	const events = filtered.slice(-limit);
	if (!jsonMode || compact) {
		const summary = `Events: ${events.length} shown (matched ${filtered.length})\n`;
		return ok(`${summary}${renderEventsCompactTable(events)}`);
	}
	return ok(jsonText({ count: events.length, events }, pretty));
}
