import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Issue } from "@femtomc/mu-core";
import { type EventLog, FsJsonlStore, fsEventLog, getStorePaths, newRunId, runContext } from "@femtomc/mu-core/node";
import type { ForumTopicSummary } from "@femtomc/mu-forum";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { DagRunner, extractDescription, splitFrontmatter } from "@femtomc/mu-orchestrator";
import { DEFAULT_ORCHESTRATOR_MD, DEFAULT_REVIEWER_ROLE_MD, DEFAULT_WORKER_ROLE_MD } from "./templates.js";

export type RunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type CliCtx = {
	cwd: string;
	repoRoot: string;
	store: IssueStore;
	forum: ForumStore;
	events: EventLog;
	paths: ReturnType<typeof getStorePaths>;
};

type RoleJson = {
	name: string;
	prompt_path: string;
	cli: string;
	model: string;
	reasoning: string;
	description: string;
	description_source: string;
};

function ok(stdout: string = "", exitCode: number = 0): RunResult {
	return { stdout, stderr: "", exitCode };
}

function jsonText(data: unknown, pretty: boolean): string {
	return `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`;
}

function formatRecovery(recovery?: readonly string[] | null): string {
	if (!recovery || recovery.length === 0) {
		return "";
	}
	return ` Recovery: ${recovery.join(" | ")}`;
}

function jsonError(msg: string, opts: { pretty?: boolean; recovery?: readonly string[] } = {}): RunResult {
	const pretty = opts.pretty ?? false;
	return { stdout: jsonText({ error: `${msg}${formatRecovery(opts.recovery)}` }, pretty), stderr: "", exitCode: 1 };
}

function hasHelpFlag(argv: readonly string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function popFlag(argv: readonly string[], name: string): { present: boolean; rest: string[] } {
	let present = false;
	const rest: string[] = [];
	for (const a of argv) {
		if (a === name) {
			present = true;
			continue;
		}
		rest.push(a);
	}
	return { present, rest };
}

function getFlagValue(argv: readonly string[], name: string): { value: string | null; rest: string[] } {
	const rest: string[] = [];
	let value: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === name) {
			const next = argv[i + 1];
			if (next == null) {
				value = "";
				i += 0;
				continue;
			}
			value = next;
			i += 1;
			continue;
		}
		if (a.startsWith(`${name}=`)) {
			value = a.slice(`${name}=`.length);
			continue;
		}
		rest.push(a);
	}
	return { value, rest };
}

function getRepeatFlagValues(argv: readonly string[], names: readonly string[]): { values: string[]; rest: string[] } {
	const nameSet = new Set(names);
	const values: string[] = [];
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (nameSet.has(a)) {
			const next = argv[i + 1];
			if (next != null) {
				values.push(next);
				i += 1;
			}
			continue;
		}
		let matched = false;
		for (const name of names) {
			if (a.startsWith(`${name}=`)) {
				values.push(a.slice(`${name}=`.length));
				matched = true;
				break;
			}
		}
		if (matched) {
			continue;
		}
		rest.push(a);
	}
	return { values, rest };
}

function ensureInt(value: string, opts: { name: string; min?: number; max?: number }): number | null {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) {
		return null;
	}
	if (opts.min != null && n < opts.min) {
		return null;
	}
	if (opts.max != null && n > opts.max) {
		return null;
	}
	return n;
}

async function ensureCtx(cwd: string): Promise<CliCtx> {
	const repoRoot = findRepoRoot(cwd);
	const paths = getStorePaths(repoRoot);
	const events = fsEventLog(paths.eventsPath);
	const store = new IssueStore(new FsJsonlStore(paths.issuesPath), { events });
	const forum = new ForumStore(new FsJsonlStore(paths.forumPath), { events });
	return { cwd, repoRoot, store, forum, events, paths };
}

function findRepoRoot(start: string): string {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolve(start);
		}
		current = parent;
	}
}

