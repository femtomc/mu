export type SchedulingCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type SchedulingCommandDeps<Ctx> = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	setSearchParamIfPresent: (search: URLSearchParams, key: string, value: string | null | undefined) => void;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => SchedulingCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => SchedulingCommandRunResult;
	requestServerJson: <T>(opts: {
		ctx: Ctx;
		pretty: boolean;
		method?: "GET" | "POST";
		path: string;
		body?: Record<string, unknown>;
		recoveryCommand: string;
	}) => Promise<{ ok: true; payload: T } | { ok: false; result: SchedulingCommandRunResult }>;
	renderRunPayloadCompact: (payload: Record<string, unknown>) => string;
	renderHeartbeatsPayloadCompact: (payload: Record<string, unknown>) => string;
	renderCronPayloadCompact: (payload: Record<string, unknown>) => string;
};

function parseOptionalBoolean(value: string | null | undefined): boolean | null {
	if (value == null) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") {
		return true;
	}
	if (normalized === "false") {
		return false;
	}
	return null;
}

function buildSchedulingHandlers<Ctx>(deps: SchedulingCommandDeps<Ctx>): {
	cmdRuns: (argv: string[], ctx: Ctx) => Promise<SchedulingCommandRunResult>;
	cmdHeartbeats: (argv: string[], ctx: Ctx) => Promise<SchedulingCommandRunResult>;
	cmdCron: (argv: string[], ctx: Ctx) => Promise<SchedulingCommandRunResult>;
} {
	const {
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
	} = deps;

	async function cmdRuns(argv: string[], ctx: Ctx): Promise<SchedulingCommandRunResult> {
		const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
		if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
			return ok(
				[
					"mu runs - run queue + trace operations",
					"",
					"Usage:",
					"  mu runs <list|get|trace|start|resume|interrupt> [args...] [--json] [--pretty]",
					"",
					"Subcommands:",
					"  list       List queued/running/completed runs",
					"  get        Show one run by job id or root issue id",
					"  trace      Show run trace rows for a run",
					"  start      Queue a new run",
					"  resume     Queue resume for an existing root",
					"  interrupt  Interrupt an active run",
					"",
					"Output mode:",
					"  compact-by-default output for run reads/mutations; add --json for full records.",
					"",
					"Examples:",
					"  mu runs list --status running --limit 20",
					"  mu runs get <run-id-or-root-id>",
					"  mu runs trace <run-id-or-root-id> --limit 80",
					'  mu runs start "Ship release" --max-steps 25',
					"  mu runs resume <root-id> --max-steps 25",
					"  mu runs interrupt <root-id>",
					"",
					"Run `mu runs <subcommand> --help` for command-specific usage.",
				].join("\n") + "\n",
			);
		}

		const sub = argv0[0]!;
		const rest = argv0.slice(1);

		switch (sub) {
			case "list":
				return await runsList(rest, ctx, pretty);
			case "get":
				return await runsGet(rest, ctx, pretty);
			case "trace":
				return await runsTrace(rest, ctx, pretty);
			case "start":
				return await runsStart(rest, ctx, pretty);
			case "resume":
				return await runsResume(rest, ctx, pretty);
			case "interrupt":
				return await runsInterrupt(rest, ctx, pretty);
			default:
				return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu runs --help"] });
		}
	}

	async function runsList(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu runs list - list queued/running/completed runs",
					"",
					"Usage:",
					"  mu runs list [--status STATUS] [--limit N] [--json] [--pretty]",
					"",
					"Options:",
					"  --status <queued|running|succeeded|failed|cancelled>   Optional status filter",
					"  --limit <N>                                             Result size (default: 20)",
					"  --json                                                  Emit full JSON payload",
					"",
					"Examples:",
					"  mu runs list",
					"  mu runs list --status running --limit 20",
					"  mu runs list --json --pretty",
				].join("\n") + "\n",
			);
		}
		const { value: status, rest: argv0 } = getFlagValue(argv, "--status");
		const { value: limitRaw, rest: argv1 } = getFlagValue(argv0, "--limit");
		const { present: jsonMode, rest: argv2 } = popFlag(argv1, "--json");
		const { present: compact, rest } = popFlag(argv2, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu runs --help"] });
		}
		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 20;
		if (limit == null) {
			return jsonError("--limit must be an integer between 1 and 500", {
				pretty,
				recovery: ["mu runs list --limit 20"],
			});
		}

		const search = new URLSearchParams();
		setSearchParamIfPresent(search, "status", status ?? null);
		search.set("limit", String(limit));
		const suffix = search.size > 0 ? `?${search.toString()}` : "";
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: `/api/control-plane/runs${suffix}`,
			recoveryCommand: "mu runs list",
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderRunPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function runsGet(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu runs get - show one run by job id or root issue id",
					"",
					"Usage:",
					"  mu runs get <run-id-or-root-id> [--json] [--pretty]",
					"",
					"Examples:",
					"  mu runs get run-abc123",
					"  mu runs get mu-root1234 --json --pretty",
				].join("\n") + "\n",
			);
		}
		if (argv.length === 0) {
			return jsonError("missing run id", { pretty, recovery: ["mu runs get <run-id-or-root-id>"] });
		}
		const id = argv[0]!;
		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu runs get --help"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: `/api/control-plane/runs/${encodeURIComponent(id)}`,
			recoveryCommand: `mu runs get ${id}`,
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderRunPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function runsTrace(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu runs trace - show trace rows for one run",
					"",
					"Usage:",
					"  mu runs trace <run-id-or-root-id> [--limit N] [--json] [--pretty]",
					"",
					"Options:",
					"  --limit <N>   Trace rows to return (default: 40, max: 2000)",
					"",
					"Examples:",
					"  mu runs trace <run-id> --limit 80",
					"  mu runs trace <run-id> --json --pretty",
				].join("\n") + "\n",
			);
		}
		if (argv.length === 0) {
			return jsonError("missing run id", { pretty, recovery: ["mu runs trace <run-id-or-root-id>"] });
		}
		const id = argv[0]!;
		const { value: limitRaw, rest: argv0 } = getFlagValue(argv.slice(1), "--limit");
		const { present: jsonMode, rest: argv1 } = popFlag(argv0, "--json");
		const { present: compact, rest } = popFlag(argv1, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu runs trace --help"] });
		}
		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 2000 }) : 40;
		if (limit == null) {
			return jsonError("--limit must be an integer between 1 and 2000", {
				pretty,
				recovery: [`mu runs trace ${id} --limit 80`],
			});
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: `/api/control-plane/runs/${encodeURIComponent(id)}/trace?limit=${limit}`,
			recoveryCommand: `mu runs trace ${id}`,
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderRunPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function runsStart(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu runs start - queue a new run",
					"",
					"Usage:",
					"  mu runs start <prompt...> [--max-steps N] [--json] [--pretty]",
					"",
					"Options:",
					"  --max-steps <N>   DAG step budget (default: 20, max: 500)",
					"  --json            Emit full JSON payload",
					"",
					"Examples:",
					'  mu runs start "Ship release" --max-steps 25',
					'  mu runs start "Investigate failing test" --json --pretty',
				].join("\n") + "\n",
			);
		}
		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { present: compact, rest: argv1 } = popFlag(argv0, "--compact");
		const { value: maxStepsRaw, rest } = getFlagValue(argv1, "--max-steps");
		const promptParts = rest;
		const prompt = promptParts.join(" ").trim();
		if (!prompt) {
			return jsonError("missing prompt", { pretty, recovery: ['mu runs start "Break down and execute this goal"'] });
		}
		const maxSteps = maxStepsRaw ? ensureInt(maxStepsRaw, { name: "--max-steps", min: 1, max: 500 }) : 20;
		if (maxSteps == null) {
			return jsonError("--max-steps must be an integer between 1 and 500", {
				pretty,
				recovery: ['mu runs start "Ship release" --max-steps 25'],
			});
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/control-plane/runs/start",
			body: {
				prompt,
				max_steps: maxSteps,
			},
			recoveryCommand: `mu runs start ${JSON.stringify(prompt)}`,
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderRunPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function runsResume(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu runs resume - queue a resume for a root issue",
					"",
					"Usage:",
					"  mu runs resume <root-id> [--max-steps N] [--json] [--pretty]",
					"",
					"Options:",
					"  --max-steps <N>   DAG step budget (default: 20, max: 500)",
					"",
					"Examples:",
					"  mu runs resume <root-id>",
					"  mu runs resume <root-id> --max-steps 30 --json --pretty",
				].join("\n") + "\n",
			);
		}
		if (argv.length === 0) {
			return jsonError("missing root issue id", { pretty, recovery: ["mu runs resume <root-id>"] });
		}
		const rootIssueId = argv[0]!;
		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
		const { present: compact, rest: argv1 } = popFlag(argv0, "--compact");
		const { value: maxStepsRaw, rest } = getFlagValue(argv1, "--max-steps");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu runs resume --help"] });
		}
		const maxSteps = maxStepsRaw ? ensureInt(maxStepsRaw, { name: "--max-steps", min: 1, max: 500 }) : 20;
		if (maxSteps == null) {
			return jsonError("--max-steps must be an integer between 1 and 500", {
				pretty,
				recovery: [`mu runs resume ${rootIssueId} --max-steps 25`],
			});
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/control-plane/runs/resume",
			body: {
				root_issue_id: rootIssueId,
				max_steps: maxSteps,
			},
			recoveryCommand: `mu runs resume ${rootIssueId}`,
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderRunPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function runsInterrupt(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu runs interrupt - interrupt an active run",
					"",
					"Usage:",
					"  mu runs interrupt <root-id> [--json] [--pretty]",
					"  mu runs interrupt --job-id <job-id> [--json] [--pretty]",
					"  mu runs interrupt --root-issue-id <root-id> [--json] [--pretty]",
					"",
					"Notes:",
					"  Provide either root issue id or job id.",
					"",
					"Examples:",
					"  mu runs interrupt <root-id>",
					"  mu runs interrupt --job-id run-abc123 --json --pretty",
				].join("\n") + "\n",
			);
		}
		let positionalRoot: string | null = null;
		let args = argv;
		if (args[0] && !args[0].startsWith("-")) {
			positionalRoot = args[0];
			args = args.slice(1);
		}
		const { value: rootIssueIdFlag, rest: argv0 } = getFlagValue(args, "--root-issue-id");
		const { value: jobId, rest: argv1 } = getFlagValue(argv0, "--job-id");
		const { present: jsonMode, rest: argv2 } = popFlag(argv1, "--json");
		const { present: compact, rest } = popFlag(argv2, "--compact");
		const rootIssueId = rootIssueIdFlag ?? positionalRoot;
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu runs interrupt --help"] });
		}
		if (!rootIssueId && !jobId) {
			return jsonError("missing target: pass <root-id> or --job-id", {
				pretty,
				recovery: ["mu runs interrupt <root-id>", "mu runs interrupt --job-id <job-id>"],
			});
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/control-plane/runs/interrupt",
			body: {
				root_issue_id: rootIssueId,
				job_id: jobId ?? null,
			},
			recoveryCommand: rootIssueId ? `mu runs interrupt ${rootIssueId}` : "mu runs interrupt --job-id <job-id>",
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderRunPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function cmdHeartbeats(argv: string[], ctx: Ctx): Promise<SchedulingCommandRunResult> {
		const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
		if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
			return ok(
				[
					"mu heartbeats - heartbeat program lifecycle (periodic operator wake)",
					"",
					"Usage:",
					"  mu heartbeats <list|get|create|update|delete|trigger|enable|disable> [args...] [--pretty]",
					"",
					"Commands:",
					"  list      List heartbeat programs",
					"  get       Show a single heartbeat program",
					"  create    Create a heartbeat program",
					"  update    Update title/prompt/every-ms/reason/enabled",
					"  delete    Delete a heartbeat program",
					"  trigger   Trigger a heartbeat immediately",
					"  enable    Enable a heartbeat program",
					"  disable   Disable a heartbeat program",
					"",
					"Output mode:",
					"  list/get are compact by default; add --json for full records.",
					"  create/update/delete/trigger/enable/disable return structured JSON.",
					"",
					"Telegram quick setup:",
					"  1) Check control-plane + adapter config",
					"       mu control status",
					"  2) Link your Telegram identity",
					"       mu control link --channel telegram --actor-id <chat-id> --tenant-id bot",
					"  3) Create heartbeat",
					"       mu heartbeats create --title \"Telegram heartbeat\" --prompt \"Review open issues and post next actions\" --every-ms 300000 --reason telegram_heartbeat",
					"  4) Validate + smoke test",
					"       mu heartbeats list --limit 20",
					"       mu heartbeats trigger <program-id> --reason smoke_test",
					"",
					"Run `mu heartbeats <subcommand> --help` for command-specific options + examples.",
				].join("\n") + "\n",
			);
		}

		const sub = argv0[0]!;
		const rest = argv0.slice(1);
		switch (sub) {
			case "list":
				return await heartbeatsList(rest, ctx, pretty);
			case "get":
				return await heartbeatsGet(rest, ctx, pretty);
			case "create":
				return await heartbeatsCreate(rest, ctx, pretty);
			case "update":
				return await heartbeatsUpdate(rest, ctx, pretty);
			case "delete":
				return await heartbeatsDelete(rest, ctx, pretty);
			case "trigger":
				return await heartbeatsTrigger(rest, ctx, pretty);
			case "enable":
				return await heartbeatsEnableDisable(rest, ctx, pretty, true);
			case "disable":
				return await heartbeatsEnableDisable(rest, ctx, pretty, false);
			default:
				return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu heartbeats --help"] });
		}
	}

	async function heartbeatsList(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu heartbeats list - list heartbeat programs",
					"",
					"Usage:",
					"  mu heartbeats list [--enabled true|false] [--limit N] [--json] [--pretty]",
					"",
					"Examples:",
					"  mu heartbeats list",
					"  mu heartbeats list --enabled true --limit 20",
					"  mu heartbeats list --json --pretty",
				].join("\n") + "\n",
			);
		}
		const { value: enabledRaw, rest: argv0 } = getFlagValue(argv, "--enabled");
		const { value: limitRaw, rest: argv1 } = getFlagValue(argv0, "--limit");
		const { present: jsonMode, rest: argv2 } = popFlag(argv1, "--json");
		const { present: compact, rest } = popFlag(argv2, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu heartbeats --help"] });
		}
		const enabled = parseOptionalBoolean(enabledRaw);
		if (enabledRaw && enabled == null) {
			return jsonError("--enabled must be true or false", {
				pretty,
				recovery: ["mu heartbeats list --enabled true"],
			});
		}
		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 20;
		if (limit == null) {
			return jsonError("--limit must be an integer between 1 and 500", {
				pretty,
				recovery: ["mu heartbeats list --limit 20"],
			});
		}
		const search = new URLSearchParams();
		if (enabled != null) {
			search.set("enabled", String(enabled));
		}
		search.set("limit", String(limit));
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: `/api/heartbeats?${search.toString()}`,
			recoveryCommand: "mu heartbeats list",
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderHeartbeatsPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function heartbeatsGet(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu heartbeats get - show one heartbeat program",
					"",
					"Usage:",
					"  mu heartbeats get <program-id> [--json] [--pretty]",
					"",
					"Examples:",
					"  mu heartbeats get hb-123",
					"  mu heartbeats get hb-123 --json --pretty",
				].join("\n") + "\n",
			);
		}
		if (argv.length === 0) {
			return jsonError("missing program id", { pretty, recovery: ["mu heartbeats get <program-id>"] });
		}
		const id = argv[0]!;
		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu heartbeats get --help"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: `/api/heartbeats/${encodeURIComponent(id)}`,
			recoveryCommand: `mu heartbeats get ${id}`,
		});
		if (!req.ok) {
			return req.result;
		}
		if (!jsonMode || compact) {
			return ok(renderHeartbeatsPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function heartbeatsCreate(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu heartbeats create - create a heartbeat program",
					"",
					"Usage:",
					"  mu heartbeats create [--title <text>] [--prompt <text>] [--every-ms N] [--reason <text>] [--enabled true|false] [--pretty]",
					"  mu heartbeats create <title> [--prompt <text>] [--every-ms N] [--reason <text>] [--enabled true|false] [--pretty]",
					"",
					"Notes:",
					"  - --prompt is an optional free-form operator instruction (can be multi-line).",
					"  - every-ms omitted: defaults to 15000ms.",
					"  - every-ms 0: event-driven heartbeat (no periodic timer).",
					"  - Heartbeats wake operator; delivery depends on linked channel identities.",
					"",
					"Examples:",
					"  mu heartbeats create --title \"Run heartbeat\" --prompt \"Check for stuck runs and recover\" --every-ms 15000 --reason run_watchdog",
					"  mu heartbeats create --title \"Telegram heartbeat\" --prompt \"Review open issues and post next actions\" --every-ms 300000 --reason telegram_heartbeat",
					"",
					"Telegram prerequisites:",
					"  mu control status",
					"  mu control link --channel telegram --actor-id <chat-id> --tenant-id bot",
				].join("\n") + "\n",
			);
		}
		let positionalTitle: string | null = null;
		let args = argv;
		if (args[0] && !args[0].startsWith("-")) {
			positionalTitle = args[0];
			args = args.slice(1);
		}
		const { value: titleFlag, rest: argv0 } = getFlagValue(args, "--title");
		const title = titleFlag ?? positionalTitle;
		if (!title) {
			return jsonError("missing title", {
				pretty,
				recovery: ['mu heartbeats create --title "Wake heartbeat" --every-ms 15000'],
			});
		}
		const { value: promptRaw, rest: argv1 } = getFlagValue(argv0, "--prompt");
		const { value: everyMsRaw, rest: argv2 } = getFlagValue(argv1, "--every-ms");
		const { value: reason, rest: argv3 } = getFlagValue(argv2, "--reason");
		const { value: enabledRaw, rest } = getFlagValue(argv3, "--enabled");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu heartbeats create --help"] });
		}
		const everyMs = everyMsRaw ? ensureInt(everyMsRaw, { name: "--every-ms", min: 0 }) : null;
		if (everyMsRaw && everyMs == null) {
			return jsonError("--every-ms must be an integer >= 0", {
				pretty,
				recovery: ["mu heartbeats create --every-ms 15000"],
			});
		}
		const enabled = parseOptionalBoolean(enabledRaw);
		if (enabledRaw && enabled == null) {
			return jsonError("--enabled must be true or false", {
				pretty,
				recovery: ["mu heartbeats create --enabled true"],
			});
		}
		const prompt =
			promptRaw == null ? undefined : promptRaw.trim().length === 0 ? null : promptRaw;
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/heartbeats/create",
			body: {
				title,
				prompt,
				every_ms: everyMs,
				reason: reason ?? null,
				enabled,
			},
			recoveryCommand: "mu heartbeats create --title <title> --every-ms 15000",
		});
		if (!req.ok) {
			return req.result;
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function heartbeatsUpdate(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu heartbeats update - update a heartbeat program",
					"",
					"Usage:",
					"  mu heartbeats update <program-id> [--title <text>] [--prompt <text>] [--every-ms N] [--reason <text>] [--enabled true|false] [--pretty]",
					"  mu heartbeats update --program-id <id> [--title <text>] [--prompt <text>] [--every-ms N] [--reason <text>] [--enabled true|false]",
					"",
					"Examples:",
					"  mu heartbeats update hb-123 --every-ms 600000",
					"  mu heartbeats update hb-123 --prompt \"Re-plan from current blockers and act\"",
					"  mu heartbeats update --program-id hb-123 --enabled false",
				].join("\n") + "\n",
			);
		}
		let positionalProgramId: string | null = null;
		let args = argv;
		if (args[0] && !args[0].startsWith("-")) {
			positionalProgramId = args[0];
			args = args.slice(1);
		}
		const { value: programIdFlag, rest: argv0 } = getFlagValue(args, "--program-id");
		const programId = programIdFlag ?? positionalProgramId;
		if (!programId) {
			return jsonError("missing program id", { pretty, recovery: ["mu heartbeats update --program-id <id>"] });
		}
		const { value: title, rest: argv1 } = getFlagValue(argv0, "--title");
		const { value: promptRaw, rest: argv2 } = getFlagValue(argv1, "--prompt");
		const { value: everyMsRaw, rest: argv3 } = getFlagValue(argv2, "--every-ms");
		const { value: reason, rest: argv4 } = getFlagValue(argv3, "--reason");
		const { value: enabledRaw, rest } = getFlagValue(argv4, "--enabled");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu heartbeats update --help"] });
		}
		const everyMs = everyMsRaw ? ensureInt(everyMsRaw, { name: "--every-ms", min: 0 }) : null;
		if (everyMsRaw && everyMs == null) {
			return jsonError("--every-ms must be an integer >= 0", {
				pretty,
				recovery: ["mu heartbeats update --every-ms 15000"],
			});
		}
		const enabled = parseOptionalBoolean(enabledRaw);
		if (enabledRaw && enabled == null) {
			return jsonError("--enabled must be true or false", {
				pretty,
				recovery: ["mu heartbeats update --enabled false"],
			});
		}
		const body: Record<string, unknown> = {
			program_id: programId,
		};
		if (title != null) body.title = title;
		if (promptRaw != null) body.prompt = promptRaw.trim().length === 0 ? null : promptRaw;
		if (everyMs != null) body.every_ms = everyMs;
		if (reason != null) body.reason = reason;
		if (enabled != null) body.enabled = enabled;
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/heartbeats/update",
			body,
			recoveryCommand: `mu heartbeats update --program-id ${programId}`,
		});
		if (!req.ok) {
			return req.result;
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function heartbeatsDelete(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu heartbeats delete - delete a heartbeat program",
					"",
					"Usage:",
					"  mu heartbeats delete <program-id> [--pretty]",
					"",
					"Example:",
					"  mu heartbeats delete hb-123",
				].join("\n") + "\n",
			);
		}
		const programId = argv[0];
		if (!programId) {
			return jsonError("missing program id", { pretty, recovery: ["mu heartbeats delete <program-id>"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/heartbeats/delete",
			body: { program_id: programId },
			recoveryCommand: `mu heartbeats delete ${programId}`,
		});
		if (!req.ok) {
			return req.result;
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function heartbeatsTrigger(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu heartbeats trigger - trigger a heartbeat now",
					"",
					"Usage:",
					"  mu heartbeats trigger <program-id> [--reason <text>] [--pretty]",
					"",
					"Examples:",
					"  mu heartbeats trigger hb-123",
					"  mu heartbeats trigger hb-123 --reason smoke_test",
				].join("\n") + "\n",
			);
		}
		const programId = argv[0];
		if (!programId) {
			return jsonError("missing program id", { pretty, recovery: ["mu heartbeats trigger <program-id>"] });
		}
		const { value: reason, rest } = getFlagValue(argv.slice(1), "--reason");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu heartbeats trigger --help"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/heartbeats/trigger",
			body: { program_id: programId, reason: reason ?? null },
			recoveryCommand: `mu heartbeats trigger ${programId}`,
		});
		if (!req.ok) {
			return req.result;
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function heartbeatsEnableDisable(
		argv: string[],
		ctx: Ctx,
		pretty: boolean,
		enabled: boolean,
	): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			const action = enabled ? "enable" : "disable";
			return ok(
				[
					`mu heartbeats ${action} - ${action} a heartbeat program`,
					"",
					"Usage:",
					`  mu heartbeats ${action} <program-id> [--pretty]`,
					"",
					"Example:",
					`  mu heartbeats ${action} hb-123`,
				].join("\n") + "\n",
			);
		}
		const programId = argv[0];
		if (!programId) {
			return jsonError("missing program id", {
				pretty,
				recovery: [enabled ? "mu heartbeats enable <program-id>" : "mu heartbeats disable <program-id>"],
			});
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/heartbeats/update",
			body: { program_id: programId, enabled },
			recoveryCommand: enabled ? `mu heartbeats enable ${programId}` : `mu heartbeats disable ${programId}`,
		});
		if (!req.ok) {
			return req.result;
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function cmdCron(argv: string[], ctx: Ctx): Promise<SchedulingCommandRunResult> {
		const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
		if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
			return ok(
				[
					"mu cron - cron program lifecycle",
					"",
					"Usage:",
					"  mu cron <stats|list|get|create|update|delete|trigger|enable|disable> [args...] [--pretty]",
					"",
					"Commands:",
					"  stats     Show scheduler summary",
					"  list      List cron programs",
					"  get       Show one cron program",
					"  create    Create cron program",
					"  update    Update cron program",
					"  delete    Delete cron program",
					"  trigger   Trigger cron program immediately",
					"  enable    Enable cron program",
					"  disable   Disable cron program",
					"",
					"Output mode:",
					"  stats/list/get are compact by default; add --json for full records.",
					"  create/update/delete/trigger/enable/disable return structured JSON.",
					"",
					"Examples:",
					"  mu cron stats",
					"  mu cron list --enabled true --limit 20",
					"  mu cron create --title \"Nightly audit\" --schedule-kind cron --expr \"0 2 * * *\" --tz UTC",
					"  mu cron trigger <program-id> --reason smoke_test",
					"",
					"Run `mu cron <subcommand> --help` for command-specific usage.",
				].join("\n") + "\n",
			);
		}
		const sub = argv0[0]!;
		const rest = argv0.slice(1);
		switch (sub) {
			case "stats":
				return await cronStats(rest, ctx, pretty);
			case "list":
				return await cronList(rest, ctx, pretty);
			case "get":
				return await cronGet(rest, ctx, pretty);
			case "create":
				return await cronCreate(rest, ctx, pretty);
			case "update":
				return await cronUpdate(rest, ctx, pretty);
			case "delete":
				return await cronDelete(rest, ctx, pretty);
			case "trigger":
				return await cronTrigger(rest, ctx, pretty);
			case "enable":
				return await cronEnableDisable(rest, ctx, pretty, true);
			case "disable":
				return await cronEnableDisable(rest, ctx, pretty, false);
			default:
				return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu cron --help"] });
		}
	}

	async function cronStats(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu cron stats - show cron scheduler summary",
					"",
					"Usage:",
					"  mu cron stats [--json] [--pretty]",
					"",
					"Examples:",
					"  mu cron stats",
					"  mu cron stats --json --pretty",
				].join("\n") + "\n",
			);
		}
		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu cron stats"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: "/api/cron/status",
			recoveryCommand: "mu cron stats",
		});
		if (!req.ok) return req.result;
		if (!jsonMode || compact) {
			return ok(renderCronPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function cronList(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu cron list - list cron programs",
					"",
					"Usage:",
					"  mu cron list [--enabled true|false] [--schedule-kind KIND] [--limit N] [--json] [--pretty]",
					"",
					"Examples:",
					"  mu cron list",
					"  mu cron list --enabled true --limit 20",
					"  mu cron list --schedule-kind cron --json --pretty",
				].join("\n") + "\n",
			);
		}
		const { value: enabledRaw, rest: argv0 } = getFlagValue(argv, "--enabled");
		const { value: scheduleKind, rest: argv1 } = getFlagValue(argv0, "--schedule-kind");
		const { value: limitRaw, rest: argv2 } = getFlagValue(argv1, "--limit");
		const { present: jsonMode, rest: argv3 } = popFlag(argv2, "--json");
		const { present: compact, rest } = popFlag(argv3, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu cron --help"] });
		}
		const enabled = parseOptionalBoolean(enabledRaw);
		if (enabledRaw && enabled == null) {
			return jsonError("--enabled must be true or false", { pretty, recovery: ["mu cron list --enabled true"] });
		}
		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 20;
		if (limit == null) {
			return jsonError("--limit must be an integer between 1 and 500", {
				pretty,
				recovery: ["mu cron list --limit 20"],
			});
		}
		const search = new URLSearchParams();
		if (enabled != null) search.set("enabled", String(enabled));
		setSearchParamIfPresent(search, "schedule_kind", scheduleKind ?? null);
		search.set("limit", String(limit));
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: `/api/cron?${search.toString()}`,
			recoveryCommand: "mu cron list",
		});
		if (!req.ok) return req.result;
		if (!jsonMode || compact) {
			return ok(renderCronPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	async function cronGet(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu cron get - show one cron program",
					"",
					"Usage:",
					"  mu cron get <program-id> [--json] [--pretty]",
					"",
					"Examples:",
					"  mu cron get cron-123",
					"  mu cron get cron-123 --json --pretty",
				].join("\n") + "\n",
			);
		}
		const programId = argv[0];
		if (!programId) {
			return jsonError("missing program id", { pretty, recovery: ["mu cron get <program-id>"] });
		}
		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu cron get --help"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			path: `/api/cron/${encodeURIComponent(programId)}`,
			recoveryCommand: `mu cron get ${programId}`,
		});
		if (!req.ok) return req.result;
		if (!jsonMode || compact) {
			return ok(renderCronPayloadCompact(req.payload));
		}
		return ok(jsonText(req.payload, pretty));
	}

	function parseCronScheduleFlags(
		argv: string[],
		pretty: boolean,
	): {
		schedule: Record<string, unknown> | null;
		rest: string[];
		error: SchedulingCommandRunResult | null;
	} {
		const { value: scheduleKind, rest: argv0 } = getFlagValue(argv, "--schedule-kind");
		const { value: atMsRaw, rest: argv1 } = getFlagValue(argv0, "--at-ms");
		const { value: at, rest: argv2 } = getFlagValue(argv1, "--at");
		const { value: everyMsRaw, rest: argv3 } = getFlagValue(argv2, "--every-ms");
		const { value: anchorMsRaw, rest: argv4 } = getFlagValue(argv3, "--anchor-ms");
		const { value: expr, rest: argv5 } = getFlagValue(argv4, "--expr");
		const { value: tz, rest } = getFlagValue(argv5, "--tz");

		if (!scheduleKind && !atMsRaw && !at && !everyMsRaw && !anchorMsRaw && !expr && !tz) {
			return { schedule: null, rest, error: null };
		}

		const atMs = atMsRaw ? ensureInt(atMsRaw, { name: "--at-ms", min: 0 }) : null;
		if (atMsRaw && atMs == null) {
			return {
				schedule: null,
				rest,
				error: jsonError("--at-ms must be an integer >= 0", {
					pretty,
					recovery: ["mu cron create --at-ms <epoch-ms>"],
				}),
			};
		}
		const everyMs = everyMsRaw ? ensureInt(everyMsRaw, { name: "--every-ms", min: 1 }) : null;
		if (everyMsRaw && everyMs == null) {
			return {
				schedule: null,
				rest,
				error: jsonError("--every-ms must be an integer >= 1", {
					pretty,
					recovery: ["mu cron create --schedule-kind every --every-ms 60000"],
				}),
			};
		}
		const anchorMs = anchorMsRaw ? ensureInt(anchorMsRaw, { name: "--anchor-ms", min: 0 }) : null;
		if (anchorMsRaw && anchorMs == null) {
			return {
				schedule: null,
				rest,
				error: jsonError("--anchor-ms must be an integer >= 0", {
					pretty,
					recovery: ["mu cron create --anchor-ms <epoch-ms>"],
				}),
			};
		}

		return {
			schedule: {
				kind: scheduleKind ?? null,
				at_ms: atMs,
				at: at ?? null,
				every_ms: everyMs,
				anchor_ms: anchorMs,
				expr: expr ?? null,
				tz: tz ?? null,
			},
			rest,
			error: null,
		};
	}

	async function cronCreate(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu cron create - create a cron program",
					"",
					"Usage:",
					"  mu cron create [--title <text>] [schedule flags] [--reason <text>] [--enabled true|false] [--pretty]",
					"  mu cron create <title> [schedule flags] [--reason <text>] [--enabled true|false] [--pretty]",
					"",
					"Schedule flags:",
					"  --schedule-kind <at|every|cron>",
					"  --at-ms <epoch-ms> | --at <iso8601>",
					"  --every-ms <ms> [--anchor-ms <epoch-ms>]",
					"  --expr <cron-expr> [--tz <timezone>]",
					"",
					"Examples:",
					"  mu cron create --title \"One-shot audit\" --schedule-kind at --at 2026-02-22T02:00:00Z",
					"  mu cron create --title \"Every 10m\" --schedule-kind every --every-ms 600000",
					"  mu cron create --title \"Nightly\" --schedule-kind cron --expr \"0 2 * * *\" --tz UTC",
				].join("\n") + "\n",
			);
		}
		let positionalTitle: string | null = null;
		let args = argv;
		if (args[0] && !args[0].startsWith("-")) {
			positionalTitle = args[0];
			args = args.slice(1);
		}
		const { value: titleFlag, rest: argv0 } = getFlagValue(args, "--title");
		const title = titleFlag ?? positionalTitle;
		if (!title) {
			return jsonError("missing title", {
				pretty,
				recovery: ['mu cron create --title "Nightly wake" --schedule-kind cron --expr "0 2 * * *" --tz UTC'],
			});
		}
		const scheduleParsed = parseCronScheduleFlags(argv0, pretty);
		if (scheduleParsed.error) return scheduleParsed.error;
		if (!scheduleParsed.schedule) {
			return jsonError("missing schedule (--schedule-kind/--expr/--at/--every-ms)", {
				pretty,
				recovery: ["mu cron create --schedule-kind cron --expr '0 2 * * *' --tz UTC"],
			});
		}
		const { value: reason, rest: argv1 } = getFlagValue(scheduleParsed.rest, "--reason");
		const { value: enabledRaw, rest } = getFlagValue(argv1, "--enabled");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu cron create --help"] });
		}
		const enabled = parseOptionalBoolean(enabledRaw);
		if (enabledRaw && enabled == null) {
			return jsonError("--enabled must be true or false", { pretty, recovery: ["mu cron create --enabled true"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/cron/create",
			body: {
				title,
				...scheduleParsed.schedule,
				reason: reason ?? null,
				enabled,
			},
			recoveryCommand: "mu cron create --title <title> --schedule-kind cron --expr '0 2 * * *'",
		});
		if (!req.ok) return req.result;
		return ok(jsonText(req.payload, pretty));
	}

	async function cronUpdate(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu cron update - update a cron program",
					"",
					"Usage:",
					"  mu cron update <program-id> [--title <text>] [schedule flags] [--reason <text>] [--enabled true|false] [--pretty]",
					"  mu cron update --program-id <id> [--title <text>] [schedule flags] [--reason <text>] [--enabled true|false] [--pretty]",
					"",
					"Schedule flags:",
					"  --schedule-kind <at|every|cron>",
					"  --at-ms <epoch-ms> | --at <iso8601>",
					"  --every-ms <ms> [--anchor-ms <epoch-ms>]",
					"  --expr <cron-expr> [--tz <timezone>]",
					"",
					"Examples:",
					"  mu cron update cron-123 --enabled false",
					"  mu cron update cron-123 --schedule-kind every --every-ms 300000",
					"  mu cron update --program-id cron-123 --schedule-kind cron --expr \"0 3 * * *\" --tz UTC",
				].join("\n") + "\n",
			);
		}
		let positionalProgramId: string | null = null;
		let args = argv;
		if (args[0] && !args[0].startsWith("-")) {
			positionalProgramId = args[0];
			args = args.slice(1);
		}
		const { value: programIdFlag, rest: argv0 } = getFlagValue(args, "--program-id");
		const programId = programIdFlag ?? positionalProgramId;
		if (!programId) {
			return jsonError("missing program id", { pretty, recovery: ["mu cron update --program-id <id>"] });
		}
		const { value: title, rest: argv1 } = getFlagValue(argv0, "--title");
		const scheduleParsed = parseCronScheduleFlags(argv1, pretty);
		if (scheduleParsed.error) return scheduleParsed.error;
		const { value: reason, rest: argv2 } = getFlagValue(scheduleParsed.rest, "--reason");
		const { value: enabledRaw, rest } = getFlagValue(argv2, "--enabled");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu cron update --help"] });
		}
		const enabled = parseOptionalBoolean(enabledRaw);
		if (enabledRaw && enabled == null) {
			return jsonError("--enabled must be true or false", { pretty, recovery: ["mu cron update --enabled false"] });
		}
		const body: Record<string, unknown> = { program_id: programId };
		if (title != null) body.title = title;
		if (scheduleParsed.schedule != null) Object.assign(body, scheduleParsed.schedule);
		if (reason != null) body.reason = reason;
		if (enabled != null) body.enabled = enabled;

		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/cron/update",
			body,
			recoveryCommand: `mu cron update --program-id ${programId}`,
		});
		if (!req.ok) return req.result;
		return ok(jsonText(req.payload, pretty));
	}

	async function cronDelete(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu cron delete - delete a cron program",
					"",
					"Usage:",
					"  mu cron delete <program-id> [--pretty]",
					"",
					"Example:",
					"  mu cron delete cron-123",
				].join("\n") + "\n",
			);
		}
		const programId = argv[0];
		if (!programId) {
			return jsonError("missing program id", { pretty, recovery: ["mu cron delete <program-id>"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/cron/delete",
			body: { program_id: programId },
			recoveryCommand: `mu cron delete ${programId}`,
		});
		if (!req.ok) return req.result;
		return ok(jsonText(req.payload, pretty));
	}

	async function cronTrigger(argv: string[], ctx: Ctx, pretty: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu cron trigger - trigger a cron program immediately",
					"",
					"Usage:",
					"  mu cron trigger <program-id> [--reason <text>] [--pretty]",
					"",
					"Examples:",
					"  mu cron trigger cron-123",
					"  mu cron trigger cron-123 --reason smoke_test",
				].join("\n") + "\n",
			);
		}
		const programId = argv[0];
		if (!programId) {
			return jsonError("missing program id", { pretty, recovery: ["mu cron trigger <program-id>"] });
		}
		const { value: reason, rest } = getFlagValue(argv.slice(1), "--reason");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu cron trigger --help"] });
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/cron/trigger",
			body: { program_id: programId, reason: reason ?? null },
			recoveryCommand: `mu cron trigger ${programId}`,
		});
		if (!req.ok) return req.result;
		return ok(jsonText(req.payload, pretty));
	}

	async function cronEnableDisable(argv: string[], ctx: Ctx, pretty: boolean, enabled: boolean): Promise<SchedulingCommandRunResult> {
		if (hasHelpFlag(argv)) {
			const action = enabled ? "enable" : "disable";
			return ok(
				[
					`mu cron ${action} - ${action} a cron program`,
					"",
					"Usage:",
					`  mu cron ${action} <program-id> [--pretty]`,
					"",
					"Example:",
					`  mu cron ${action} cron-123`,
				].join("\n") + "\n",
			);
		}
		const programId = argv[0];
		if (!programId) {
			return jsonError("missing program id", {
				pretty,
				recovery: [enabled ? "mu cron enable <program-id>" : "mu cron disable <program-id>"],
			});
		}
		const req = await requestServerJson<Record<string, unknown>>({
			ctx,
			pretty,
			method: "POST",
			path: "/api/cron/update",
			body: { program_id: programId, enabled },
			recoveryCommand: enabled ? `mu cron enable ${programId}` : `mu cron disable ${programId}`,
		});
		if (!req.ok) return req.result;
		return ok(jsonText(req.payload, pretty));
	}


	return { cmdRuns, cmdHeartbeats, cmdCron };
}

export async function cmdRuns<Ctx>(
	argv: string[],
	ctx: Ctx,
	deps: SchedulingCommandDeps<Ctx>,
): Promise<SchedulingCommandRunResult> {
	return await buildSchedulingHandlers(deps).cmdRuns(argv, ctx);
}

export async function cmdHeartbeats<Ctx>(
	argv: string[],
	ctx: Ctx,
	deps: SchedulingCommandDeps<Ctx>,
): Promise<SchedulingCommandRunResult> {
	return await buildSchedulingHandlers(deps).cmdHeartbeats(argv, ctx);
}

export async function cmdCron<Ctx>(
	argv: string[],
	ctx: Ctx,
	deps: SchedulingCommandDeps<Ctx>,
): Promise<SchedulingCommandRunResult> {
	return await buildSchedulingHandlers(deps).cmdCron(argv, ctx);
}
