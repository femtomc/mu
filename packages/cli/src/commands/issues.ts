import type { Issue } from "@femtomc/mu-core";
import type { IssueStore } from "@femtomc/mu-issue";

export type IssueCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type IssueCommandCtx = {
	store: IssueStore;
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
					"Worker flow (single atomic issue):",
					"  mu issues ready --root <root-id> --tag role:worker",
					"  mu issues claim <issue-id>",
					"  mu issues get <issue-id>",
					'  mu forum post issue:<issue-id> -m "started work" --author worker',
					"  mu issues close <issue-id> --outcome success",
					"",
					"Orchestrator flow (plan + coordinate + integrate):",
					'  mu issues create "Root goal" --tag node:root --role orchestrator',
					'  mu issues create "Implement parser" --parent <root-id> --role worker',
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
					"  mu issues list [--status STATUS] [--tag TAG] [--root ID] [--limit N] [--json] [--pretty]",
					"",
					"Filters:",
					"  --status <open|in_progress|closed>   Filter by status",
					"  --tag <TAG>                          Repeatable; issue must contain all tags",
					"  --root <id-or-prefix>                Restrict to a root issue subtree",
					"  --limit <N>                          Return only the newest N entries (0 = unlimited)",
					"  --json                               Emit full JSON rows (default is compact table)",
					"",
					"Examples:",
					"  mu issues list",
					"  mu issues list --status open --limit 20",
					"  mu issues list --root mu-abc123 --tag role:worker",
					"  mu issues list --status open --limit 20 --json --pretty",
				].join("\n") + "\n",
			);
		}

		const { value: statusRaw, rest: argv0 } = getFlagValue(argv, "--status");
		const { values: tags, rest: argv1 } = getRepeatFlagValues(argv0, ["--tag"]);
		const { value: rootRaw, rest: argv2 } = getFlagValue(argv1, "--root");
		const { present: jsonMode, rest: argv3 } = popFlag(argv2, "--json");
		const { present: compact, rest: argv4 } = popFlag(argv3, "--compact");
		const { value: limitRaw, rest } = getFlagValue(argv4, "--limit");

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

		let limit = 0;
		if (limitRaw) {
			const parsed = ensureInt(limitRaw, { name: "--limit", min: 0 });
			if (parsed == null) {
				return jsonError("limit must be an integer >= 0", { pretty, recovery: ["mu issues list --limit 20"] });
			}
			limit = parsed;
		}

		if (limit > 0) {
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
					"  Default output is compact detail; use --json for full record.",
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

	function normalizeMuRole(role: string): "orchestrator" | "worker" | null {
		const trimmed = role.trim();
		if (trimmed === "orchestrator" || trimmed === "worker") {
			return trimmed;
		}
		return null;
	}

	async function issuesCreate(argv: string[], ctx: Ctx, pretty: boolean): Promise<IssueCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu issues create - create a new issue (auto-adds node:agent tag)",
					"",
					"Usage:",
					"  mu issues create <title> [--body TEXT] [--parent ID] [--tag TAG] [--role ROLE] [--priority N] [--json] [--pretty]",
					"",
					"Options:",
					"  --body, -b <TEXT>                   Optional issue body",
					"  --parent <id-or-prefix>             Add <new-issue> parent <parent> edge",
					"  --tag, -t <TAG>                     Repeatable custom tags",
					"  --tags <CSV>                        Comma-separated custom tags",
					"  --role, -r <orchestrator|worker>    Adds role:<role> tag",
					"  --priority, -p <1..5>               Priority (1 highest urgency, default 3)",
					"  --json                              Emit full JSON record (default is compact ack)",
					"  --pretty                            Pretty-print JSON result",
					"",
					"Examples:",
					'  mu issues create "Root planning issue" --tag node:root --role orchestrator',
					'  mu issues create "Implement parser" --parent <root-id> --role worker --priority 2',
					'  mu issues create "Write tests" -b "Cover error paths" -t area:test --json --pretty',
				].join("\n") + "\n",
			);
		}

		const title = argv[0];
		if (!title || title.startsWith("-")) {
			return jsonError("missing title", {
				pretty,
				recovery: ['mu issues create "Title" --body "Details"'],
			});
		}

		const { value: body, rest: argv0 } = getFlagValue(argv.slice(1), "--body");
		const { value: bodyShort, rest: argv1 } = getFlagValue(argv0, "-b");
		const resolvedBody = body ?? bodyShort ?? "";

		const { value: parentRaw, rest: argv2 } = getFlagValue(argv1, "--parent");
		const { values: tags0, rest: argv3 } = getRepeatFlagValues(argv2, ["--tag", "-t"]);
		const { value: tagsCsvRaw, rest: argv4 } = getFlagValue(argv3, "--tags");
		const { value: role, rest: argv5 } = getFlagValue(argv4, "--role");
		const { value: roleShort, rest: argv6 } = getFlagValue(argv5, "-r");
		const { value: priorityRaw, rest: argv7 } = getFlagValue(argv6, "--priority");
		const { value: priorityShortRaw, rest: argv8 } = getFlagValue(argv7, "-p");
		const { present: jsonMode, rest: argv9 } = popFlag(argv8, "--json");
		const { present: compact, rest: restFinal } = popFlag(argv9, "--compact");

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

		const roleRaw = role ?? roleShort ?? null;
		const roleNorm = roleRaw != null ? normalizeMuRole(roleRaw) : null;
		if (roleRaw != null && roleNorm == null) {
			return jsonError(`invalid --role: ${JSON.stringify(roleRaw)} (supported: orchestrator, worker)`, {
				pretty,
				recovery: [`mu issues create "${title}" --role worker`],
			});
		}

		if (roleNorm != null) {
			tags.push(`role:${roleNorm}`);
		}

		let parentId: string | null = null;
		if (parentRaw) {
			const resolved = await resolveIssueId(ctx.store, parentRaw);
			if (resolved.error) {
				return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
			}
			parentId = resolved.issueId;
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
					"  mu issues update <id-or-prefix> [--title TEXT] [--body TEXT] [--status STATUS] [--outcome OUTCOME] [--priority N] [--tags CSV] [--add-tag TAG] [--remove-tag TAG] [--role ROLE] [--json] [--pretty]",
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
					"  --role <orchestrator|worker>         Rewrites role:* tag",
					"  --json                               Emit full JSON record (default is compact ack)",
					"",
					"Examples:",
					"  mu issues update <id> --status in_progress",
					"  mu issues update <id> --add-tag blocked --remove-tag triage",
					"  mu issues update <id> --role worker --priority 2",
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
		const { value: title, rest: argv0 } = getFlagValue(argvRest, "--title");
		const { value: body, rest: argv1 } = getFlagValue(argv0, "--body");
		const { value: status, rest: argv2 } = getFlagValue(argv1, "--status");
		const { value: outcome, rest: argv3 } = getFlagValue(argv2, "--outcome");
		const { value: priorityRaw, rest: argv4 } = getFlagValue(argv3, "--priority");
		const { value: tagsRaw, rest: argv5 } = getFlagValue(argv4, "--tags");
		const { values: addTags, rest: argv6 } = getRepeatFlagValues(argv5, ["--add-tag"]);
		const { values: removeTags, rest: argv7 } = getRepeatFlagValues(argv6, ["--remove-tag"]);
		const { value: role, rest: argv8 } = getFlagValue(argv7, "--role");
		const { present: jsonMode, rest: argv9 } = popFlag(argv8, "--json");
		const { present: compact, rest } = popFlag(argv9, "--compact");

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

		if (role != null) {
			const normalized = normalizeMuRole(role);
			if (normalized == null) {
				return jsonError(`invalid --role: ${JSON.stringify(role)} (supported: orchestrator, worker)`, {
					pretty,
					recovery: [`mu issues update ${issueId} --role worker`],
				});
			}
			// Update tags: remove existing role:* tags and add the new one.
			let currentTags = (fields.tags as string[] | undefined) ?? [...(issue.tags ?? [])];
			currentTags = currentTags.filter((t) => !t.startsWith("role:"));
			currentTags.push(`role:${normalized}`);
			fields.tags = currentTags;
		}

		const changedFields = Object.keys(fields).sort();
		if (changedFields.length === 0) {
			return jsonError("no fields to update", {
				pretty,
				recovery: [`mu issues update ${issueId} --status in_progress`],
			});
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
					"  mu issues claim <id-or-prefix> [--json] [--pretty]",
					"",
					"Typical worker sequence:",
					"  mu issues ready --root <root-id>",
					"  mu issues claim <id>",
					'  mu forum post issue:<id> -m "starting" --author worker',
					"",
					"Fails unless current status is open.",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
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
					"  mu issues open <id-or-prefix> [--json] [--pretty]",
					"",
					"Examples:",
					"  mu issues open <id>",
					"  mu issues open <id> --json --pretty",
					"",
					"Sets status=open and outcome=null.",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
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
					"  mu issues close <id-or-prefix> [--outcome OUTCOME] [--json] [--pretty]",
					"",
					"Options:",
					"  --outcome <success|failure|needs_work|expanded|skipped>",
					"            Default: success",
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
		const { present: jsonMode, rest: argv0 } = popFlag(argv.slice(1), "--json");
		const { present: compact, rest: argv1 } = popFlag(argv0, "--compact");
		const { value: outcome, rest } = getFlagValue(argv1, "--outcome");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues close --help"] });
		}

		const resolved = await resolveIssueId(ctx.store, issueRaw);
		if (resolved.error) {
			return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
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
					"  mu issues dep <src-id> <blocks|parent> <dst-id> [--json] [--pretty]",
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

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
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
					"  mu issues undep <src-id> <blocks|parent> <dst-id> [--json] [--pretty]",
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

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
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
					"  mu issues ready [--root ID] [--tag TAG] [--contains TEXT] [--limit N] [--json] [--pretty]",
					"",
					"Filters:",
					"  --root <id-or-prefix>   Restrict to one root subtree",
					"  --tag <TAG>             Repeatable extra tags (node:agent is always required)",
					"  --contains <TEXT>       Case-insensitive title/body substring",
					"  --limit <N>             Max rows (default: no explicit cap)",
					"  --json                  Emit full JSON rows (default is compact table)",
					"",
					"Examples:",
					"  mu issues ready",
					"  mu issues ready --root <root-id>",
					"  mu issues ready --root <root-id> --tag role:worker",
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
		const { value: limitRaw, rest } = getFlagValue(argv4, "--limit");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues ready --help"] });
		}

		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 200 }) : null;
		if (limitRaw && limit == null) {
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