async function listRolesJson(repoRoot: string): Promise<RoleJson[]> {
	const rolesDir = join(repoRoot, ".mu", "roles");
	let entries: string[];
	try {
		entries = await readdir(rolesDir);
	} catch {
		return [];
	}

	const mdFiles = entries.filter((e) => e.endsWith(".md")).sort();
	const out: RoleJson[] = [];
	for (const file of mdFiles) {
		const abs = join(rolesDir, file);
		const text = await readFile(abs, "utf8");
		const { meta, body } = splitFrontmatter(text);
		const { description, source } = extractDescription(meta, body);

		const name = file.replace(/\.md$/, "");
		const prompt_path = relative(repoRoot, abs).replaceAll("\\", "/");

		out.push({
			name,
			prompt_path,
			cli: typeof meta.cli === "string" ? meta.cli : "",
			model: typeof meta.model === "string" ? meta.model : "",
			reasoning: typeof meta.reasoning === "string" ? meta.reasoning : "",
			description,
			description_source: source,
		});
	}
	return out;
}

function issueJson(issue: Issue): Record<string, unknown> {
	return {
		id: issue.id,
		title: issue.title,
		body: issue.body ?? "",
		status: issue.status,
		outcome: issue.outcome ?? null,
		tags: issue.tags ?? [],
		deps: issue.deps ?? [],
		execution_spec: issue.execution_spec ?? null,
		priority: issue.priority ?? 3,
		created_at: issue.created_at ?? 0,
		updated_at: issue.updated_at ?? 0,
	};
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
	return [
		"mu - issue DAG + forum CLI",
		"",
		"Usage:",
		"  mu <command> [args...]",
		"",
		"Commands:",
		"  init [--force]                  Initialize .mu store + templates",
		"  status [--json] [--pretty]      Show repo + DAG status",
		"  roles [--json|--table]          List role templates",
		"  issues <subcmd>                 Issue DAG commands (JSON)",
		"  forum <subcmd>                  Forum commands (JSON)",
		"  run <prompt...>                 Create root + run DAG loop",
		"  resume <root-id>                Resume a DAG loop",
		"  login [<provider>] [--list]      Authenticate with an AI provider",
		"  replay <id|path> [--backend pi] Replay a logged run (pi-only)",
		"",
		"Run `mu <command> --help` for details.",
	].join("\n");
}

export async function run(argv: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
	const cwd = opts.cwd ?? process.cwd();

	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		return ok(`${mainHelp()}\n`);
	}
	if (argv.includes("--version")) {
		return ok("mu 0.0.0\n");
	}

	const cmd = argv[0]!;
	const rest = argv.slice(1);
	const ctx = await ensureCtx(cwd);

	switch (cmd) {
		case "init":
			return await cmdInit(rest, ctx);
		case "status":
			return await cmdStatus(rest, ctx);
		case "roles":
			return await cmdRoles(rest, ctx);
		case "issues":
			return await cmdIssues(rest, ctx);
		case "forum":
			return await cmdForum(rest, ctx);
		case "run":
			return await cmdRun(rest, ctx);
		case "resume":
			return await cmdResume(rest, ctx);
		case "login":
			return await cmdLogin(rest);
		case "replay":
			return await cmdReplay(rest, ctx);
		default:
			return jsonError(`unknown command: ${cmd}`, {
				recovery: ["mu --help"],
			});
	}
}

async function cmdInit(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			["mu init - initialize .mu state, templates, and logs", "", "Usage:", "  mu init [--force]"].join(
				"\n",
			) + "\n",
		);
	}

	const { present: force, rest } = popFlag(argv, "--force");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu init --help"] });
	}

	await mkdir(ctx.paths.storeDir, { recursive: true });
	await writeFile(ctx.paths.issuesPath, "", { encoding: "utf8", flag: "a" });
	await writeFile(ctx.paths.forumPath, "", { encoding: "utf8", flag: "a" });
	await writeFile(ctx.paths.eventsPath, "", { encoding: "utf8", flag: "a" });

	await mkdir(ctx.paths.logsDir, { recursive: true });

	if (force || !existsSync(ctx.paths.orchestratorPath)) {
		await writeFile(ctx.paths.orchestratorPath, DEFAULT_ORCHESTRATOR_MD, "utf8");
	}

	const rolesDir = ctx.paths.rolesDir;
	await mkdir(rolesDir, { recursive: true });
	const workerPath = join(rolesDir, "worker.md");
	if (force || !existsSync(workerPath)) {
		await writeFile(workerPath, DEFAULT_WORKER_ROLE_MD, "utf8");
	}
	const reviewerPath = join(rolesDir, "reviewer.md");
	if (force || !existsSync(reviewerPath)) {
		await writeFile(reviewerPath, DEFAULT_REVIEWER_ROLE_MD, "utf8");
	}

	const verb = force ? "Reinitialized" : "Initialized";
	return ok(`${verb} .mu/ in ${ctx.repoRoot}\n`);
}

