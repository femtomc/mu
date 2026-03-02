import type { Issue } from "@femtomc/mu-core";
import { getStorePaths, readJsonl } from "@femtomc/mu-core/node";
import type { IssueStore } from "@femtomc/mu-issue";
import { join } from "node:path";

export type IssueCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type IssueCommandCtx = {
	store: IssueStore;
	repoRoot?: string;
};

export type IssueCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	getRepeatFlagValues: (argv: readonly string[], names: readonly string[]) => { values: string[]; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => IssueCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => IssueCommandRunResult;
	resolveIssueId: (
		store: IssueStore,
		rawId: string,
	) => Promise<{ issueId: string | null; error: string | null }>;
	issueJson: (issue: Issue) => Record<string, unknown>;
	renderIssueCompactTable: (issues: readonly Issue[]) => string;
	renderIssueDetailCompact: (issue: Issue) => string;
	renderIssueMutationCompact: (
		action: "created" | "updated" | "claimed" | "opened" | "closed",
		issue: Issue,
		opts?: { fields?: readonly string[] },
	) => string;
	renderIssueDepMutationCompact: (
		action: "added" | "removed",
		dep: { src: string; type: string; dst: string; ok?: boolean },
	) => string;
};

const HEARTBEAT_MANAGED_OVERRIDE_FLAG = "--allow-heartbeat-managed";
const HEARTBEAT_ROOT_PROMPT_RE = /\broot\s*:\s*(mu-[a-z0-9]+)/gi;
const HEARTBEAT_ROOT_METADATA_KEYS = [
	"root_issue_id",
	"root_id",
	"rootIssueId",
	"rootId",
	"managed_root_id",
	"managed_root_ids",
	"managedRootId",
	"managedRootIds",
] as const;

type HeartbeatOwnershipProgram = {
	programId: string;
	rootId: string;
};

