import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Issue } from "@femtomc/mu-core";
import { type EventLog, FsJsonlStore, fsEventLog, getStorePaths, newRunId, runContext } from "@femtomc/mu-core/node";
import type { ForumTopicSummary } from "@femtomc/mu-forum";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import type { BackendRunner, ModelOverrides } from "@femtomc/mu-orchestrator";
import { PiPrettyStreamRenderer } from "./pi_pretty_stream_renderer.js";

export type RunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type CliWriter = {
	write: (chunk: string) => void;
};

type CliIO = {
	stdout?: CliWriter;
	stderr?: CliWriter;
};

type CliCtx = {
	cwd: string;
	repoRoot: string;
	store: IssueStore;
	forum: ForumStore;
	events: EventLog;
	paths: ReturnType<typeof getStorePaths>;
	io?: CliIO;
	backend?: BackendRunner;
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
		"  init [--force]                  Initialize .mu store + logs",
		"  status [--json] [--pretty]      Show repo + DAG status",
		"  issues <subcmd>                 Issue DAG commands (JSON)",
		"  forum <subcmd>                  Forum commands (JSON)",
		"  run <prompt...>                 Create root + run DAG loop",
		"  resume <root-id>                Resume a DAG loop",
		"  login [<provider>] [--list]      Authenticate with an AI provider",
		"  replay <id|path> [--backend pi] Replay a logged run (pi-only)",
		"  serve [--port N] [--open]        Start server and open web UI",
		"",
		"Run `mu <command> --help` for details.",
	].join("\n");
}

export async function run(
	argv: string[],
	opts: { cwd?: string; io?: CliIO; backend?: BackendRunner } = {},
): Promise<RunResult> {
	const cwd = opts.cwd ?? process.cwd();

	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		return ok(`${mainHelp()}\n`);
	}
	if (argv.includes("--version")) {
		const pkgPath = join(dirname(new URL(import.meta.url).pathname), "..", "package.json");
		const { version } = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
		return ok(`mu ${version}\n`);
	}

	const cmd = argv[0]!;
	const rest = argv.slice(1);
	const ctx0 = await ensureCtx(cwd);
	const ctx: CliCtx = { ...ctx0, io: opts.io, backend: opts.backend };

	switch (cmd) {
		case "init":
			return await cmdInit(rest, ctx);
		case "status":
			return await cmdStatus(rest, ctx);
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
		case "serve":
			return await cmdServe(rest, ctx);
		default:
			return jsonError(`unknown command: ${cmd}`, {
				recovery: ["mu --help"],
			});
	}
}

async function cmdInit(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			["mu init - initialize .mu store and logs", "", "Usage:", "  mu init [--force]"].join("\n") + "\n",
		);
	}

	const { present: force, rest } = popFlag(argv, "--force");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu init --help"] });
	}

	await mkdir(ctx.paths.storeDir, { recursive: true });
	if (force) {
		await writeFile(ctx.paths.issuesPath, "", { encoding: "utf8" });
		await writeFile(ctx.paths.forumPath, "", { encoding: "utf8" });
		await writeFile(ctx.paths.eventsPath, "", { encoding: "utf8" });
	} else {
		await writeFile(ctx.paths.issuesPath, "", { encoding: "utf8", flag: "a" });
		await writeFile(ctx.paths.forumPath, "", { encoding: "utf8", flag: "a" });
		await writeFile(ctx.paths.eventsPath, "", { encoding: "utf8", flag: "a" });
	}

	await mkdir(ctx.paths.logsDir, { recursive: true });

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

	const payload = {
		repo_root: ctx.repoRoot,
		roots,
		open_count: openIssues.length,
		ready_count: ready.length,
		ready: ready.slice(0, 10).map(issueJson),
		recent_topics: topics.slice(0, 10),
	};

	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}

	let out = `Repo: ${ctx.repoRoot}\n`;
	out += `Root issues: ${roots.length}\n`;
	out += `Open issues: ${openIssues.length}\n`;
	out += `Ready issues: ${ready.length}\n`;

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
}): Record<string, string> | null {
	const spec: Record<string, string> = {};
	if (fields.role) spec.role = fields.role;
	return Object.keys(spec).length > 0 ? spec : null;
}