async function cmdStatus(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			["mu status - show repo + DAG status", "", "Usage:", "  mu status [--json] [--pretty]"].join("\n") + "\n",
		);
	}

	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
	const { present: jsonMode, rest } = popFlag(argv0, "--json");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu status --help"] });
	}

	const roots = (await ctx.store.list({ tag: "node:root" })).map(issueJson);
	const openIssues = await ctx.store.list({ status: "open" });
	const ready = await ctx.store.ready(null, { tags: ["node:agent"] });
	const topics = await ctx.forum.topics("issue:");
	const roles = await listRolesJson(ctx.repoRoot);

	const payload = {
		repo_root: ctx.repoRoot,
		roots,
		open_count: openIssues.length,
		ready_count: ready.length,
		ready: ready.slice(0, 10).map(issueJson),
		recent_topics: topics.slice(0, 10),
		roles,
	};

	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}

	let out = `Repo: ${ctx.repoRoot}\n`;
	out += `Root issues: ${roots.length}\n`;
	out += `Open issues: ${openIssues.length}\n`;
	out += `Ready issues: ${ready.length}\n`;
	out += `Roles: ${roles.length}\n`;

	if (ready.length > 0) {
		out += "\nReady:\n";
		for (const issue of ready.slice(0, 10)) {
			out += `  ${issue.id} [p=${issue.priority ?? 3}] ${String(issue.title ?? "").slice(0, 80)}\n`;
		}
	}

	if (topics.length > 0) {
		out += "\nRecent issue topics:\n";
		for (const topic of topics.slice(0, 10)) {
			out += `  ${topic.topic} (${topic.messages}) last_at=${topic.last_at}\n`;
		}
	}

	return ok(out);
}