type HeartbeatOwnershipViolation = {
	issueId: string;
	rootId: string;
	programId: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeIssueId(value: string): string | null {
	const normalized = value.trim();
	if (!/^mu-[a-z0-9]+$/i.test(normalized)) {
		return null;
	}
	return normalized;
}

function rootIdsFromUnknown(value: unknown): string[] {
	if (typeof value === "string") {
		const normalized = normalizeIssueId(value);
		return normalized ? [normalized] : [];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const entry of value) {
		const normalized = typeof entry === "string" ? normalizeIssueId(entry) : null;
		if (normalized) {
			out.push(normalized);
		}
	}
	return out;
}

function rootIdsFromPrompt(prompt: string | null): string[] {
	if (!prompt) {
		return [];
	}
	const out: string[] = [];
	for (const match of prompt.matchAll(HEARTBEAT_ROOT_PROMPT_RE)) {
		const rootIdRaw = typeof match[1] === "string" ? match[1] : "";
		const normalized = normalizeIssueId(rootIdRaw);
		if (normalized) {
			out.push(normalized);
		}
	}
	return out;
}

async function readHeartbeatOwnershipPrograms(repoRoot: string): Promise<HeartbeatOwnershipProgram[]> {
	const heartbeatsPath = join(getStorePaths(repoRoot).storeDir, "heartbeats.jsonl");
	const rows = await readJsonl(heartbeatsPath).catch(() => [] as unknown[]);
	const out: HeartbeatOwnershipProgram[] = [];
	for (const rowRaw of rows) {
		const row = asRecord(rowRaw);
		if (!row || row.enabled === false) {
			continue;
		}
		const programId = nonEmptyString(row.program_id);
		if (!programId) {
			continue;
		}
		const metadata = asRecord(row.metadata);
		const rootIds = new Set<string>();
		if (metadata) {
			for (const key of HEARTBEAT_ROOT_METADATA_KEYS) {
				for (const rootId of rootIdsFromUnknown(metadata[key])) {
					rootIds.add(rootId);
				}
			}
		}
		const prompt = nonEmptyString(row.prompt);
		for (const rootId of rootIdsFromPrompt(prompt)) {
			rootIds.add(rootId);
		}
		for (const rootId of rootIds) {
			out.push({ programId, rootId });
		}
	}
	return out;
}

function heartbeatOwnershipFromEnvironment(): { wakeSource: string | null; programId: string | null } {
	const wakeSource = nonEmptyString(process.env.MU_AUTONOMOUS_WAKE_SOURCE);
	const programId = nonEmptyString(process.env.MU_AUTONOMOUS_PROGRAM_ID);
	return {
		wakeSource,
		programId,
	};
}

async function heartbeatOwnershipViolations(opts: {
	ctx: IssueCommandCtx;
	issueIds: readonly string[];
}): Promise<HeartbeatOwnershipViolation[]> {
	if (!opts.ctx.repoRoot) {
		return [];
	}
	const programs = await readHeartbeatOwnershipPrograms(opts.ctx.repoRoot);
	if (programs.length === 0) {
		return [];
	}
	const uniqueIssueIds = [...new Set(opts.issueIds.map((id) => id.trim()).filter((id) => id.length > 0))];
	if (uniqueIssueIds.length === 0) {
		return [];
	}
	const owner = heartbeatOwnershipFromEnvironment();
	const subtreeCache = new Map<string, Set<string>>();
	const seen = new Set<string>();
	const violations: HeartbeatOwnershipViolation[] = [];
	for (const program of programs) {
		if (owner.wakeSource === "heartbeat_program" && owner.programId === program.programId) {
			continue;
		}
		let subtree = subtreeCache.get(program.rootId);
		if (!subtree) {
			const ids = await opts.ctx.store.subtree_ids(program.rootId).catch(() => [] as string[]);
			subtree = new Set(ids);
			subtreeCache.set(program.rootId, subtree);
		}
		for (const issueId of uniqueIssueIds) {
			if (!subtree.has(issueId)) {
				continue;
			}
			const key = `${issueId}\u0000${program.rootId}\u0000${program.programId}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			violations.push({ issueId, rootId: program.rootId, programId: program.programId });
		}
	}
	return violations;
}

async function maybeBlockHeartbeatManagedMutation(opts: {
	ctx: IssueCommandCtx;
	issueIds: readonly string[];
	allowOverride: boolean;
	pretty: boolean;
	recoveryCommand: string;
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => IssueCommandRunResult;
}): Promise<IssueCommandRunResult | null> {
	if (opts.allowOverride) {
		return null;
	}
	const violations = await heartbeatOwnershipViolations({
		ctx: opts.ctx,
		issueIds: opts.issueIds,
	});
	if (violations.length === 0) {
		return null;
	}
	const sample = violations.slice(0, 4).map((row) => `${row.issueId}=>${row.rootId}@${row.programId}`);
	const blockedPrograms = [...new Set(violations.map((row) => row.programId))];
	const recovery = [
		`${opts.recoveryCommand} ${HEARTBEAT_MANAGED_OVERRIDE_FLAG}`,
		...(blockedPrograms.length > 0 ? [`mu heartbeats disable ${blockedPrograms[0]}`] : []),
		"mu heartbeats list --enabled true --json --pretty",
	];
	return opts.jsonError(
		[
			"heartbeat-managed issue mutation blocked",
			`matches=${sample.join(",")}`,
			`blocked_programs=${blockedPrograms.join(",")}`,
			`override=${HEARTBEAT_MANAGED_OVERRIDE_FLAG}`,
		].join(": "),
		{
			pretty: opts.pretty,
			recovery,
		},
	);
}

function buildIssueHandlers<Ctx extends IssueCommandCtx>(deps: IssueCommandDeps): {
	cmdIssues: (argv: string[], ctx: Ctx) => Promise<IssueCommandRunResult>;
} {
	const {
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
	} = deps;

	async function cmdIssues(argv: string[], ctx: Ctx): Promise<IssueCommandRunResult> {
		const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

		if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
			return ok(
				[
					"mu issues - work item lifecycle commands (JSON + compact output)",
					"",
					"Usage:",
					"  mu issues <command> [args...] [--pretty]",
					"",
					"Commands:",
					"  list       Filtered listing (status/tag/root/limit)",
					"  get        Fetch a single issue by id or unique prefix",
					"  create     Create issue (auto-adds node:agent)",
					"  update     Patch title/body/status/outcome/priority/tags/role",
					"  claim      open -> in_progress",
					"  open       Reopen closed/in_progress issue and clear outcome",
					"  close      Close with outcome (default: success)",
					"  dep        Add dependency edge (<src> blocks <dst> or <child> parent <parent>)",
					"  undep      Remove dependency edge",
					"  children   List direct child issues",
					"  ready      Open + unblocked + leaf + node:agent queue",
					"  validate   Check whether a root DAG is terminal",
					"",
					"Output mode:",
					"  compact-by-default output for issue reads + mutations; add --json for full records.",
					"",
					"Operator flow (single issue):",
					"  mu issues ready --root <root-id>",
					"  mu issues claim <issue-id>",
					"  mu issues get <issue-id>",
					'  mu forum post issue:<issue-id> -m "started work" --author operator',
					"  mu issues close <issue-id> --outcome success",
					"",
					"Planning flow (issue DAG decomposition):",
					'  mu issues create "Root goal" --tag node:root',
					'  mu issues create "Implement parser" --parent <root-id>',
					"  mu issues dep <task-a> blocks <task-b>",
					"  mu issues ready --root <root-id>",
					"  mu issues validate <root-id>",
					"",
					"Dependency semantics:",
					"  A blocks B          => B cannot be ready until A is closed",
					"  child parent root   => parent-child tree edge",
					"",
					"Run `mu issues <command> --help` for command-specific options + examples.",
				].join("\n") + "\n",
			);
		}

		const sub = argv0[0]!;
		const rest = argv0.slice(1);

		switch (sub) {
			case "list":
				return await issuesList(rest, ctx, pretty);
			case "get":
				return await issuesGet(rest, ctx, pretty);
			case "create":
				return await issuesCreate(rest, ctx, pretty);
			case "update":
				return await issuesUpdate(rest, ctx, pretty);
			case "claim":
				return await issuesClaim(rest, ctx, pretty);
			case "open":
				return await issuesOpen(rest, ctx, pretty);
			case "close":
				return await issuesClose(rest, ctx, pretty);
			case "dep":
				return await issuesDep(rest, ctx, pretty);
			case "undep":
				return await issuesUndep(rest, ctx, pretty);
			case "children":
				return await issuesChildren(rest, ctx, pretty);
			case "ready":
				return await issuesReady(rest, ctx, pretty);
			case "validate":
				return await issuesValidate(rest, ctx, pretty);
			default:
				return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu issues --help"] });
		}
	}

	async function issuesList(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues list - list issues with optional filters",
					"",
					"Usage:",
					"  mu issues list [--status STATUS] [--tag TAG] [--root ID] [--limit N|--all] [--json] [--pretty]",
					"",
					"Filters:",
					"  --status <open|in_progress|closed>   Filter by status",
					"  --tag <TAG>                          Repeatable; issue must contain all tags",
					"  --root <id-or-prefix>                Restrict to a root issue subtree",
					"  --limit <N>                          Return newest N entries (default: 20, max: 500)",
					"  --all                                Return all matching rows (explicitly unbounded)",
					"  --json                               Emit full JSON rows (default is compact table)",
					"",
					"Examples:",
					"  mu issues list",
					"  mu issues list --status open --limit 20",
					"  mu issues list --root mu-abc123 --tag node:agent",
					"  mu issues list --status open --all --json --pretty",
				].join("\n") + "\n",
			);
		}

		const { value: statusRaw, rest: argv0 } = getFlagValue(argv, "--status");
		const { values: tags, rest: argv1 } = getRepeatFlagValues(argv0, ["--tag"]);
		const { value: rootRaw, rest: argv2 } = getFlagValue(argv1, "--root");
		const { present: jsonMode, rest: argv3 } = popFlag(argv2, "--json");
		const { present: compact, rest: argv4 } = popFlag(argv3, "--compact");
		const { value: limitRaw, rest: argv5 } = getFlagValue(argv4, "--limit");
		const { present: allRows, rest } = popFlag(argv5, "--all");

		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues list --help"] });
		}

		let statusFilter: Issue["status"] | null = null;
		if (statusRaw && statusRaw.length > 0) {
			if (statusRaw !== "open" && statusRaw !== "in_progress" && statusRaw !== "closed") {
				return jsonError(`invalid status: ${statusRaw}`, { pretty, recovery: ["mu issues list --help"] });
			}
			statusFilter = statusRaw;
		}

		let issues = await ctx.store.list({ status: statusFilter ?? undefined });
		if (tags.length > 0) {
			issues = issues.filter((i) => tags.every((t) => i.tags.includes(t)));
		}

		if (rootRaw) {
			const resolved = await resolveIssueId(ctx.store, rootRaw);
			if (resolved.error) {
				return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
			}
			const subtree = new Set(await ctx.store.subtree_ids(resolved.issueId!));
			issues = issues.filter((i) => subtree.has(i.id));
		}

		if (allRows && limitRaw != null) {
			return jsonError("cannot combine --all with --limit", {
				pretty,
				recovery: ["mu issues list --all", "mu issues list --limit 20"],
			});
		}

		const limit = allRows
			? null
			: limitRaw
				? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 })
				: 20;
		if (!allRows && limit == null) {
			return jsonError("--limit must be an integer between 1 and 500", {
				pretty,
				recovery: ["mu issues list --limit 20"],
			});
		}

		if (limit != null) {
			issues = issues.slice(-limit);
		}

		if (!jsonMode || compact) {
			return ok(renderIssueCompactTable(issues));
		}

		return ok(jsonText(issues.map(issueJson), pretty));
	}

	async function issuesGet(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues get - fetch a single issue",
					"",
					"Usage:",
					"  mu issues get <id-or-prefix> [--json] [--pretty]",
					"",
					"Notes:",
					"  Accepts full issue id or a unique prefix.",
					"  If prefix is ambiguous, mu returns candidate ids.",
					"  Default output is compact detail with body preview; use --json for full record/body.",
					"",
					"Examples:",
					"  mu issues get mu-459fd648",
					"  mu issues get mu-459f --json --pretty",
					"",
					"Troubleshooting:",
					"  mu issues list --limit 20",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues get --help"] });
		}

		const resolved = await resolveIssueId(ctx.store, argv[0]!);
		if (resolved.error) {
			return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
		}

		const issue = await ctx.store.get(resolved.issueId!);
		if (!issue) {
			return jsonError(`not found: ${argv[0]}`, { pretty, recovery: ["mu issues list --limit 20"] });
		}

		if (!jsonMode || compact) {
			return ok(renderIssueDetailCompact(issue));
		}

		return ok(jsonText(issueJson(issue), pretty));
	}

	async function issuesCreate(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues create - create a new issue (auto-adds node:agent tag)",
					"",
					"Usage:",
					"  mu issues create <title> [--body TEXT] [--parent ID] [--tag TAG] [--priority N] [--allow-heartbeat-managed] [--json] [--pretty]",
					"",
					"Options:",
					"  --body, -b <TEXT>                   Optional issue body",
					"  --parent <id-or-prefix>             Add <new-issue> parent <parent> edge",
					"  --tag, -t <TAG>                     Repeatable custom tags",
					"  --tags <CSV>                        Comma-separated custom tags",
					"  --priority, -p <1..5>               Priority (1 highest urgency, default 3)",
					"  --allow-heartbeat-managed           Override heartbeat ownership guardrails",
					"  --json                              Emit full JSON record (default is compact ack)",
					"  --pretty                            Pretty-print JSON result",
					"",
					"Examples:",
					'  mu issues create "Root planning issue" --tag node:root',
					'  mu issues create "Implement parser" --parent <root-id> --priority 2',
					'  mu issues create "Write tests" -b "Cover error paths" -t area:test --json --pretty',
				].join("\n") + "\n",
			);
		}

		const { present: allowHeartbeatManaged, rest: argvOwned } = popFlag(argv, HEARTBEAT_MANAGED_OVERRIDE_FLAG);
		const title = argvOwned[0];
		if (!title || title.startsWith("-")) {
			return jsonError("missing title", {
				pretty,
				recovery: ['mu issues create "Title" --body "Details"'],
			});
		}

		const { value: body, rest: argv0 } = getFlagValue(argvOwned.slice(1), "--body");
		const { value: bodyShort, rest: argv1 } = getFlagValue(argv0, "-b");
		const resolvedBody = body ?? bodyShort ?? "";

		const { value: parentRaw, rest: argv2 } = getFlagValue(argv1, "--parent");
		const { values: tags0, rest: argv3 } = getRepeatFlagValues(argv2, ["--tag", "-t"]);
		const { value: tagsCsvRaw, rest: argv4 } = getFlagValue(argv3, "--tags");
		const { value: priorityRaw, rest: argv5 } = getFlagValue(argv4, "--priority");
		const { value: priorityShortRaw, rest: argv6 } = getFlagValue(argv5, "-p");
		const { present: jsonMode, rest: argv7 } = popFlag(argv6, "--json");
		const { present: compact, rest: restFinal } = popFlag(argv7, "--compact");

		const priorityValue = priorityRaw ?? priorityShortRaw ?? "3";
		if (restFinal.length > 0) {
			return jsonError(`unknown args: ${restFinal.join(" ")}`, { pretty, recovery: ["mu issues create --help"] });
		}

		const priority = ensureInt(priorityValue, { name: "--priority", min: 1, max: 5 });
		if (priority == null) {
			return jsonError("priority must be in range 1-5", {
				pretty,
				recovery: ['mu issues create "Title" --priority 2'],
			});
		}

		const csvTags = (tagsCsvRaw ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		const tags = [...new Set([...tags0, ...csvTags])];
		if (!tags.includes("node:agent")) {
			tags.push("node:agent");
		}


		let parentId: string | null = null;
		if (parentRaw) {
			const resolved = await resolveIssueId(ctx.store, parentRaw);
			if (resolved.error) {
				return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
			}
			parentId = resolved.issueId;
		}

		if (parentId) {
			const blocked = await maybeBlockHeartbeatManagedMutation({
				ctx,
				issueIds: [parentId],
				allowOverride: allowHeartbeatManaged,
				pretty,
				recoveryCommand: `mu issues create <title> --parent ${parentId}`,
				jsonError,
			});
			if (blocked) {
				return blocked;
			}
		}

		let issue = await ctx.store.create(title, {
			body: resolvedBody,
			tags,
			priority,
		});

		if (parentId) {
			await ctx.store.add_dep(issue.id, "parent", parentId);
			issue = (await ctx.store.get(issue.id)) ?? issue;
		}

		if (jsonMode && !compact) {
			return ok(jsonText(issueJson(issue), pretty));
		}
		return ok(renderIssueMutationCompact("created", issue));
	}

	async function issuesUpdate(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues update - patch issue fields and routing metadata",
					"",
					"Usage:",
					"  mu issues update <id-or-prefix> [--title TEXT] [--body TEXT] [--status STATUS] [--outcome OUTCOME] [--priority N] [--tags CSV] [--add-tag TAG] [--remove-tag TAG] [--allow-heartbeat-managed] [--json] [--pretty]",
					"",
					"Options:",
					"  --title <TEXT>                       Replace title",
					"  --body <TEXT>                        Replace body",
					"  --status <open|in_progress|closed>   Set status",
					"  --outcome <OUTCOME>                  Set close outcome",
					"  --priority <1..5>                    Set priority",
					"  --tags <CSV>                         Replace tags from comma-separated list",
					"  --add-tag <TAG>                      Repeatable",
					"  --remove-tag <TAG>                   Repeatable",
					"  --allow-heartbeat-managed            Override heartbeat ownership guardrails",
					"  --json                               Emit full JSON record (default is compact ack)",
					"",
					"Examples:",
					"  mu issues update <id> --status in_progress",
					"  mu issues update <id> --add-tag blocked --remove-tag triage",
					"  mu issues update <id> --priority 2",
					"  mu issues update <id> --status closed --outcome success --json --pretty",
					"",
					"At least one field flag is required.",
				].join("\n") + "\n",
			);
		}

		const rawId = argv[0]!;
		const resolvedId = await resolveIssueId(ctx.store, rawId);
		if (resolvedId.error) {
			return { stdout: jsonText({ error: resolvedId.error }, pretty), stderr: "", exitCode: 1 };
		}
		const issueId = resolvedId.issueId!;

		const issue = await ctx.store.get(issueId);
		if (!issue) {
			return jsonError(`not found: ${rawId}`, { pretty, recovery: ["mu issues list --limit 20"] });
		}

		const argvRest = argv.slice(1);
		const { present: allowHeartbeatManaged, rest: argvOwned } = popFlag(
			argvRest,
			HEARTBEAT_MANAGED_OVERRIDE_FLAG,
		);
		const { value: title, rest: argv0 } = getFlagValue(argvOwned, "--title");
		const { value: body, rest: argv1 } = getFlagValue(argv0, "--body");
		const { value: status, rest: argv2 } = getFlagValue(argv1, "--status");
		const { value: outcome, rest: argv3 } = getFlagValue(argv2, "--outcome");
		const { value: priorityRaw, rest: argv4 } = getFlagValue(argv3, "--priority");
		const { value: tagsRaw, rest: argv5 } = getFlagValue(argv4, "--tags");
		const { values: addTags, rest: argv6 } = getRepeatFlagValues(argv5, ["--add-tag"]);
		const { values: removeTags, rest: argv7 } = getRepeatFlagValues(argv6, ["--remove-tag"]);
		const { present: jsonMode, rest: argv8 } = popFlag(argv7, "--json");
		const { present: compact, rest } = popFlag(argv8, "--compact");

		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues update --help"] });
		}

		if (priorityRaw != null) {
			const pr = ensureInt(priorityRaw, { name: "--priority", min: 1, max: 5 });
			if (pr == null) {
				return jsonError("priority must be in range 1-5", {
					pretty,
					recovery: [`mu issues update ${issueId} --priority 2`],
				});
			}
		}

		const fields: Record<string, unknown> = {};
		if (title != null) fields.title = title;
		if (body != null) fields.body = body;
		if (status != null) fields.status = status;
		if (outcome != null) fields.outcome = outcome;
		if (priorityRaw != null) fields.priority = Number.parseInt(priorityRaw, 10);

		if (tagsRaw != null) {
			fields.tags = tagsRaw
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0);
		}

		if (addTags.length > 0 || removeTags.length > 0) {
			let tags = (fields.tags as string[] | undefined) ?? [...(issue.tags ?? [])];
			for (const tag of addTags) {
				if (!tags.includes(tag)) {
					tags.push(tag);
				}
			}
			if (removeTags.length > 0) {
				tags = tags.filter((t) => !removeTags.includes(t));
			}
			fields.tags = tags;
		}


		const changedFields = Object.keys(fields).sort();
		if (changedFields.length === 0) {
			return jsonError("no fields to update", {
				pretty,
				recovery: [`mu issues update ${issueId} --status in_progress`],
			});
		}

		const blocked = await maybeBlockHeartbeatManagedMutation({
			ctx,
			issueIds: [issueId],
			allowOverride: allowHeartbeatManaged,
			pretty,
			recoveryCommand: `mu issues update ${issueId}`,
			jsonError,
		});
		if (blocked) {
			return blocked;
		}

		const updated = await ctx.store.update(issueId, fields);
		if (jsonMode && !compact) {
			return ok(jsonText(issueJson(updated), pretty));
		}
		return ok(renderIssueMutationCompact("updated", updated, { fields: changedFields }));
	}

	async function issuesClaim(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues claim - mark an open issue as in_progress",
					"",
					"Usage:",
					"  mu issues claim <id-or-prefix> [--allow-heartbeat-managed] [--json] [--pretty]",
					"",
					"Typical operator sequence:",
					"  mu issues ready --root <root-id>",
					"  mu issues claim <id>",
					'  mu forum post issue:<id> -m "starting" --author operator',
					"",
					"Fails unless current status is open.",
				].join("\n") + "\n",
			);
		}

		const { present: allowHeartbeatManaged, rest: argvOwned } = popFlag(
			argv.slice(1),
			HEARTBEAT_MANAGED_OVERRIDE_FLAG,
		);
		const { present: jsonMode, rest: argv0 } = popFlag(argvOwned, "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues claim --help"] });
		}

		const resolved = await resolveIssueId(ctx.store, argv[0]!);
		if (resolved.error) {
			return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
		}

		const issue = await ctx.store.get(resolved.issueId!);
		if (!issue) {
			return jsonError(`not found: ${argv[0]}`, { pretty, recovery: ["mu issues list --status open --limit 20"] });
		}
		if (issue.status !== "open") {
			return jsonError(`cannot claim issue in status=${issue.status}`, {
				pretty,
				recovery: [`mu issues get ${issue.id}`, `mu issues update ${issue.id} --status open`],
			});
		}

		const blocked = await maybeBlockHeartbeatManagedMutation({
			ctx,
			issueIds: [issue.id],
			allowOverride: allowHeartbeatManaged,
			pretty,
			recoveryCommand: `mu issues claim ${issue.id}`,
			jsonError,
		});
		if (blocked) {
			return blocked;
		}

		await ctx.store.claim(issue.id);
		const claimed = (await ctx.store.get(issue.id)) ?? issue;
		if (jsonMode && !compact) {
			return ok(jsonText(issueJson(claimed), pretty));
		}
		return ok(renderIssueMutationCompact("claimed", claimed));
	}

	async function issuesOpen(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues open - reopen an issue and clear outcome",
					"",
					"Usage:",
					"  mu issues open <id-or-prefix> [--allow-heartbeat-managed] [--json] [--pretty]",
					"",
					"Examples:",
					"  mu issues open <id>",
					"  mu issues open <id> --json --pretty",
					"",
					"Sets status=open and outcome=null.",
				].join("\n") + "\n",
			);
		}

		const { present: allowHeartbeatManaged, rest: argvOwned } = popFlag(
			argv.slice(1),
			HEARTBEAT_MANAGED_OVERRIDE_FLAG,
		);
		const { present: jsonMode, rest: argv0 } = popFlag(argvOwned, "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues open --help"] });
		}

		const resolved = await resolveIssueId(ctx.store, argv[0]!);
		if (resolved.error) {
			return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
		}

		const issue = await ctx.store.get(resolved.issueId!);
		if (!issue) {
			return jsonError(`not found: ${argv[0]}`, { pretty, recovery: ["mu issues list --limit 20"] });
		}

		const blocked = await maybeBlockHeartbeatManagedMutation({
			ctx,
			issueIds: [issue.id],
			allowOverride: allowHeartbeatManaged,
			pretty,
			recoveryCommand: `mu issues open ${issue.id}`,
			jsonError,
		});
		if (blocked) {
			return blocked;
		}

		const reopened = await ctx.store.update(issue.id, { status: "open", outcome: null });
		if (jsonMode && !compact) {
			return ok(jsonText(issueJson(reopened), pretty));
		}
		return ok(renderIssueMutationCompact("opened", reopened));
	}

	async function issuesClose(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues close - close an issue with an outcome",
					"",
					"Usage:",
					"  mu issues close <id-or-prefix> [--outcome OUTCOME] [--allow-heartbeat-managed] [--json] [--pretty]",
					"",
					"Options:",
					"  --outcome <success|failure|needs_work|expanded|skipped>",
					"            Default: success",
					"  --allow-heartbeat-managed  Override heartbeat ownership guardrails",
					"  --json    Emit full JSON record (default is compact ack)",
					"",
					"Examples:",
					"  mu issues close <id>",
					"  mu issues close <id> --outcome success",
					"  mu issues close <id> --outcome needs_work --json --pretty",
				].join("\n") + "\n",
			);
		}

		const issueRaw = argv[0]!;
		const { present: allowHeartbeatManaged, rest: argvOwned } = popFlag(
			argv.slice(1),
			HEARTBEAT_MANAGED_OVERRIDE_FLAG,
		);
		const { present: jsonMode, rest: argv0 } = popFlag(argvOwned, "--json");
		const { present: compact, rest: argv1 } = popFlag(argv0, "--compact");
		const { value: outcome, rest } = getFlagValue(argv1, "--outcome");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues close --help"] });
		}

		const resolved = await resolveIssueId(ctx.store, issueRaw);
		if (resolved.error) {
			return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
		}

		const blocked = await maybeBlockHeartbeatManagedMutation({
			ctx,
			issueIds: [resolved.issueId!],
			allowOverride: allowHeartbeatManaged,
			pretty,
			recoveryCommand: `mu issues close ${resolved.issueId!}`,
			jsonError,
		});
		if (blocked) {
			return blocked;
		}

		const closed = await ctx.store.close(resolved.issueId!, outcome ?? "success");
		if (jsonMode && !compact) {
			return ok(jsonText(issueJson(closed), pretty));
		}
		return ok(renderIssueMutationCompact("closed", closed));
	}

	async function issuesDep(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues dep - add dependency edge",
					"",
					"Usage:",
					"  mu issues dep <src-id> <blocks|parent> <dst-id> [--allow-heartbeat-managed] [--json] [--pretty]",
					"",
					"Edge types:",
					"  <src> blocks <dst>     <dst> waits until <src> is closed",
					"  <child> parent <root>  Attach child to parent/root tree",
					"",
					"Examples:",
					"  mu issues dep <task-a> blocks <task-b>",
					"  mu issues dep <child> parent <root>",
					"  mu issues dep <task-a> blocks <task-b> --json --pretty",
					"",
					"Tip: use `mu issues children <root>` and `mu issues ready --root <root>` to verify scheduling.",
				].join("\n") + "\n",
			);
		}

		const { present: allowHeartbeatManaged, rest: argvOwned } = popFlag(argv, HEARTBEAT_MANAGED_OVERRIDE_FLAG);
		const { present: jsonMode, rest: argv0 } = popFlag(argvOwned, "--json");
		const { present: compact, rest: argv1 } = popFlag(argv0, "--compact");
		if (argv1.length < 3) {
			return jsonError("usage: mu issues dep <src> <type> <dst>", {
				pretty,
				recovery: ["mu issues dep <src-id> blocks <dst-id>"],
			});
		}

		const [srcRaw, depType, dstRaw, ...rest] = argv1;
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues dep --help"] });
		}
		if (depType !== "blocks" && depType !== "parent") {
			return jsonError(`invalid dep type: ${depType} (use 'blocks' or 'parent')`, {
				pretty,
				recovery: ["mu issues dep <src-id> blocks <dst-id>", "mu issues dep <child-id> parent <parent-id>"],
			});
		}

		const src = await resolveIssueId(ctx.store, srcRaw!);
		if (src.error) return { stdout: jsonText({ error: src.error }, pretty), stderr: "", exitCode: 1 };
		const dst = await resolveIssueId(ctx.store, dstRaw!);
		if (dst.error) return { stdout: jsonText({ error: dst.error }, pretty), stderr: "", exitCode: 1 };

		if (src.issueId === dst.issueId) {
			return jsonError("source and destination must be different", {
				pretty,
				recovery: ["mu issues dep <src-id> blocks <dst-id>"],
			});
		}

		const blocked = await maybeBlockHeartbeatManagedMutation({
			ctx,
			issueIds: [src.issueId!, dst.issueId!],
			allowOverride: allowHeartbeatManaged,
			pretty,
			recoveryCommand: `mu issues dep ${src.issueId!} ${depType} ${dst.issueId!}`,
			jsonError,
		});
		if (blocked) {
			return blocked;
		}

		await ctx.store.add_dep(src.issueId!, depType, dst.issueId!);
		const payload = { ok: true, src: src.issueId!, type: depType, dst: dst.issueId! };
		if (jsonMode && !compact) {
			return ok(jsonText(payload, pretty));
		}
		return ok(renderIssueDepMutationCompact("added", payload));
	}

	async function issuesUndep(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues undep - remove dependency edge",
					"",
					"Usage:",
					"  mu issues undep <src-id> <blocks|parent> <dst-id> [--allow-heartbeat-managed] [--json] [--pretty]",
					"",
					"Examples:",
					"  mu issues undep <task-a> blocks <task-b>",
					"  mu issues undep <child> parent <root>",
					"  mu issues undep <task-a> blocks <task-b> --json --pretty",
					"",
					"Use this when dependency planning changes.",
				].join("\n") + "\n",
			);
		}

		const { present: allowHeartbeatManaged, rest: argvOwned } = popFlag(argv, HEARTBEAT_MANAGED_OVERRIDE_FLAG);
		const { present: jsonMode, rest: argv0 } = popFlag(argvOwned, "--json");
		const { present: compact, rest: argv1 } = popFlag(argv0, "--compact");
		if (argv1.length < 3) {
			return jsonError("usage: mu issues undep <src> <type> <dst>", {
				pretty,
				recovery: ["mu issues undep <src-id> blocks <dst-id>"],
			});
		}

		const [srcRaw, depType, dstRaw, ...rest] = argv1;
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues undep --help"] });
		}
		if (depType !== "blocks" && depType !== "parent") {
			return jsonError(`invalid dep type: ${depType} (use 'blocks' or 'parent')`, {
				pretty,
				recovery: ["mu issues undep <src-id> blocks <dst-id>"],
			});
		}

		const src = await resolveIssueId(ctx.store, srcRaw!);
		if (src.error) return { stdout: jsonText({ error: src.error }, pretty), stderr: "", exitCode: 1 };
		const dst = await resolveIssueId(ctx.store, dstRaw!);
		if (dst.error) return { stdout: jsonText({ error: dst.error }, pretty), stderr: "", exitCode: 1 };

		const blocked = await maybeBlockHeartbeatManagedMutation({
			ctx,
			issueIds: [src.issueId!, dst.issueId!],
			allowOverride: allowHeartbeatManaged,
			pretty,
			recoveryCommand: `mu issues undep ${src.issueId!} ${depType} ${dst.issueId!}`,
			jsonError,
		});
		if (blocked) {
			return blocked;
		}

		const removed = await ctx.store.remove_dep(src.issueId!, depType, dst.issueId!);
		const payload = { ok: removed, src: src.issueId!, type: depType, dst: dst.issueId! };
		if (jsonMode && !compact) {
			return ok(jsonText(payload, pretty));
		}
		return ok(renderIssueDepMutationCompact("removed", payload));
	}

	async function issuesChildren(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues children - list direct child issues",
					"",
					"Usage:",
					"  mu issues children <id-or-prefix> [--json] [--pretty]",
					"",
					"Examples:",
					"  mu issues children <root-id>",
					"  mu issues children <root-id> --json --pretty",
					"",
					"Shows only direct children (not full descendants).",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
		const { present: compact, rest } = popFlag(argv0, "--compact");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues children --help"] });
		}

		const resolved = await resolveIssueId(ctx.store, argv[0]!);
		if (resolved.error) {
			return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
		}

		const children = await ctx.store.children(resolved.issueId!);
		children.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
		if (!jsonMode || compact) {
			return ok(renderIssueCompactTable(children));
		}
		return ok(jsonText(children.map(issueJson), pretty));
	}

	async function issuesReady(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues ready - list open, unblocked, leaf issues tagged node:agent",
					"",
					"Usage:",
					"  mu issues ready [--root ID] [--tag TAG] [--contains TEXT] [--limit N|--all] [--json] [--pretty]",
					"",
					"Filters:",
					"  --root <id-or-prefix>   Restrict to one root subtree",
					"  --tag <TAG>             Repeatable extra tags (node:agent is always required)",
					"  --contains <TEXT>       Case-insensitive title/body substring",
					"  --limit <N>             Max rows (default: 20, max: 200)",
					"  --all                   Return all matching rows (explicitly unbounded)",
					"  --json                  Emit full JSON rows (default is compact table)",
					"",
					"Examples:",
					"  mu issues ready",
					"  mu issues ready --root <root-id>",
					"  mu issues ready --root <root-id> --tag node:agent",
					"  mu issues ready --contains parser --limit 20 --json --pretty",
					"",
					"Ready means:",
					"  status=open + all blockers closed + no open children + tags match.",
				].join("\n") + "\n",
			);
		}

		const { value: rootRaw, rest: argv0 } = getFlagValue(argv, "--root");
		const { values: extraTags, rest: argv1 } = getRepeatFlagValues(argv0, ["--tag"]);
		const { value: contains, rest: argv2 } = getFlagValue(argv1, "--contains");
		const { present: jsonMode, rest: argv3 } = popFlag(argv2, "--json");
		const { present: compact, rest: argv4 } = popFlag(argv3, "--compact");
		const { value: limitRaw, rest: argv5 } = getFlagValue(argv4, "--limit");
		const { present: allRows, rest } = popFlag(argv5, "--all");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues ready --help"] });
		}

		if (allRows && limitRaw != null) {
			return jsonError("cannot combine --all with --limit", {
				pretty,
				recovery: ["mu issues ready --all", "mu issues ready --limit 20"],
			});
		}

		const limit = allRows
			? null
			: limitRaw
				? ensureInt(limitRaw, { name: "--limit", min: 1, max: 200 })
				: 20;
		if (!allRows && limit == null) {
			return jsonError("--limit must be an integer between 1 and 200", {
				pretty,
				recovery: ["mu issues ready --limit 20"],
			});
		}

		let rootId: string | null = null;
		if (rootRaw) {
			const resolved = await resolveIssueId(ctx.store, rootRaw);
			if (resolved.error) {
				return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
			}
			rootId = resolved.issueId!;
		}

		const tags = ["node:agent", ...extraTags];
		const issues = await ctx.store.ready(rootId, {
			tags,
			contains: contains ?? null,
			limit,
		});
		if (!jsonMode || compact) {
			return ok(renderIssueCompactTable(issues));
		}
		return ok(jsonText(issues.map(issueJson), pretty));
	}

	async function issuesValidate(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues validate - validate DAG completion state for a root",
					"",
					"Usage:",
					"  mu issues validate <root-id-or-prefix> [--pretty]",
					"",
					"Returns:",
					"  { root_id, is_final, reason }",
					"",
					"Examples:",
					"  mu issues validate <root-id>",
					"  mu issues validate <root-id> --pretty",
					"",
					"Use before closing parent/epic issues to confirm subtree completion.",
				].join("\n") + "\n",
			);
		}

		const resolved = await resolveIssueId(ctx.store, argv[0]!);
		if (resolved.error) {
			return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
		}

		const v = await ctx.store.validate(resolved.issueId!);
		return ok(jsonText({ root_id: resolved.issueId, is_final: v.is_final, reason: v.reason }, pretty));
	}


	return { cmdIssues };
}

export async function cmdIssues<Ctx extends IssueCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: IssueCommandDeps,
): Promise<IssueCommandRunResult> {
	return await buildIssueHandlers<Ctx>(deps).cmdIssues(argv, ctx);
}