function normalizeMuRole(role: string): "orchestrator" | "worker" | null {
	const trimmed = role.trim();
	if (trimmed === "orchestrator" || trimmed === "worker") {
		return trimmed;
	}
	return null;
}

async function issuesCreate(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues create - create a new issue (adds node:agent tag automatically)",
				"",
				"Usage:",
				"  mu issues create <title> [--body TEXT] [--parent ID] [--tag TAG] [--role ROLE] [--priority N] [--pretty]",
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
	const { value: priorityRaw, rest } = getFlagValue(argv5, "--priority");

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

	const roleRaw = role ?? roleShort ?? null;
	const roleNorm = roleRaw != null ? normalizeMuRole(roleRaw) : null;
	if (roleRaw != null && roleNorm == null) {
		return jsonError(`invalid --role: ${JSON.stringify(roleRaw)} (supported: orchestrator, worker)`, {
			pretty,
			recovery: [`mu issues create "${title}" --role worker`],
		});
	}

	const execution_spec = buildExecutionSpec({
		role: roleNorm,
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
				"  mu issues update <id-or-prefix> [--title TEXT] [--body TEXT] [--status STATUS] [--outcome OUTCOME] [--priority N] [--add-tag TAG] [--remove-tag TAG] [--role ROLE] [--clear-execution-spec] [--pretty]",
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
	const { present: clearExecutionSpec, rest } = popFlag(argv7, "--clear-execution-spec");

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

	const routingTouched = role != null;
	if (clearExecutionSpec) {
		fields.execution_spec = null;
	} else if (routingTouched) {
		const normalized = normalizeMuRole(role!);
		if (normalized == null) {
			return jsonError(`invalid --role: ${JSON.stringify(role)} (supported: orchestrator, worker)`, {
				pretty,
				recovery: [`mu issues update ${issueId} --role worker`],
			});
		}
		fields.execution_spec = buildExecutionSpec({ role: normalized });
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

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function trimForHeader(text: string, maxLen: number): string {
	const t = oneLine(text);
	if (t.length <= maxLen) return t;
	if (maxLen <= 3) return t.slice(0, maxLen);
	return `${t.slice(0, maxLen - 3)}...`;
}

function ensureTrailingNewline(text: string): string {
	return text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
}

async function cmdRun(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu run - create a root issue and run the DAG loop",
				"",
				"Usage:",
				"  mu run <prompt...> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--raw-stream] [--json]",
				"",
				"Model flags:",
				"  --model <id>        Model ID (e.g. gpt-5.3-codex, claude-opus-4-6)",
				"  --provider <id>     Provider (e.g. anthropic, openai-codex)",
				"  --reasoning <lvl>   Thinking level (minimal|low|medium|high|xhigh)",
			].join("\n") + "\n",
		);
	}

	let maxSteps = 20;
	let jsonMode = false;
	let rawStream = false;
	let modelFlag: string | undefined;
	let providerFlag: string | undefined;
	let reasoningFlag: string | undefined;
	const promptParts: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--json") {
			jsonMode = true;
			continue;
		}
		if (a === "--raw-stream") {
			rawStream = true;
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
		if (a === "--model") {
			modelFlag = argv[++i];
			continue;
		}
		if (a.startsWith("--model=")) {
			modelFlag = a.slice("--model=".length);
			continue;
		}
		if (a === "--provider") {
			providerFlag = argv[++i];
			continue;
		}
		if (a.startsWith("--provider=")) {
			providerFlag = a.slice("--provider=".length);
			continue;
		}
		if (a === "--reasoning") {
			reasoningFlag = argv[++i];
			continue;
		}
		if (a.startsWith("--reasoning=")) {
			reasoningFlag = a.slice("--reasoning=".length);
			continue;
		}
		promptParts.push(a);
	}

	const modelOverrides: ModelOverrides = {};
	if (modelFlag) modelOverrides.model = modelFlag;
	if (providerFlag) modelOverrides.provider = providerFlag;
	if (reasoningFlag) modelOverrides.reasoning = reasoningFlag;

	const promptText = promptParts.join(" ").trim();
	if (!promptText) {
		return jsonError("missing prompt", { recovery: ['mu run "Break down and execute this goal"'] });
	}

	if (jsonMode && rawStream) {
		return jsonError("cannot combine --json and --raw-stream", {
			recovery: ['mu run "..." --json', 'mu run "..." --raw-stream'],
		});
	}

	const runId = newRunId();
	const io = ctx.io;
	const streaming = io != null && !jsonMode;

	let lastStepIssueId: string | null = null;
	let lastBackendIssueId: string | null = null;

	// Used to keep progress headers from printing mid-line.
	let lineOpen = false;

	// Lazy-import the orchestrator to keep "mu status/issues/forum" fast.
	const { DagRunner, PiStreamRenderer } = await import("@femtomc/mu-orchestrator");
	const usePretty = Boolean((io?.stdout as any)?.isTTY && (io?.stderr as any)?.isTTY);
	const pretty = rawStream || !usePretty ? null : new PiPrettyStreamRenderer({ color: process.env.NO_COLOR == null });
	const renderer = rawStream || usePretty ? null : new PiStreamRenderer();

	const hooks = streaming
		? {
				onStepStart: (ev: {
					step: number;
					rootId: string;
					issueId: string;
					role: string | null;
					title: string;
				}) => {
					lastStepIssueId = ev.issueId;
					const role = ev.role ?? "orchestrator";
					const title = trimForHeader(ev.title ?? "", 80);
					if (lineOpen) {
						io?.stderr?.write("\n");
						lineOpen = false;
					}
					io?.stderr?.write(`Step ${ev.step}/${maxSteps}  ${ev.issueId}  role=${role}  ${title}\n`);
				},
				onBackendLine: (ev: { issueId: string; line: string }) => {
					lastBackendIssueId = ev.issueId;
					if (rawStream) {
						const out = ensureTrailingNewline(ev.line);
						io?.stdout?.write(out);
						lineOpen = false;
						return;
					}
					const rendered = pretty?.renderLine(ev.line);
					if (rendered) {
						if (rendered.stderr) io?.stderr?.write(rendered.stderr);
						if (rendered.stdout) io?.stdout?.write(rendered.stdout);
						const tail = rendered.stdout ?? rendered.stderr ?? "";
						lineOpen = tail.length > 0 && !tail.endsWith("\n");
						return;
					}
					const out = renderer?.renderLine(ev.line);
					if (out) {
						io?.stdout?.write(out);
						lineOpen = !out.endsWith("\n");
					}
				},
				onStepEnd: (ev: {
					step: number;
					issueId: string;
					outcome: string | null;
					elapsedS: number;
					exitCode: number;
				}) => {
					const flush = pretty?.finish();
					if (flush) {
						if (flush.stderr) io?.stderr?.write(flush.stderr);
						if (flush.stdout) io?.stdout?.write(flush.stdout);
						lineOpen = false;
					}
					const outcome = ev.outcome ?? "?";
					const elapsed = Number.isFinite(ev.elapsedS) ? ev.elapsedS.toFixed(1) : String(ev.elapsedS);
					if (lineOpen) {
						io?.stderr?.write("\n");
						lineOpen = false;
					}
					io?.stderr?.write(
						`Done ${ev.step}/${maxSteps}  ${ev.issueId}  outcome=${outcome}  elapsed=${elapsed}s  exit=${ev.exitCode}\n`,
					);
				},
			}
		: undefined;

	const { rootIssue, result } = await runContext({ runId }, async () => {
		const rootIssue = await ctx.store.create(promptText, { tags: ["node:agent", "node:root"] });
		if (streaming) {
			io?.stderr?.write(`Root: ${rootIssue.id}  ${trimForHeader(String(rootIssue.title ?? ""), 80)}\n`);
		}
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot, { backend: ctx.backend, events: ctx.events, modelOverrides });
		const result = await runner.run(rootIssue.id, maxSteps, { hooks });
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

	const exitCode = result.status === "root_final" ? 0 : 1;

	if (streaming) {
		io?.stderr?.write(`Runner status: ${result.status}\n`);
		if (result.error) {
			io?.stderr?.write(`Error: ${result.error}\n`);
		}
		if (exitCode !== 0) {
			const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootIssue.id;
			const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
			io?.stderr?.write(
				[
					"",
					"Recovery:",
					`  mu replay ${replayId}`,
					`  logs: ${logsRel}/${replayId}*.jsonl`,
					`  resume: mu resume ${rootIssue.id} --max-steps ${maxSteps}`,
					"",
				].join("\n"),
			);
		}
		return { stdout: "", stderr: "", exitCode };
	}

	let out = `Root: ${rootIssue.id} ${String(rootIssue.title ?? "").slice(0, 80)}\n`;
	out += `Runner status: ${result.status}\n`;
	if (result.error) {
		out += `Error: ${result.error}\n`;
	}
	if (exitCode !== 0) {
		const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootIssue.id;
		const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
		out += "\nRecovery:\n";
		out += `  mu replay ${replayId}\n`;
		out += `  logs: ${logsRel}/${replayId}*.jsonl\n`;
		out += `  resume: mu resume ${rootIssue.id} --max-steps ${maxSteps}\n`;
	}
	return { stdout: out, stderr: "", exitCode };
}

async function cmdResume(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu resume - resume an interrupted DAG loop",
				"",
				"Usage:",
				"  mu resume <root-id> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--raw-stream] [--json]",
				"",
				"Model flags:",
				"  --model <id>        Model ID (e.g. gpt-5.3-codex, claude-opus-4-6)",
				"  --provider <id>     Provider (e.g. anthropic, openai-codex)",
				"  --reasoning <lvl>   Thinking level (minimal|low|medium|high|xhigh)",
			].join("\n") + "\n",
		);
	}

	const rawId = argv[0]!;
	let maxSteps = 20;
	let jsonMode = false;
	let rawStream = false;
	let modelFlag: string | undefined;
	let providerFlag: string | undefined;
	let reasoningFlag: string | undefined;
	const rest = argv.slice(1);

	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--json") {
			jsonMode = true;
			continue;
		}
		if (a === "--raw-stream") {
			rawStream = true;
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
		if (a === "--model") {
			modelFlag = rest[++i];
			continue;
		}
		if (a.startsWith("--model=")) {
			modelFlag = a.slice("--model=".length);
			continue;
		}
		if (a === "--provider") {
			providerFlag = rest[++i];
			continue;
		}
		if (a.startsWith("--provider=")) {
			providerFlag = a.slice("--provider=".length);
			continue;
		}
		if (a === "--reasoning") {
			reasoningFlag = rest[++i];
			continue;
		}
		if (a.startsWith("--reasoning=")) {
			reasoningFlag = a.slice("--reasoning=".length);
			continue;
		}
		return jsonError(`unknown arg: ${a}`, { recovery: ["mu resume --help"] });
	}

	const modelOverrides: ModelOverrides = {};
	if (modelFlag) modelOverrides.model = modelFlag;
	if (providerFlag) modelOverrides.provider = providerFlag;
	if (reasoningFlag) modelOverrides.reasoning = reasoningFlag;

	if (jsonMode && rawStream) {
		return jsonError("cannot combine --json and --raw-stream", {
			recovery: [`mu resume ${rawId} --json`, `mu resume ${rawId} --raw-stream`],
		});
	}

	const resolved = await resolveIssueId(ctx.store, rawId);
	if (resolved.error) {
		return { stdout: jsonText({ error: resolved.error }, false), stderr: "", exitCode: 1 };
	}
	const rootId = resolved.issueId!;

	const reset = await ctx.store.reset_in_progress(rootId);
	const runId = newRunId();
	const io = ctx.io;
	const streaming = io != null && !jsonMode;

	let lastStepIssueId: string | null = null;
	let lastBackendIssueId: string | null = null;
	let lineOpen = false;

	// Lazy-import the orchestrator to keep "mu status/issues/forum" fast.
	const { DagRunner, PiStreamRenderer } = await import("@femtomc/mu-orchestrator");
	const usePretty = Boolean((io?.stdout as any)?.isTTY && (io?.stderr as any)?.isTTY);
	const pretty = rawStream || !usePretty ? null : new PiPrettyStreamRenderer({ color: process.env.NO_COLOR == null });
	const renderer = rawStream || usePretty ? null : new PiStreamRenderer();

	const hooks = streaming
		? {
				onStepStart: (ev: { step: number; issueId: string; role: string | null; title: string }) => {
					lastStepIssueId = ev.issueId;
					const role = ev.role ?? "orchestrator";
					const title = trimForHeader(ev.title ?? "", 80);
					if (lineOpen) {
						io?.stderr?.write("\n");
						lineOpen = false;
					}
					io?.stderr?.write(`Step ${ev.step}/${maxSteps}  ${ev.issueId}  role=${role}  ${title}\n`);
				},
				onBackendLine: (ev: { issueId: string; line: string }) => {
					lastBackendIssueId = ev.issueId;
					if (rawStream) {
						const out = ensureTrailingNewline(ev.line);
						io?.stdout?.write(out);
						lineOpen = false;
						return;
					}
					const rendered = pretty?.renderLine(ev.line);
					if (rendered) {
						if (rendered.stderr) io?.stderr?.write(rendered.stderr);
						if (rendered.stdout) io?.stdout?.write(rendered.stdout);
						const tail = rendered.stdout ?? rendered.stderr ?? "";
						lineOpen = tail.length > 0 && !tail.endsWith("\n");
						return;
					}
					const out = renderer?.renderLine(ev.line);
					if (out) {
						io?.stdout?.write(out);
						lineOpen = !out.endsWith("\n");
					}
				},
				onStepEnd: (ev: {
					step: number;
					issueId: string;
					outcome: string | null;
					elapsedS: number;
					exitCode: number;
				}) => {
					const flush = pretty?.finish();
					if (flush) {
						if (flush.stderr) io?.stderr?.write(flush.stderr);
						if (flush.stdout) io?.stdout?.write(flush.stdout);
						lineOpen = false;
					}
					const outcome = ev.outcome ?? "?";
					const elapsed = Number.isFinite(ev.elapsedS) ? ev.elapsedS.toFixed(1) : String(ev.elapsedS);
					if (lineOpen) {
						io?.stderr?.write("\n");
						lineOpen = false;
					}
					io?.stderr?.write(
						`Done ${ev.step}/${maxSteps}  ${ev.issueId}  outcome=${outcome}  elapsed=${elapsed}s  exit=${ev.exitCode}\n`,
					);
				},
			}
		: undefined;

	const result = await runContext({ runId }, async () => {
		if (streaming) {
			if (reset.length > 0) {
				io?.stderr?.write(`Reset ${reset.length} stale issue(s) to open: ${reset.join(", ")}\n`);
			}
			io?.stderr?.write(`Resuming ${rootId}\n`);
		}
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot, { backend: ctx.backend, events: ctx.events, modelOverrides });
		return await runner.run(rootId, maxSteps, { hooks });
	});

	if (jsonMode) {
		return {
			stdout: jsonText({ status: result.status, steps: result.steps, error: result.error, root_id: rootId }, true),
			stderr: "",
			exitCode: result.status === "root_final" ? 0 : 1,
		};
	}

	const exitCode = result.status === "root_final" ? 0 : 1;
	if (streaming) {
		io?.stderr?.write(`Runner status: ${result.status}\n`);
		if (result.error) {
			io?.stderr?.write(`Error: ${result.error}\n`);
		}
		if (exitCode !== 0) {
			const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootId;
			const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
			io?.stderr?.write(
				[
					"",
					"Recovery:",
					`  mu replay ${replayId}`,
					`  logs: ${logsRel}/${replayId}*.jsonl`,
					`  resume: mu resume ${rootId} --max-steps ${maxSteps}`,
					"",
				].join("\n"),
			);
		}
		return { stdout: "", stderr: "", exitCode };
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
	if (exitCode !== 0) {
		const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootId;
		const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
		out += "\nRecovery:\n";
		out += `  mu replay ${replayId}\n`;
		out += `  logs: ${logsRel}/${replayId}*.jsonl\n`;
		out += `  resume: mu resume ${rootId} --max-steps ${maxSteps}\n`;
	}
	return { stdout: out, stderr: "", exitCode };
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

async function cmdServe(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu serve - start server and open web UI",
				"",
				"Usage:",
				"  mu serve [--port N] [--no-open] [--api-port N]",
				"",
				"Options:",
				"  --port N       Web UI port (default: 5173)",
				"  --api-port N   API server port (default: 3000)",
				"  --no-open      Don't open browser automatically",
				"",
				"For headless/SSH environments:",
				"  The server will detect headless mode and show port forwarding instructions.",
			].join("\n") + "\n",
		);
	}

	// Parse arguments
	const { value: portRaw, rest: argv0 } = getFlagValue(argv, "--port");
	const { value: apiPortRaw, rest: argv1 } = getFlagValue(argv0, "--api-port");
	const { present: noOpen, rest } = popFlag(argv1, "--no-open");
	
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu serve --help"] });
	}

	const webPort = portRaw ? ensureInt(portRaw, { name: "--port", min: 1, max: 65535 }) : 5173;
	const apiPort = apiPortRaw ? ensureInt(apiPortRaw, { name: "--api-port", min: 1, max: 65535 }) : 3000;
	
	if (webPort == null) {
		return jsonError("port must be 1-65535", { recovery: ["mu serve --port 5173"] });
	}
	if (apiPort == null) {
		return jsonError("api-port must be 1-65535", { recovery: ["mu serve --api-port 3000"] });
	}

	const io = ctx.io;
	
	// Lazy import server and child_process
	const { createServer } = await import("../../server/dist/index.js");
	const { spawn } = await import("node:child_process");
	const { createServer: createHttpServer } = await import("node:http");
	const { join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	
	// Start the API server
	const server = createServer({ repoRoot: ctx.repoRoot, port: apiPort });
	io?.stderr?.write(`Starting API server on port ${apiPort}...\n`);
	
	// Use Bun.serve if available, otherwise fall back to Node's http
	let apiServer: any;
	if (typeof Bun !== "undefined" && Bun.serve) {
		apiServer = Bun.serve(server);
	} else {
		// Create Node.js compatible server
		const nodeServer = createHttpServer(async (req, res) => {
			try {
				// Convert Node request to Web API Request
				const url = `http://${req.headers.host}${req.url}`;
				const headers = new Headers();
				for (const [key, value] of Object.entries(req.headers as Record<string, string | string[] | undefined>)) {
					if (value) headers.set(key, Array.isArray(value) ? value[0] : String(value));
				}
				
				let body: Buffer | undefined;
				if (req.method !== "GET" && req.method !== "HEAD") {
					body = await new Promise<Buffer>((resolve) => {
						const chunks: Buffer[] = [];
						req.on("data", (chunk) => chunks.push(chunk));
						req.on("end", () => resolve(Buffer.concat(chunks)));
					});
				}
				
				const request = new Request(url, {
					method: req.method,
					headers,
					body: body && body.length > 0 ? body : undefined,
				});
				
				// Call the handler
				const response = await server.fetch(request);
				
				// Convert Response back to Node response
				res.statusCode = response.status;
				response.headers.forEach((value, key) => {
					res.setHeader(key, value);
				});
				
				const responseBody = await response.arrayBuffer();
				res.end(Buffer.from(responseBody));
			} catch (err) {
				console.error("Server error:", err);
				res.statusCode = 500;
				res.end(JSON.stringify({ error: "Internal server error" }));
			}
		});
		
		nodeServer.listen(apiPort, "0.0.0.0");
		apiServer = nodeServer;
	}
	
	io?.stderr?.write(`API server running at http://localhost:${apiPort}\n`);

	// Check if we're in a headless environment
	const isHeadless = !process.env.DISPLAY && !process.env.BROWSER;
	const shouldOpen = !noOpen && !isHeadless;

	// Start the web UI (development mode using vite)
	io?.stderr?.write(`Starting web UI on port ${webPort}...\n`);
	
	// Get the web package directory
	const __dirname = fileURLToPath(new URL(".", import.meta.url));
	const webDir = join(__dirname, "..", "..", "web");
	
	// Check if we have vite available
	const viteProcess = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(webPort)], {
		cwd: webDir,
		env: {
			...process.env,
			VITE_API_URL: `http://localhost:${apiPort}`,
		},
		stdio: "pipe",
	});
	
	// Handle vite output
	viteProcess.stdout?.on("data", (data) => {
		const text = data.toString();
		// Only print vite's "ready" message and errors
		if (text.includes("ready in") || text.includes("Local:")) {
			io?.stderr?.write(text);
		}
	});
	
	viteProcess.stderr?.on("data", (data) => {
		io?.stderr?.write(data.toString());
	});
	
	// Handle process termination
	const cleanup = () => {
		viteProcess.kill();
		if (apiServer && typeof apiServer.close === "function") {
			apiServer.close();
		} else if (apiServer && typeof apiServer.stop === "function") {
			apiServer.stop();
		}
		process.exit(0);
	};
	
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	
	// Wait a bit for vite to start
	await new Promise(resolve => setTimeout(resolve, 2000));
	
	io?.stderr?.write(`\nWeb UI available at http://localhost:${webPort}\n`);
	io?.stderr?.write(`API server at http://localhost:${apiPort}\n\n`);
	
	if (isHeadless) {
		io?.stderr?.write("Headless environment detected. Use SSH port forwarding:\n");
		io?.stderr?.write(`  ssh -L ${webPort}:localhost:${webPort} -L ${apiPort}:localhost:${apiPort} <your-server>\n\n`);
	} else if (shouldOpen) {
		// Try to open browser
		const url = `http://localhost:${webPort}`;
		let openCmd: string;
		let openArgs: string[];
		
		if (process.platform === "darwin") {
			openCmd = "open";
			openArgs = [url];
		} else if (process.platform === "win32") {
			openCmd = "cmd";
			openArgs = ["/c", "start", url];
		} else {
			// Linux
			openCmd = "xdg-open";
			openArgs = [url];
		}
		
		try {
			spawn(openCmd, openArgs, { detached: true, stdio: "ignore" }).unref();
			io?.stderr?.write(`Opening ${url} in browser...\n`);
		} catch {
			io?.stderr?.write(`Could not open browser. Please visit ${url}\n`);
		}
	}
	
	io?.stderr?.write("Press Ctrl+C to stop\n");
	
	// Keep the process running
	await new Promise(() => {});
	
	return ok();
}