async function cmdRoles(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu roles - list role templates from .mu/roles/*.md",
				"",
				"Usage:",
				"  mu roles [--json] [--table] [--pretty]",
				"",
				"Defaults to JSON output for automation.",
			].join("\n") + "\n",
		);
	}

	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
	const { present: tableMode, rest: argv1 } = popFlag(argv0, "--table");
	const { present: jsonFlag, rest } = popFlag(argv1, "--json");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu roles --help"] });
	}

	const jsonMode = jsonFlag || !tableMode;
	const roles = await listRolesJson(ctx.repoRoot);

	if (jsonMode) {
		return ok(jsonText(roles, pretty));
	}

	// Simple ASCII table.
	const lines: string[] = [];
	lines.push("Name\tCLI\tModel\tReasoning\tPrompt");
	for (const role of roles) {
		lines.push(
			[role.name, role.cli || "-", role.model || "-", role.reasoning || "-", role.prompt_path || "-"].join("\t"),
		);
	}
	return ok(`${lines.join("\n")}\n`);
}

async function cmdIssues(argv: string[], ctx: CliCtx): Promise<RunResult> {
	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

	if (argv0.length === 0 || hasHelpFlag(argv0)) {
		return ok(
			[
				"mu issues - issue DAG commands (JSON)",
				"",
				"Usage:",
				"  mu issues <command> [args...] [--pretty]",
				"",
				"Commands:",
				"  list/get/create/update/claim/open/close/dep/undep/children/ready/validate",
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

async function issuesList(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues list - list issues with optional filters",
				"",
				"Usage:",
				"  mu issues list [--status STATUS] [--tag TAG] [--root ID] [--limit N] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const { value: statusRaw, rest: argv0 } = getFlagValue(argv, "--status");
	const { values: tags, rest: argv1 } = getRepeatFlagValues(argv0, ["--tag"]);
	const { value: rootRaw, rest: argv2 } = getFlagValue(argv1, "--root");
	const { value: limitRaw, rest } = getFlagValue(argv2, "--limit");

	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues list --help"] });
	}

	const status = statusRaw && statusRaw.length > 0 ? statusRaw : null;
	if (status != null && status !== "open" && status !== "in_progress" && status !== "closed") {
		return jsonError(`invalid status: ${status}`, { pretty, recovery: ["mu issues list --help"] });
	}

	let issues = await ctx.store.list({ status: (status as any) ?? undefined });
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

	return ok(jsonText(issues.map(issueJson), pretty));
}

async function issuesGet(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			["mu issues get - fetch a single issue", "", "Usage:", "  mu issues get <id-or-prefix> [--pretty]"].join(
				"\n",
			) + "\n",
		);
	}

	const resolved = await resolveIssueId(ctx.store, argv[0]!);
	if (resolved.error) {
		return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
	}

	const issue = await ctx.store.get(resolved.issueId!);
	if (!issue) {
		return jsonError(`not found: ${argv[0]}`, { pretty, recovery: ["mu issues list --limit 20"] });
	}

	return ok(jsonText(issueJson(issue), pretty));
}

function buildExecutionSpec(fields: {
	role?: string | null;
	cli?: string | null;
	model?: string | null;
	reasoning?: string | null;
	prompt_path?: string | null;
}): Record<string, string> | null {
	const spec: Record<string, string> = {};
	if (fields.role) spec.role = fields.role;
	if (fields.cli) spec.cli = fields.cli;
	if (fields.model) spec.model = fields.model;
	if (fields.reasoning) spec.reasoning = fields.reasoning;
	if (fields.prompt_path) spec.prompt_path = fields.prompt_path;
	return Object.keys(spec).length > 0 ? spec : null;
}

async function issuesCreate(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues create - create a new issue (adds node:agent tag automatically)",
				"",
				"Usage:",
				"  mu issues create <title> [--body TEXT] [--parent ID] [--tag TAG] [--role ROLE] [--cli NAME] [--model NAME] [--reasoning LEVEL] [--prompt-path PATH] [--priority N] [--pretty]",
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
	const { value: role, rest: argv4 } = getFlagValue(argv3, "--role");
	const { value: roleShort, rest: argv5 } = getFlagValue(argv4, "-r");
	const { value: cli, rest: argv6 } = getFlagValue(argv5, "--cli");
	const { value: model, rest: argv7 } = getFlagValue(argv6, "--model");
	const { value: reasoning, rest: argv8 } = getFlagValue(argv7, "--reasoning");
	const { value: promptPath, rest: argv9 } = getFlagValue(argv8, "--prompt-path");
	const { value: priorityRaw, rest } = getFlagValue(argv9, "--priority");

	const { value: priorityShortRaw, rest: rest2 } = getFlagValue(rest, "-p");
	const restFinal = rest2;
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

	const tags = [...new Set(tags0)];
	if (!tags.includes("node:agent")) {
		tags.push("node:agent");
	}

	const execution_spec = buildExecutionSpec({
		role: role ?? roleShort ?? null,
		cli: cli ?? null,
		model: model ?? null,
		reasoning: reasoning ?? null,
		prompt_path: promptPath ?? null,
	});

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
		execution_spec,
		priority,
	});

	if (parentId) {
		await ctx.store.add_dep(issue.id, "parent", parentId);
		issue = (await ctx.store.get(issue.id)) ?? issue;
	}

	return ok(jsonText(issueJson(issue), pretty));
}

async function issuesUpdate(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues update - patch fields and routing metadata",
				"",
				"Usage:",
				"  mu issues update <id-or-prefix> [--title TEXT] [--body TEXT] [--status STATUS] [--outcome OUTCOME] [--priority N] [--add-tag TAG] [--remove-tag TAG] [--role ROLE] [--cli NAME] [--model NAME] [--reasoning LEVEL] [--prompt-path PATH] [--clear-execution-spec] [--pretty]",
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
	const { values: addTags, rest: argv5 } = getRepeatFlagValues(argv4, ["--add-tag"]);
	const { values: removeTags, rest: argv6 } = getRepeatFlagValues(argv5, ["--remove-tag"]);

	const { value: role, rest: argv7 } = getFlagValue(argv6, "--role");
	const { value: cli, rest: argv8 } = getFlagValue(argv7, "--cli");
	const { value: model, rest: argv9 } = getFlagValue(argv8, "--model");
	const { value: reasoning, rest: argv10 } = getFlagValue(argv9, "--reasoning");
	const { value: promptPath, rest: argv11 } = getFlagValue(argv10, "--prompt-path");
	const { present: clearExecutionSpec, rest } = popFlag(argv11, "--clear-execution-spec");

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

	if (addTags.length > 0 || removeTags.length > 0) {
		let tags = [...(issue.tags ?? [])];
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

	const routingTouched = [role, cli, model, reasoning, promptPath].some((v) => v != null);
	if (clearExecutionSpec) {
		fields.execution_spec = null;
	} else if (routingTouched) {
		const spec = { ...(issue.execution_spec ?? {}) } as Record<string, unknown>;
		if (role != null) spec.role = role;
		if (cli != null) spec.cli = cli;
		if (model != null) spec.model = model;
		if (reasoning != null) spec.reasoning = reasoning;
		if (promptPath != null) spec.prompt_path = promptPath;
		fields.execution_spec = Object.keys(spec).length > 0 ? spec : null;
	}

	if (Object.keys(fields).length === 0) {
		return jsonError("no fields to update", {
			pretty,
			recovery: [`mu issues update ${issueId} --status in_progress`],
		});
	}

	const updated = await ctx.store.update(issueId, fields);
	return ok(jsonText(issueJson(updated), pretty));
}

async function issuesClaim(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues claim - mark an open issue as in_progress",
				"",
				"Usage:",
				"  mu issues claim <id-or-prefix> [--pretty]",
			].join("\n") + "\n",
		);
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
	return ok(jsonText(issueJson(claimed), pretty));
}

async function issuesOpen(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues open - reopen an issue and clear outcome",
				"",
				"Usage:",
				"  mu issues open <id-or-prefix> [--pretty]",
			].join("\n") + "\n",
		);
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
	return ok(jsonText(issueJson(reopened), pretty));
}

async function issuesClose(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues close - close an issue with an outcome",
				"",
				"Usage:",
				"  mu issues close <id-or-prefix> [--outcome OUTCOME] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const issueRaw = argv[0]!;
	const { value: outcome, rest } = getFlagValue(argv.slice(1), "--outcome");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues close --help"] });
	}

	const resolved = await resolveIssueId(ctx.store, issueRaw);
	if (resolved.error) {
		return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
	}

	const closed = await ctx.store.close(resolved.issueId!, outcome ?? "success");
	return ok(jsonText(issueJson(closed), pretty));
}

async function issuesDep(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues dep - add dependency edge",
				"",
				"Usage:",
				"  mu issues dep <src-id> <blocks|parent> <dst-id> [--pretty]",
			].join("\n") + "\n",
		);
	}

	if (argv.length < 3) {
		return jsonError("usage: mu issues dep <src> <type> <dst>", {
			pretty,
			recovery: ["mu issues dep <src-id> blocks <dst-id>"],
		});
	}

	const [srcRaw, depType, dstRaw] = argv;
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
	return ok(jsonText({ ok: true, src: src.issueId, type: depType, dst: dst.issueId }, pretty));
}

async function issuesUndep(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues undep - remove dependency edge",
				"",
				"Usage:",
				"  mu issues undep <src-id> <blocks|parent> <dst-id> [--pretty]",
			].join("\n") + "\n",
		);
	}

	if (argv.length < 3) {
		return jsonError("usage: mu issues undep <src> <type> <dst>", {
			pretty,
			recovery: ["mu issues undep <src-id> blocks <dst-id>"],
		});
	}

	const [srcRaw, depType, dstRaw] = argv;
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
	return ok(jsonText({ ok: removed, src: src.issueId, type: depType, dst: dst.issueId }, pretty));
}

async function issuesChildren(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues children - list direct child issues",
				"",
				"Usage:",
				"  mu issues children <id-or-prefix> [--pretty]",
			].join("\n") + "\n",
		);
	}

	const resolved = await resolveIssueId(ctx.store, argv[0]!);
	if (resolved.error) {
		return { stdout: jsonText({ error: resolved.error }, pretty), stderr: "", exitCode: 1 };
	}

	const children = await ctx.store.children(resolved.issueId!);
	children.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
	return ok(jsonText(children.map(issueJson), pretty));
}

async function issuesReady(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues ready - list open, unblocked, leaf issues tagged node:agent",
				"",
				"Usage:",
				"  mu issues ready [--root ID] [--tag TAG] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const { value: rootRaw, rest: argv0 } = getFlagValue(argv, "--root");
	const { values: extraTags, rest } = getRepeatFlagValues(argv0, ["--tag"]);
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu issues ready --help"] });
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
	const issues = await ctx.store.ready(rootId, { tags });
	return ok(jsonText(issues.map(issueJson), pretty));
}

async function issuesValidate(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues validate - validate DAG completion state for a root",
				"",
				"Usage:",
				"  mu issues validate <root-id-or-prefix> [--pretty]",
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

async function cmdForum(argv: string[], ctx: CliCtx): Promise<RunResult> {
	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

	if (argv0.length === 0 || hasHelpFlag(argv0)) {
		return ok(
			[
				"mu forum - forum messages for coordination (JSON)",
				"",
				"Usage:",
				"  mu forum <command> [args...] [--pretty]",
				"",
				"Commands:",
				"  post/read/topics",
			].join("\n") + "\n",
		);
	}

	const sub = argv0[0]!;
	const rest = argv0.slice(1);

	switch (sub) {
		case "post":
			return await forumPost(rest, ctx, pretty);
		case "read":
			return await forumRead(rest, ctx, pretty);
		case "topics":
			return await forumTopics(rest, ctx, pretty);
		default:
			return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu forum --help"] });
	}
}

async function forumPost(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu forum post - post a message to a topic",
				"",
				"Usage:",
				"  mu forum post <topic> -m <message> [--author NAME] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const topic = argv[0]!;
	const { value: message, rest: argv0 } = getFlagValue(argv.slice(1), "--message");
	const { value: messageShort, rest: argv1 } = getFlagValue(argv0, "-m");
	const { value: author, rest } = getFlagValue(argv1, "--author");

	const msgBody = message ?? messageShort;
	if (!msgBody) {
		return jsonError("missing message (-m/--message)", {
			pretty,
			recovery: [`mu forum post ${topic} -m "..." --author worker`],
		});
	}
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu forum post --help"] });
	}

	const msg = await ctx.forum.post(topic, msgBody, author ?? "system");
	return ok(jsonText(msg, pretty));
}

async function forumRead(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu forum read - read messages from a topic (chronological)",
				"",
				"Usage:",
				"  mu forum read <topic> [--limit N] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const topic = argv[0]!;
	const { value: limitRaw, rest } = getFlagValue(argv.slice(1), "--limit");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu forum read --help"] });
	}

	const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1 }) : 50;
	if (limit == null) {
		return jsonError("limit must be >= 1", { pretty, recovery: [`mu forum read ${topic} --limit 20`] });
	}

	const msgs = await ctx.forum.read(topic, limit);
	return ok(jsonText(msgs, pretty));
}

async function forumTopics(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu forum topics - list active topics sorted by most recent message",
				"",
				"Usage:",
				"  mu forum topics [--prefix PREFIX] [--limit N] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const { value: prefix, rest: argv0 } = getFlagValue(argv, "--prefix");
	const { value: limitRaw, rest } = getFlagValue(argv0, "--limit");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu forum topics --help"] });
	}

	const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1 }) : 100;
	if (limit == null) {
		return jsonError("limit must be >= 1", { pretty, recovery: ["mu forum topics --limit 20"] });
	}

	let topics: ForumTopicSummary[] = await ctx.forum.topics(prefix ?? null);
	if (limit > 0) {
		topics = topics.slice(0, limit);
	}
	return ok(jsonText(topics, pretty));
}

async function cmdRun(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu run - create a root issue and run the DAG loop",
				"",
				"Usage:",
				"  mu run <prompt...> [--max-steps N] [--review|--no-review] [--json]",
			].join("\n") + "\n",
		);
	}

	let maxSteps = 20;
	let review = true;
	let jsonMode = false;
	const promptParts: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--json") {
			jsonMode = true;
			continue;
		}
		if (a === "--review") {
			review = true;
			continue;
		}
		if (a === "--no-review") {
			review = false;
			continue;
		}
		if (a === "--max-steps") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --max-steps", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			const n = ensureInt(next, { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			maxSteps = n;
			i += 1;
			continue;
		}
		if (a.startsWith("--max-steps=")) {
			const n = ensureInt(a.slice("--max-steps=".length), { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			maxSteps = n;
			continue;
		}
		promptParts.push(a);
	}

	const promptText = promptParts.join(" ").trim();
	if (!promptText) {
		return jsonError("missing prompt", { recovery: ['mu run "Break down and execute this goal"'] });
	}

	const runId = newRunId();
	const { rootIssue, result } = await runContext({ runId }, async () => {
		const rootIssue = await ctx.store.create(promptText, { tags: ["node:agent", "node:root"] });
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot);
		const result = await runner.run(rootIssue.id, maxSteps, { review });
		return { rootIssue, result };
	});

	if (jsonMode) {
		return {
			stdout: jsonText(
				{ status: result.status, steps: result.steps, error: result.error, root_id: rootIssue.id },
				true,
			),
			stderr: "",
			exitCode: result.status === "root_final" ? 0 : 1,
		};
	}

	let out = `Root: ${rootIssue.id} ${String(rootIssue.title ?? "").slice(0, 80)}\n`;
	out += `Runner status: ${result.status}\n`;
	if (result.error) {
		out += `Error: ${result.error}\n`;
	}
	return { stdout: out, stderr: "", exitCode: result.status === "root_final" ? 0 : 1 };
}

async function cmdResume(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu resume - resume an interrupted DAG loop",
				"",
				"Usage:",
				"  mu resume <root-id> [--max-steps N] [--review|--no-review] [--json]",
			].join("\n") + "\n",
		);
	}

	const rawId = argv[0]!;
	let maxSteps = 20;
	let review = true;
	let jsonMode = false;
	const rest = argv.slice(1);

	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--json") {
			jsonMode = true;
			continue;
		}
		if (a === "--review") {
			review = true;
			continue;
		}
		if (a === "--no-review") {
			review = false;
			continue;
		}
		if (a === "--max-steps") {
			const next = rest[i + 1];
			if (!next) {
				return jsonError("missing value for --max-steps", { recovery: [`mu resume ${rawId} --max-steps 20`] });
			}
			const n = ensureInt(next, { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: [`mu resume ${rawId} --max-steps 20`] });
			}
			maxSteps = n;
			i += 1;
			continue;
		}
		if (a.startsWith("--max-steps=")) {
			const n = ensureInt(a.slice("--max-steps=".length), { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: [`mu resume ${rawId} --max-steps 20`] });
			}
			maxSteps = n;
			continue;
		}
		return jsonError(`unknown arg: ${a}`, { recovery: ["mu resume --help"] });
	}

	const resolved = await resolveIssueId(ctx.store, rawId);
	if (resolved.error) {
		return { stdout: jsonText({ error: resolved.error }, false), stderr: "", exitCode: 1 };
	}
	const rootId = resolved.issueId!;

	const reset = await ctx.store.reset_in_progress(rootId);
	const runId = newRunId();
	const result = await runContext({ runId }, async () => {
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot);
		return await runner.run(rootId, maxSteps, { review });
	});

	if (jsonMode) {
		return {
			stdout: jsonText({ status: result.status, steps: result.steps, error: result.error, root_id: rootId }, true),
			stderr: "",
			exitCode: result.status === "root_final" ? 0 : 1,
		};
	}

	let out = "";
	if (reset.length > 0) {
		out += `Reset ${reset.length} stale issue(s) to open: ${reset.join(", ")}\n`;
	}
	out += `Resuming ${rootId}\n`;
	out += `Runner status: ${result.status}\n`;
	if (result.error) {
		out += `Error: ${result.error}\n`;
	}
	return { stdout: out, stderr: "", exitCode: result.status === "root_final" ? 0 : 1 };
}

async function cmdReplay(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			["mu replay - replay a logged run (pi-only)", "", "Usage:", "  mu replay <issue-id|path> [--backend pi]"].join(
				"\n",
			) + "\n",
		);
	}

	const target = argv[0]!;
	const { value: backend, rest } = getFlagValue(argv.slice(1), "--backend");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu replay --help"] });
	}
	if (backend && backend !== "pi") {
		return jsonError(`unsupported backend: ${backend} (only pi is supported)`, {
			recovery: ["mu replay --backend pi <id>"],
		});
	}

	const logsDir = ctx.paths.logsDir;
	let path = resolve(ctx.cwd, target);
	if (!existsSync(path)) {
		const candidate = join(logsDir, `${target}.jsonl`);
		if (existsSync(candidate)) {
			path = candidate;
		} else {
			// Prefix match: <target>*.jsonl
			let entries: string[];
			try {
				entries = await readdir(logsDir);
			} catch {
				entries = [];
			}
			const matches = entries.filter((e) => e.startsWith(target) && e.endsWith(".jsonl"));
			if (matches.length === 1) {
				path = join(logsDir, matches[0]!);
			} else if (matches.length > 1) {
				return jsonError(`ambiguous prefix '${target}'`, {
					recovery: matches.slice(0, 10).map((m) => `mu replay ${m.replace(/\\.jsonl$/, "")}`),
				});
			} else {
				return jsonError(`log not found: ${target}`, { recovery: ["mu status", "ls .mu/logs"] });
			}
		}
	}

	const text = await readFile(path, "utf8");
	return ok(text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text);
}

function readLine(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return new Promise<string>((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

async function cmdLogin(argv: string[]): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu login - authenticate with an AI provider via OAuth",
				"",
				"Usage:",
				"  mu login [<provider>] [--list] [--logout]",
				"",
				"Examples:",
				"  mu login --list                 List available OAuth providers",
				"  mu login openai-codex           Login to OpenAI (ChatGPT Plus)",
				"  mu login anthropic              Login to Anthropic (Claude Pro/Max)",
				"  mu login github-copilot         Login to GitHub Copilot",
				"  mu login google-gemini-cli      Login to Google Gemini CLI",
				"  mu login openai-codex --logout  Remove stored credentials",
				"",
				"Credentials are stored in ~/.pi/agent/auth.json (shared with pi CLI).",
			].join("\n") + "\n",
		);
	}

	// Lazy-import pi SDK to avoid loading it for every mu command.
	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { getOAuthProviders } = await import("@mariozechner/pi-ai");

	const authStorage = new AuthStorage();
	const providers = getOAuthProviders();

	const { present: listMode, rest: argv0 } = popFlag(argv, "--list");
	const { present: logoutMode, rest: argv1 } = popFlag(argv0, "--logout");

	if (listMode || argv1.length === 0) {
		const lines: string[] = ["Available OAuth providers:", ""];
		for (const p of providers) {
			const hasAuth = authStorage.hasAuth(p.id);
			const status = hasAuth ? "[authenticated]" : "[not configured]";
			lines.push(`  ${p.id.padEnd(24)} ${p.name.padEnd(30)} ${status}`);
		}
		lines.push("", "Environment variable auth (no login needed):");
		lines.push("  Set OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, etc.");
		return ok(`${lines.join("\n")}\n`);
	}

	const providerId = argv1[0]!;
	const rest = argv1.slice(1);
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu login --help"] });
	}

	const provider = providers.find((p) => p.id === providerId);
	if (!provider) {
		const available = providers.map((p) => p.id).join(", ");
		return jsonError(`unknown provider: ${providerId}`, {
			recovery: [`mu login --list`, `Available: ${available}`],
		});
	}

	if (logoutMode) {
		authStorage.logout(providerId);
		return ok(`Logged out from ${provider.name} (${providerId})\n`);
	}

	try {
		await authStorage.login(providerId, {
			onAuth: (info) => {
				process.stderr.write(`\nOpen this URL to authenticate:\n  ${info.url}\n\n`);
				if (info.instructions) {
					process.stderr.write(`${info.instructions}\n\n`);
				}
				// Try to open browser automatically.
				const open = (cmd: string, args: string[]) => {
					try {
						const { spawn } = require("node:child_process");
						spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
					} catch {}
				};
				if (process.platform === "darwin") {
					open("open", [info.url]);
				} else if (process.platform === "linux") {
					open("xdg-open", [info.url]);
				}
			},
			onPrompt: async (prompt) => {
				const msg = prompt.placeholder ? `${prompt.message} [${prompt.placeholder}]: ` : `${prompt.message}: `;
				const answer = await readLine(msg);
				if (!answer && prompt.placeholder) return prompt.placeholder;
				return answer;
			},
			onProgress: (message) => {
				process.stderr.write(`${message}\n`);
			},
			onManualCodeInput: async () => {
				return await readLine("Paste the authorization code or callback URL: ");
			},
		});
	} catch (err) {
		return jsonError(`login failed: ${err instanceof Error ? err.message : String(err)}`, {
			recovery: [`mu login ${providerId}`],
		});
	}

	return ok(`Authenticated with ${provider.name} (${providerId})\n`);
}
