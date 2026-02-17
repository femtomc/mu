import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { BackendRunner } from "@femtomc/mu-agent";
import { DEFAULT_OPERATOR_SYSTEM_PROMPT } from "@femtomc/mu-agent";
import type { Issue } from "@femtomc/mu-core";
import { type EventLog, FsJsonlStore, fsEventLog, getStorePaths, newRunId, readJsonl, runContext } from "@femtomc/mu-core/node";
import type { ForumTopicSummary } from "@femtomc/mu-forum";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import type { ModelOverrides } from "@femtomc/mu-orchestrator";
import { guideText } from "./guide.js";
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

type ServeActiveAdapter = {
	name: string;
	route: string;
};

type ServeServerHandle = {
	activeAdapters: readonly ServeActiveAdapter[];
	stop: () => Promise<void>;
};

type QueuedRunSnapshot = {
	job_id: string;
	root_issue_id: string | null;
	max_steps: number;
	mode?: string;
	status?: string;
	source?: string;
};

type RunHeartbeatRegistration = {
	program_id: string | null;
	created: boolean;
};

type ServeDeps = {
	startServer: (opts: { repoRoot: string; port: number }) => Promise<ServeServerHandle>;
	runOperatorSession: (opts: {
		onReady: () => void;
		provider?: string;
		model?: string;
		thinking?: string;
	}) => Promise<RunResult>;
	queueRun: (opts: {
		serverUrl: string;
		prompt: string;
		maxSteps: number;
		provider?: string;
		model?: string;
		reasoning?: string;
	}) => Promise<QueuedRunSnapshot>;
	registerRunHeartbeat: (opts: {
		serverUrl: string;
		run: QueuedRunSnapshot;
	}) => Promise<RunHeartbeatRegistration>;
	registerSignalHandler: (signal: NodeJS.Signals, handler: () => void) => () => void;
	openBrowser: (url: string) => void;
	isHeadless: () => boolean;
};

type OperatorSession = {
	subscribe: (listener: (event: any) => void) => () => void;
	prompt: (text: string, options?: { expandPromptTemplates?: boolean }) => Promise<void>;
	dispose: () => void;
	bindExtensions: (bindings: any) => Promise<void>;
	agent: { waitForIdle: () => Promise<void> };
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
	operatorSessionFactory?: (opts: {
		cwd: string;
		systemPrompt: string;
		provider?: string;
		model?: string;
		thinking?: string;
	}) => Promise<OperatorSession>;
	serveDeps?: Partial<ServeDeps>;
	serveExtensionPaths?: string[];
};

type OperatorSessionCommandOptions = {
	onInteractiveReady?: () => void;
};

type ServeLifecycleOptions = {
	commandName: "serve" | "run";
	port: number;
	noOpen: boolean;
	operatorProvider?: string;
	operatorModel?: string;
	operatorThinking?: string;
	beforeOperatorSession?: (opts: {
		serverUrl: string;
		deps: ServeDeps;
		io: CliIO | undefined;
	}) => Promise<void>;
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
	return `\n${chalk.dim("Try:")} ${recovery.map((r) => chalk.cyan(r)).join(chalk.dim(" | "))}`;
}

function jsonError(msg: string, opts: { pretty?: boolean; recovery?: readonly string[] } = {}): RunResult {
	const pretty = opts.pretty ?? false;
	if (pretty || !process.stdout.isTTY) {
		return { stdout: jsonText({ error: `${msg}` }, pretty), stderr: "", exitCode: 1 };
	}
	return { stdout: "", stderr: `${chalk.red("error:")} ${msg}${formatRecovery(opts.recovery)}\n`, exitCode: 1 };
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

function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function signalExitCode(signal: NodeJS.Signals): number {
	switch (signal) {
		case "SIGINT":
			return 130;
		case "SIGTERM":
			return 143;
		default:
			return 1;
	}
}

function delayMs(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function fileExists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

async function readServeOperatorDefaults(repoRoot: string): Promise<{ provider?: string; model?: string }> {
	const configPath = join(repoRoot, ".mu", "config.json");
	try {
		const raw = await Bun.file(configPath).text();
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const controlPlane = parsed.control_plane;
		if (!controlPlane || typeof controlPlane !== "object" || Array.isArray(controlPlane)) {
			return {};
		}
		const operator = (controlPlane as Record<string, unknown>).operator;
		if (!operator || typeof operator !== "object" || Array.isArray(operator)) {
			return {};
		}
		const operatorObj = operator as Record<string, unknown>;
		return {
			provider: nonEmptyString(operatorObj.provider),
			model: nonEmptyString(operatorObj.model),
		};
	} catch {
		return {};
	}
}

async function ensureCtx(cwd: string): Promise<CliCtx> {
	const repoRoot = await findRepoRoot(cwd);
	const paths = getStorePaths(repoRoot);
	const events = fsEventLog(paths.eventsPath);
	const store = new IssueStore(new FsJsonlStore(paths.issuesPath), { events });
	const forum = new ForumStore(new FsJsonlStore(paths.forumPath), { events });
	return { cwd, repoRoot, store, forum, events, paths };
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
	try {
		await writeFile(path, content, { encoding: "utf8", flag: "wx" });
	} catch (err: unknown) {
		if (typeof err !== "object" || err == null || !("code" in err) || (err as { code?: string }).code !== "EEXIST") {
			throw err;
		}
	}
}

async function ensureStoreInitialized(ctx: Pick<CliCtx, "paths">): Promise<void> {
	await mkdir(ctx.paths.storeDir, { recursive: true });
	await writeFile(ctx.paths.issuesPath, "", { encoding: "utf8", flag: "a" });
	await writeFile(ctx.paths.forumPath, "", { encoding: "utf8", flag: "a" });
	await writeFile(ctx.paths.eventsPath, "", { encoding: "utf8", flag: "a" });
	await mkdir(ctx.paths.logsDir, { recursive: true });

	await writeFileIfMissing(
		join(ctx.paths.storeDir, ".gitignore"),
		[
			"# Auto-generated by mu. Keep .mu runtime state local.",
			"# Includes logs, config, event history, and any local secrets.",
			"*",
			"!.gitignore",
			"",
		].join("\n"),
	);

}

async function findRepoRoot(start: string): Promise<string> {
	let current = resolve(start);
	while (true) {
		if ((await fileExists(join(current, ".git", "HEAD"))) || (await fileExists(join(current, ".git")))) {
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
	const cmd = (s: string) => chalk.cyan(s);
	const dim = (s: string) => chalk.dim(s);
	const h = (s: string) => chalk.bold(s);
	return [
		`${chalk.bold.magenta("mu")} ${dim("— personal agent for technical work")}`,
		"",
		`${h("Usage:")}  mu ${dim("<command> [args...]")}`,
		"",
		h("Getting started:"),
		`  ${dim("1)")} mu run ${dim('"Break down and execute this goal"')}`,
		`  ${dim("2)")} mu status`,
		`  ${dim("3)")} mu issues ready --root ${dim("<root-id>")}`,
		"",
		h("Commands:"),
		`  ${cmd("guide")}                                 ${dim("In-CLI guide")}`,
		`  ${cmd("status")} ${dim("[--json] [--pretty]")}            Show repo and work status`,
		`  ${cmd("store")} ${dim("<subcmd>")}                        Inspect .mu store files and logs`,
		`  ${cmd("issues")} ${dim("<subcmd>")}                       Work item commands`,
		`  ${cmd("forum")} ${dim("<subcmd>")}                        Coordination message commands`,
		`  ${cmd("run")} ${dim("<prompt...>")}                       Queue a run and attach operator session`,
		`  ${cmd("resume")} ${dim("<root-id>")}                      Resume a run`,
		`  ${cmd("chat")} ${dim("[--message TEXT]")}                 Interactive operator session`,
		`  ${cmd("login")} ${dim("[<provider>] [--list]")}           Authenticate with an AI provider`,
		`  ${cmd("replay")} ${dim("<id|path>")}                      Replay a previous run log`,
		`  ${cmd("control")} ${dim("<subcmd>")}                      Messaging integrations and identity`,
		`  ${cmd("serve")} ${dim("[--port N] [--no-open]")}          Start API + web UI + operator session`,
		"",
		`${dim("Running")} ${cmd("mu")} ${dim("with no arguments starts")} ${cmd("mu serve")}${dim(".")}`,
		`${dim("Run")} ${cmd("mu guide")} ${dim("for the full in-CLI guide.")}`,
	].join("\n");
}

export async function run(
	argv: string[],
	opts: {
		cwd?: string;
		io?: CliIO;
		backend?: BackendRunner;
		operatorSessionFactory?: CliCtx["operatorSessionFactory"];
		serveDeps?: Partial<ServeDeps>;
	} = {},
): Promise<RunResult> {
	const cwd = opts.cwd ?? process.cwd();

	if (argv[0] === "--help" || argv[0] === "-h") {
		return ok(`${mainHelp()}\n`);
	}
	if (argv.length === 0) {
		const ctx0 = await ensureCtx(cwd);
		const ctx: CliCtx = {
			...ctx0,
			io: opts.io,
			backend: opts.backend,
			operatorSessionFactory: opts.operatorSessionFactory,
			serveDeps: opts.serveDeps,
		};
		return await cmdServe([], ctx);
	}
	if (argv.includes("--version")) {
		const pkgPath = join(dirname(new URL(import.meta.url).pathname), "..", "package.json");
		const { version } = JSON.parse(await Bun.file(pkgPath).text()) as { version: string };
		return ok(`${chalk.bold.magenta("mu")} ${chalk.dim(version)}\n`);
	}

	const cmd = argv[0]!;
	const rest = argv.slice(1);
	const ctx0 = await ensureCtx(cwd);
	const ctx: CliCtx = {
		...ctx0,
		io: opts.io,
		backend: opts.backend,
		operatorSessionFactory: opts.operatorSessionFactory,
		serveDeps: opts.serveDeps,
	};

	switch (cmd) {
		case "guide":
			return await cmdGuide(rest);
		case "init":
			return jsonError("`mu init` has been removed. mu now auto-initializes `.mu/` on `mu run` and `mu serve`.", {
				recovery: ['mu run "Break down and execute this goal"', "mu serve", "mu --help"],
			});
		case "status":
			return await cmdStatus(rest, ctx);
		case "store":
			return await cmdStore(rest, ctx);
		case "issues":
			return await cmdIssues(rest, ctx);
		case "forum":
			return await cmdForum(rest, ctx);
		case "run":
			return await cmdRun(rest, ctx);
		case "_run-direct":
			return await cmdRunDirect(rest, ctx);
		case "resume":
			return await cmdResume(rest, ctx);
		case "chat": {
			const { operatorExtensionPaths } = await import("@femtomc/mu-agent");
			return await cmdOperatorSession(rest, {
				...ctx,
				serveExtensionPaths: ctx.serveExtensionPaths ?? operatorExtensionPaths,
			});
		}
		case "login":
			return await cmdLogin(rest);
		case "replay":
			return await cmdReplay(rest, ctx);
		case "control":
			return await cmdControl(rest, ctx);
		case "serve":
			return await cmdServe(rest, ctx);
		default:
			return jsonError(`unknown command: ${cmd}`, {
				recovery: ["mu --help"],
			});
	}
}

async function cmdGuide(argv: string[]): Promise<RunResult> {
	if (argv.length > 0 && !hasHelpFlag(argv)) {
		return jsonError(`unknown args: ${argv.join(" ")}`, { recovery: ["mu guide"] });
	}
	return ok(`${guideText()}\n`);
}

async function cmdStatus(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu status - show repo + DAG status",
				"",
				"Usage:",
				"  mu status [--json] [--pretty]",
				"",
				"Options:",
				"  --json      Emit machine-readable status payload",
				"  --pretty    Pretty-print JSON output (when combined with --json)",
				"",
				"Includes:",
				"  repo root, root issue count, open issue count, ready issue sample, recent issue topics",
				"",
				"Examples:",
				"  mu status",
				"  mu status --json --pretty",
				"  mu issues ready --root <root-id>",
				"",
				"If counts look wrong, run `mu issues list --limit 20` and `mu forum topics --prefix issue:`.",
			].join("\n") + "\n",
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

	const label = (s: string) => chalk.bold(s);
	const val = (s: string | number) => chalk.cyan(String(s));
	const dim = (s: string) => chalk.dim(s);

	let out = `${label("Repo:")} ${val(ctx.repoRoot)}\n`;
	out += `${label("Root issues:")} ${val(roots.length)}  ${label("Open:")} ${val(openIssues.length)}  ${label("Ready:")} ${val(ready.length)}\n`;

	if (ready.length > 0) {
		out += `\n${label("Ready:")}\n`;
		for (const issue of ready.slice(0, 10)) {
			out += `  ${chalk.yellow(issue.id)} ${dim(`[p=${issue.priority ?? 3}]`)} ${String(issue.title ?? "").slice(0, 80)}\n`;
		}
	}

	if (topics.length > 0) {
		out += `\n${label("Recent issue topics:")}\n`;
		for (const topic of topics.slice(0, 10)) {
			out += `  ${chalk.yellow(topic.topic)} ${dim(`(${topic.messages})`)} ${dim(`last_at=${topic.last_at}`)}\n`;
		}
	}

	return ok(out);
}

type StoreTargetInfo = {
	key: string;
	path: string;
	description: string;
};

async function listStoreTargets(ctx: CliCtx): Promise<StoreTargetInfo[]> {
	const { getControlPlanePaths } = await import("@femtomc/mu-control-plane");
	const cp = getControlPlanePaths(ctx.repoRoot);
	return [
		{ key: "store", path: ctx.paths.storeDir, description: "Store root directory" },
		{ key: "issues", path: ctx.paths.issuesPath, description: "Issue DAG nodes (JSONL)" },
		{ key: "forum", path: ctx.paths.forumPath, description: "Forum messages (JSONL)" },
		{ key: "events", path: ctx.paths.eventsPath, description: "Event log (JSONL)" },
		{ key: "logs", path: ctx.paths.logsDir, description: "Run logs directory" },
		{ key: "config", path: join(ctx.paths.storeDir, "config.json"), description: "CLI/server config" },
		{ key: "heartbeats", path: join(ctx.paths.storeDir, "heartbeats.jsonl"), description: "Heartbeat programs" },
		{ key: "cp", path: cp.controlPlaneDir, description: "Control-plane state directory" },
		{ key: "cp_identities", path: cp.identitiesPath, description: "Linked identities" },
		{ key: "cp_commands", path: cp.commandsPath, description: "Command lifecycle journal" },
		{ key: "cp_outbox", path: cp.outboxPath, description: "Outbound delivery queue" },
		{ key: "cp_policy", path: cp.policyPath, description: "Control-plane policy" },
		{ key: "cp_adapter_audit", path: cp.adapterAuditPath, description: "Adapter ingress audit" },
		{ key: "cp_operator_turns", path: join(cp.controlPlaneDir, "operator_turns.jsonl"), description: "Operator turn audit" },
		{ key: "cp_telegram_ingress", path: join(cp.controlPlaneDir, "telegram_ingress.jsonl"), description: "Deferred Telegram ingress queue" },
	];
}

async function inspectPath(path: string): Promise<{
	exists: boolean;
	type: "file" | "directory" | "other" | "missing";
	size_bytes: number | null;
}> {
	const file = Bun.file(path);
	const exists = await file.exists();
	if (!exists) {
		return { exists: false, type: "missing", size_bytes: null };
	}
	try {
		const st = await file.stat();
		if (st.isDirectory()) {
			return { exists: true, type: "directory", size_bytes: st.size };
		}
		if (st.isFile()) {
			return { exists: true, type: "file", size_bytes: st.size };
		}
		return { exists: true, type: "other", size_bytes: st.size };
	} catch {
		return { exists: true, type: "other", size_bytes: null };
	}
}

async function cmdStore(argv: string[], ctx: CliCtx): Promise<RunResult> {
	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
	if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
		return ok(
			[
				"mu store - inspect .mu store files and logs",
				"",
				"Usage:",
				"  mu store <command> [args...] [--pretty]",
				"",
				"Commands:",
				"  paths                         Show canonical .mu paths and existence",
				"  ls                            Summarize known .mu files",
				"  tail <target> [--limit N]     Show recent entries from a .mu file",
				"",
				"Examples:",
				"  mu store paths",
				"  mu store ls --pretty",
				"  mu store tail events --limit 20",
				"  mu store tail cp_operator_turns --limit 30 --json --pretty",
				"",
				"Targets (for tail): issues, forum, events, cp_commands, cp_outbox, cp_identities,",
				"cp_operator_turns, cp_telegram_ingress, or explicit paths under .mu/",
			].join("\n") + "\n",
		);
	}

	const sub = argv0[0]!;
	const rest = argv0.slice(1);
	switch (sub) {
		case "paths":
			return await storePaths(rest, ctx, pretty);
		case "ls":
			return await storeLs(rest, ctx, pretty);
		case "tail":
			return await storeTail(rest, ctx, pretty);
		default:
			return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu store --help"] });
	}
}

async function storePaths(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu store paths - list canonical .mu paths",
				"",
				"Usage:",
				"  mu store paths [--json] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const { present: jsonMode, rest } = popFlag(argv, "--json");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu store paths --help"] });
	}

	const targets = await listStoreTargets(ctx);
	const rows = [] as Array<Record<string, unknown>>;
	for (const t of targets) {
		const stat = await inspectPath(t.path);
		rows.push({
			key: t.key,
			path: t.path,
			rel_path: relative(ctx.repoRoot, t.path).replaceAll("\\", "/"),
			description: t.description,
			exists: stat.exists,
			type: stat.type,
			size_bytes: stat.size_bytes,
		});
	}

	const payload = {
		repo_root: ctx.repoRoot,
		store_dir: ctx.paths.storeDir,
		targets: rows,
	};
	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}

	let out = `.mu paths for ${ctx.repoRoot}\n`;
	for (const row of rows) {
		const key = String(row.key).padEnd(20);
		const status = row.exists ? String(row.type) : "missing";
		const relPath = String(row.rel_path);
		out += `  ${key} ${status.padEnd(10)} ${relPath}\n`;
	}
	return ok(out);
}

async function storeLs(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu store ls - summarize known .mu files",
				"",
				"Usage:",
				"  mu store ls [--all] [--json] [--pretty]",
				"",
				"By default only existing paths are shown. Use --all to include missing.",
			].join("\n") + "\n",
		);
	}

	const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
	const { present: includeAll, rest } = popFlag(argv0, "--all");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu store ls --help"] });
	}

	const targets = await listStoreTargets(ctx);
	const rows: Array<Record<string, unknown>> = [];
	for (const t of targets) {
		const stat = await inspectPath(t.path);
		if (!includeAll && !stat.exists) {
			continue;
		}
		let entries: number | null = null;
		if (stat.exists && stat.type === "file" && t.path.endsWith(".jsonl")) {
			try {
				entries = (await readJsonl(t.path)).length;
			} catch {
				entries = null;
			}
		}
		rows.push({
			key: t.key,
			rel_path: relative(ctx.repoRoot, t.path).replaceAll("\\", "/"),
			exists: stat.exists,
			type: stat.type,
			size_bytes: stat.size_bytes,
			entries,
			description: t.description,
		});
	}

	const payload = {
		repo_root: ctx.repoRoot,
		count: rows.length,
		files: rows,
	};
	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}

	let out = `.mu summary (${rows.length} item${rows.length === 1 ? "" : "s"})\n`;
	for (const row of rows) {
		const key = String(row.key).padEnd(20);
		const kind = String(row.type).padEnd(10);
		const size = row.size_bytes == null ? "-" : `${row.size_bytes}b`;
		const entries = row.entries == null ? "" : ` entries=${row.entries}`;
		out += `  ${key} ${kind} ${String(row.rel_path)} size=${size}${entries}\n`;
	}
	return ok(out);
}

async function storeTail(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu store tail - show recent entries from a .mu file",
				"",
				"Usage:",
				"  mu store tail <target> [--limit N] [--json] [--pretty]",
				"",
				"Examples:",
				"  mu store tail events --limit 20",
				"  mu store tail cp_commands --limit 50 --json --pretty",
			].join("\n") + "\n",
		);
	}

	const targetRaw = argv[0]!;
	const { value: limitRaw, rest: argv0 } = getFlagValue(argv.slice(1), "--limit");
	const { present: jsonMode, rest } = popFlag(argv0, "--json");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu store tail --help"] });
	}

	const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 2000 }) : 20;
	if (limit == null) {
		return jsonError("limit must be an integer between 1 and 2000", {
			pretty,
			recovery: ["mu store tail events --limit 20"],
		});
	}

	const targets = await listStoreTargets(ctx);
	const byKey = new Map(targets.map((t) => [t.key, t.path] as const));
	const targetPath = byKey.get(targetRaw) ?? resolve(ctx.cwd, targetRaw);
	const storeDirAbs = resolve(ctx.paths.storeDir);
	const targetAbs = resolve(targetPath);
	if (targetAbs !== storeDirAbs && !targetAbs.startsWith(`${storeDirAbs}/`)) {
		return jsonError(`target must be inside .mu/: ${targetRaw}`, {
			pretty,
			recovery: ["mu store paths", "mu store tail events --limit 20"],
		});
	}

	if (!(await fileExists(targetAbs))) {
		return jsonError(`target not found: ${targetRaw}`, { pretty, recovery: ["mu store ls --all --pretty"] });
	}

	const stat = await inspectPath(targetAbs);
	if (stat.type === "directory") {
		return jsonError(`target is a directory: ${targetRaw}`, {
			pretty,
			recovery: ["mu store ls --pretty", "mu store tail events --limit 20"],
		});
	}

	if (targetAbs.endsWith(".jsonl")) {
		const rows = await readJsonl(targetAbs);
		const tailRows = rows.slice(-limit);
		const payload = {
			target: targetRaw,
			path: targetAbs,
			total: rows.length,
			returned: tailRows.length,
			entries: tailRows,
		};
		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}
		const rendered = tailRows.map((row) => JSON.stringify(row)).join("\n");
		return ok(rendered.length > 0 ? `${rendered}\n` : "");
	}

	const text = await Bun.file(targetAbs).text();
	const lines = text.split(/\r?\n/);
	const normalized = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
	const tailLines = normalized.slice(-limit);
	const payload = {
		target: targetRaw,
		path: targetAbs,
		total: normalized.length,
		returned: tailLines.length,
		lines: tailLines,
	};
	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}
	return ok(tailLines.length > 0 ? `${tailLines.join("\n")}\n` : "");
}

async function cmdIssues(argv: string[], ctx: CliCtx): Promise<RunResult> {
	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

	if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
		return ok(
			[
				"mu issues - work item lifecycle commands (JSON output)",
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

async function issuesList(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues list - list issues with optional filters",
				"",
				"Usage:",
				"  mu issues list [--status STATUS] [--tag TAG] [--root ID] [--limit N] [--pretty]",
				"",
				"Filters:",
				"  --status <open|in_progress|closed>   Filter by status",
				"  --tag <TAG>                          Repeatable; issue must contain all tags",
				"  --root <id-or-prefix>                Restrict to a root issue subtree",
				"  --limit <N>                          Return only the newest N entries (0 = unlimited)",
				"",
				"Examples:",
				"  mu issues list",
				"  mu issues list --status open --limit 20",
				"  mu issues list --root mu-abc123 --tag role:worker",
				"  mu issues list --tag node:agent --tag role:orchestrator --pretty",
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
			[
				"mu issues get - fetch a single issue",
				"",
				"Usage:",
				"  mu issues get <id-or-prefix> [--pretty]",
				"",
				"Notes:",
				"  Accepts full issue id or a unique prefix.",
				"  If prefix is ambiguous, mu returns candidate ids.",
				"",
				"Examples:",
				"  mu issues get mu-459fd648",
				"  mu issues get mu-459f --pretty",
				"",
				"Troubleshooting:",
				"  mu issues list --limit 20",
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

	return ok(jsonText(issueJson(issue), pretty));
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
				"mu issues create - create a new issue (auto-adds node:agent tag)",
				"",
				"Usage:",
				"  mu issues create <title> [--body TEXT] [--parent ID] [--tag TAG] [--role ROLE] [--priority N] [--pretty]",
				"",
				"Options:",
				"  --body, -b <TEXT>                   Optional issue body",
				"  --parent <id-or-prefix>             Add <new-issue> parent <parent> edge",
				"  --tag, -t <TAG>                     Repeatable custom tags",
				"  --role, -r <orchestrator|worker>    Adds role:<role> tag",
				"  --priority, -p <1..5>               Priority (1 highest urgency, default 3)",
				"  --pretty                            Pretty-print JSON result",
				"",
				"Examples:",
				'  mu issues create "Root planning issue" --tag node:root --role orchestrator',
				'  mu issues create "Implement parser" --parent <root-id> --role worker --priority 2',
				'  mu issues create "Write tests" -b "Cover error paths" -t area:test',
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

	return ok(jsonText(issueJson(issue), pretty));
}

async function issuesUpdate(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu issues update - patch issue fields and routing metadata",
				"",
				"Usage:",
				"  mu issues update <id-or-prefix> [--title TEXT] [--body TEXT] [--status STATUS] [--outcome OUTCOME] [--priority N] [--add-tag TAG] [--remove-tag TAG] [--role ROLE] [--pretty]",
				"",
				"Options:",
				"  --title <TEXT>                       Replace title",
				"  --body <TEXT>                        Replace body",
				"  --status <open|in_progress|closed>   Set status",
				"  --outcome <OUTCOME>                  Set close outcome",
				"  --priority <1..5>                    Set priority",
				"  --add-tag <TAG>                      Repeatable",
				"  --remove-tag <TAG>                   Repeatable",
				"  --role <orchestrator|worker>         Rewrites role:* tag",
				"",
				"Examples:",
				"  mu issues update <id> --status in_progress",
				"  mu issues update <id> --add-tag blocked --remove-tag triage",
				"  mu issues update <id> --role worker --priority 2",
				"  mu issues update <id> --status closed --outcome success",
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
	const { values: addTags, rest: argv5 } = getRepeatFlagValues(argv4, ["--add-tag"]);
	const { values: removeTags, rest: argv6 } = getRepeatFlagValues(argv5, ["--remove-tag"]);

	const { value: role, rest } = getFlagValue(argv6, "--role");

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
				"",
				"Examples:",
				"  mu issues open <id>",
				"  mu issues open <id> --pretty",
				"",
				"Sets status=open and outcome=null.",
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
				"",
				"Options:",
				"  --outcome <success|failure|needs_work|expanded|skipped>",
				"            Default: success",
				"",
				"Examples:",
				"  mu issues close <id>",
				"  mu issues close <id> --outcome success",
				"  mu issues close <id> --outcome needs_work",
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
				"",
				"Edge types:",
				"  <src> blocks <dst>     <dst> waits until <src> is closed",
				"  <child> parent <root>  Attach child to parent/root tree",
				"",
				"Examples:",
				"  mu issues dep <task-a> blocks <task-b>",
				"  mu issues dep <child> parent <root>",
				"",
				"Tip: use `mu issues children <root>` and `mu issues ready --root <root>` to verify scheduling.",
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
				"",
				"Examples:",
				"  mu issues undep <task-a> blocks <task-b>",
				"  mu issues undep <child> parent <root>",
				"",
				"Use this when dependency planning changes.",
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
				"",
				"Examples:",
				"  mu issues children <root-id>",
				"  mu issues children <root-id> --pretty",
				"",
				"Shows only direct children (not full descendants).",
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
				"",
				"Filters:",
				"  --root <id-or-prefix>   Restrict to one root subtree",
				"  --tag <TAG>             Repeatable extra tags (node:agent is always required)",
				"",
				"Examples:",
				"  mu issues ready",
				"  mu issues ready --root <root-id>",
				"  mu issues ready --root <root-id> --tag role:worker",
				"  mu issues ready --tag role:orchestrator",
				"",
				"Ready means:",
				"  status=open + all blockers closed + no open children + tags match.",
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

async function cmdForum(argv: string[], ctx: CliCtx): Promise<RunResult> {
	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

	if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
		return ok(
			[
				"mu forum - append-only coordination messages (JSON output)",
				"",
				"Usage:",
				"  mu forum <command> [args...] [--pretty]",
				"",
				"Commands:",
				"  post     Add a message to a topic",
				"  read     Read recent messages in one topic",
				"  topics   List topics by recency",
				"",
				"Common topic patterns:",
				"  issue:<id>                 Per-issue execution log",
				"  user:context:<session>     User/session context",
				"  research:<project>:<topic> Research notes",
				"",
				"Daily worker usage:",
				'  mu forum post issue:<id> -m "claimed, starting implementation" --author worker',
				'  mu forum post issue:<id> -m "tests passing, closing" --author worker',
				"  mu forum read issue:<id> --limit 20",
				"",
				"Discover active issue threads:",
				"  mu forum topics --prefix issue: --limit 20",
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
				"",
				"Options:",
				"  -m, --message <TEXT>   Required message body",
				"  --author <NAME>        Author label (default: system)",
				"",
				"Examples:",
				'  mu forum post issue:<id> -m "claimed and starting" --author worker',
				'  mu forum post issue:<id> -m "blocked on env setup" --author worker',
				'  mu forum post research:mu:help-audit -m "notes" --author orchestrator',
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
				"",
				"Options:",
				"  --limit <N>    Number of messages to return (default: 50)",
				"",
				"Examples:",
				"  mu forum read issue:<id>",
				"  mu forum read issue:<id> --limit 20",
				"  mu forum read research:mu:help-audit --pretty",
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
				"",
				"Options:",
				"  --prefix <PREFIX>   Restrict topics by prefix (e.g. issue:, research:)",
				"  --limit <N>         Max topics returned (default: 100)",
				"",
				"Examples:",
				"  mu forum topics",
				"  mu forum topics --prefix issue:",
				"  mu forum topics --prefix issue: --limit 20 --pretty",
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
				"mu run - start mu serve, queue a run, register heartbeat, and attach operator terminal",
				"",
				"Usage:",
				"  mu run <prompt...> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--port N] [--no-open]",
				"",
				"Run queue options:",
				"  --max-steps <N>    Max DAG steps for the queued run (default: 20)",
				"  --provider <id>    Provider intent for queued run + operator session",
				"  --model <id>       Model intent for queued run + operator session",
				"  --reasoning <lvl>  Thinking intent (queued run request + operator session)",
				"",
				"Serve passthrough:",
				"  --port <N>         Server port (default: 3000)",
				"  --no-open          Don't open browser automatically",
				"",
				"Legacy note:",
				"  --json and --raw-stream are no longer supported on mu run.",
				"  Use `mu serve` + /api/runs/* for machine integration, or `mu resume --json` for direct run state.",
				"",
				"See also: `mu serve --help`, `mu guide`",
			].join("\n") + "\n",
		);
	}

	let maxSteps = 20;
	let port = 3000;
	let noOpen = false;
	let modelFlag: string | undefined;
	let providerFlag: string | undefined;
	let reasoningFlag: string | undefined;
	const promptParts: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--") {
			promptParts.push(...argv.slice(i + 1));
			break;
		}
		if (a === "--json") {
			return jsonError(
				"`mu run --json` has been removed. Use `mu serve` + /api/runs/* for machine integration, or `mu resume <root-id> --json` for direct run output.",
				{
					recovery: [
						"mu run \"Break down and execute this goal\"",
						"mu serve --help",
						"mu resume <root-id> --json",
					],
				},
			);
		}
		if (a === "--raw-stream") {
			return jsonError(
				"`mu run --raw-stream` has been removed. Use `mu serve` + /api/runs/* for queued runs, or `mu resume <root-id> --raw-stream` for direct runner streaming.",
				{
					recovery: [
						"mu run \"Break down and execute this goal\"",
						"mu serve --help",
						"mu resume <root-id> --raw-stream",
					],
				},
			);
		}
		if (a === "--no-open") {
			noOpen = true;
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
		if (a === "--port") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --port", { recovery: ["mu run --port 3000 \"...\""] });
			}
			const p = ensureInt(next, { name: "--port", min: 1, max: 65535 });
			if (p == null) {
				return jsonError("port must be 1-65535", { recovery: ["mu run --port 3000 \"...\""] });
			}
			port = p;
			i += 1;
			continue;
		}
		if (a.startsWith("--port=")) {
			const p = ensureInt(a.slice("--port=".length), { name: "--port", min: 1, max: 65535 });
			if (p == null) {
				return jsonError("port must be 1-65535", { recovery: ["mu run --port 3000 \"...\""] });
			}
			port = p;
			continue;
		}
		if (a === "--model") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --model", { recovery: ['mu run "..." --model gpt-5.3-codex'] });
			}
			modelFlag = next;
			i += 1;
			continue;
		}
		if (a.startsWith("--model=")) {
			modelFlag = a.slice("--model=".length);
			continue;
		}
		if (a === "--provider") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --provider", { recovery: ['mu run "..." --provider openai-codex'] });
			}
			providerFlag = next;
			i += 1;
			continue;
		}
		if (a.startsWith("--provider=")) {
			providerFlag = a.slice("--provider=".length);
			continue;
		}
		if (a === "--reasoning") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --reasoning", {
					recovery: ['mu run "..." --reasoning high'],
				});
			}
			reasoningFlag = next;
			i += 1;
			continue;
		}
		if (a.startsWith("--reasoning=")) {
			reasoningFlag = a.slice("--reasoning=".length);
			continue;
		}
		if (a.startsWith("-")) {
			return jsonError(`unknown arg: ${a}`, {
				recovery: ["mu run --help", 'mu run "Break down and execute this goal"'],
			});
		}
		promptParts.push(a);
	}

	for (const [flagName, rawValue] of [
		["--provider", providerFlag],
		["--model", modelFlag],
		["--reasoning", reasoningFlag],
	] as const) {
		if (rawValue != null && rawValue.trim().length === 0) {
			return jsonError(`missing value for ${flagName}`, { recovery: ["mu run --help"] });
		}
	}

	const promptText = promptParts.join(" ").trim();
	if (!promptText) {
		return jsonError("missing prompt", { recovery: ['mu run "Break down and execute this goal"'] });
	}

	const provider = providerFlag?.trim() || undefined;
	const model = modelFlag?.trim() || undefined;
	const reasoning = reasoningFlag?.trim() || undefined;

	return await runServeLifecycle(ctx, {
		commandName: "run",
		port,
		noOpen,
		operatorProvider: provider,
		operatorModel: model,
		operatorThinking: reasoning,
		beforeOperatorSession: async ({ serverUrl, deps, io }) => {
			const queued = await deps.queueRun({
				serverUrl,
				prompt: promptText,
				maxSteps,
				provider,
				model,
				reasoning,
			});
			const rootText = queued.root_issue_id ? ` root=${queued.root_issue_id}` : "";
			io?.stderr?.write(`Queued run: ${queued.job_id}${rootText} max_steps=${queued.max_steps}\n`);

			const heartbeat = await deps.registerRunHeartbeat({ serverUrl, run: queued });
			const action = heartbeat.created ? "registered" : "confirmed";
			const idSuffix = heartbeat.program_id ? ` (${heartbeat.program_id})` : "";
			io?.stderr?.write(`Run heartbeat: ${action}${idSuffix}\n`);
		},
	});
}

async function cmdRunDirect(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu run - create a root work item and start execution",
				"",
				"Usage:",
				"  mu run <prompt...> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--raw-stream] [--json]",
				"",
				"Model flags:",
				"  --model <id>        Model ID (e.g. gpt-5.3-codex, claude-opus-4-6)",
				"  --provider <id>     Provider (e.g. anthropic, openai-codex)",
				"  --reasoning <lvl>   Thinking level (minimal|low|medium|high|xhigh)",
				"",
				"See also: `mu guide`",
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

	await ensureStoreInitialized(ctx);

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
	const pretty = rawStream || !usePretty ? null : new PiPrettyStreamRenderer({ color: Bun.env.NO_COLOR == null });
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
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot, {
			backend: ctx.backend,
			events: ctx.events,
			modelOverrides,
		});
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
					`  mu replay ${rootIssue.id}/${replayId}`,
					`  logs: ${logsRel}/${rootIssue.id}/${replayId}*.jsonl`,
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
		out += `  mu replay ${rootIssue.id}/${replayId}\n`;
		out += `  logs: ${logsRel}/${rootIssue.id}/${replayId}*.jsonl\n`;
		out += `  resume: mu resume ${rootIssue.id} --max-steps ${maxSteps}\n`;
	}
	return { stdout: out, stderr: "", exitCode };
}

async function cmdResume(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu resume - resume an interrupted run",
				"",
				"Usage:",
				"  mu resume <root-id> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--raw-stream] [--json]",
				"",
				"Model flags:",
				"  --model <id>        Model ID (e.g. gpt-5.3-codex, claude-opus-4-6)",
				"  --provider <id>     Provider (e.g. anthropic, openai-codex)",
				"  --reasoning <lvl>   Thinking level (minimal|low|medium|high|xhigh)",
				"",
				"See also: `mu guide`",
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

	await ensureStoreInitialized(ctx);

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
	const pretty = rawStream || !usePretty ? null : new PiPrettyStreamRenderer({ color: Bun.env.NO_COLOR == null });
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
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot, {
			backend: ctx.backend,
			events: ctx.events,
			modelOverrides,
		});
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
					`  mu replay ${rootId}/${replayId}`,
					`  logs: ${logsRel}/${rootId}/${replayId}*.jsonl`,
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
		out += `  mu replay ${rootId}/${replayId}\n`;
		out += `  logs: ${logsRel}/${rootId}/${replayId}*.jsonl\n`;
		out += `  resume: mu resume ${rootId} --max-steps ${maxSteps}\n`;
	}
	return { stdout: out, stderr: "", exitCode };
}

async function cmdReplay(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu replay - replay a logged run",
				"",
				"Usage:",
				"  mu replay <issue-id|path> [--backend pi]",
				"",
				"See also: `mu guide`",
			].join("\n") + "\n",
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
	if (!(await fileExists(path))) {
		// Search in subdirectories organized by root issue ID
		const allMatches: { rootId: string; filename: string; fullPath: string }[] = [];

		try {
			// First check if target is a direct path within a root directory
			const parts = target.split("/");
			if (parts.length === 2) {
				const [rootId, filename] = parts;
				const candidate = join(logsDir, rootId, filename.endsWith(".jsonl") ? filename : `${filename}.jsonl`);
				if (await fileExists(candidate)) {
					path = candidate;
				}
			}

			// If not found, search all root directories
			if (!path || !(await fileExists(path))) {
				const rootDirs = await readdir(logsDir);

				for (const rootId of rootDirs) {
					const rootPath = join(logsDir, rootId);
					const stat = await Bun.file(rootPath).stat();
					if (!stat.isDirectory()) continue;

					const files = await readdir(rootPath);
					// Exact match
					if (files.includes(`${target}.jsonl`)) {
						allMatches.push({ rootId, filename: `${target}.jsonl`, fullPath: join(rootPath, `${target}.jsonl`) });
					}
					// Prefix match
					const prefixMatches = files.filter((f) => f.startsWith(target) && f.endsWith(".jsonl"));
					for (const match of prefixMatches) {
						allMatches.push({ rootId, filename: match, fullPath: join(rootPath, match) });
					}
				}
			}
		} catch {
			// Ignore errors reading directories
		}

		if (allMatches.length === 1) {
			path = allMatches[0]!.fullPath;
		} else if (allMatches.length > 1) {
			return jsonError(`ambiguous prefix '${target}'`, {
				recovery: allMatches
					.slice(0, 10)
					.map((m) => `mu replay ${m.rootId}/${m.filename.replace(/\\.jsonl$/, "")}`),
			});
		} else if (!path || !(await fileExists(path))) {
			return jsonError(`log not found: ${target}`, { recovery: ["mu status", "ls .mu/logs/*"] });
		}
	}

	const text = await Bun.file(path).text();
	return ok(text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text);
}

async function cmdOperatorSession(
	argv: string[],
	ctx: CliCtx,
	options: OperatorSessionCommandOptions = {},
): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu chat - interactive operator session",
				"",
				"Usage:",
				"  mu chat [--message TEXT] [--json]",
				"          [--provider ID] [--model ID] [--thinking LEVEL]",
				"          [--system-prompt TEXT]",
				"",
				"Options:",
				"  --message, -m TEXT     One-shot mode (send a single message and exit)",
				"  --json                 Emit JSON event stream (requires --message)",
				"  --provider ID          LLM provider",
				"  --model ID             Model ID (default: gpt-5.3-codex)",
				"  --thinking LEVEL       Thinking level (minimal|low|medium|high)",
				"  --system-prompt TEXT   Override system prompt",
				"",
				"Examples:",
				"  mu chat",
				'  mu chat --message "What does mu status show right now?"',
				'  mu chat --message "How do I set up Slack control-plane webhooks?"',
				"",
				"See also: `mu guide`, `mu control status`, `mu serve --help`",
			].join("\n") + "\n",
		);
	}

	const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
	const { value: messageLong, rest: argv1 } = getFlagValue(argv0, "--message");
	const { value: messageShort, rest: argv2 } = getFlagValue(argv1, "-m");
	const { value: providerRaw, rest: argv3 } = getFlagValue(argv2, "--provider");
	const { value: modelRaw, rest: argv4 } = getFlagValue(argv3, "--model");
	const { value: thinkingRaw, rest: argv5 } = getFlagValue(argv4, "--thinking");
	const { value: systemPromptRaw, rest } = getFlagValue(argv5, "--system-prompt");

	for (const [flagName, rawValue] of [
		["--message", messageLong],
		["-m", messageShort],
		["--provider", providerRaw],
		["--model", modelRaw],
		["--thinking", thinkingRaw],
		["--system-prompt", systemPromptRaw],
	] as const) {
		if (rawValue === "") {
			return jsonError(`missing value for ${flagName}`, {
				recovery: ["mu chat --help"],
			});
		}
	}

	let message = messageLong ?? messageShort;
	if (message != null && message.trim().length === 0) {
		return jsonError("message must not be empty", {
			recovery: ['mu chat --message "What is ready?"'],
		});
	}

	if (rest.length > 0) {
		if (rest.some((arg) => arg.startsWith("-"))) {
			return jsonError(`unknown args: ${rest.join(" ")}`, {
				recovery: ["mu chat --help"],
			});
		}
		const positionalMessage = rest.join(" ").trim();
		if (positionalMessage.length > 0) {
			if (message != null) {
				return jsonError("provide either --message/-m or positional text, not both", {
					recovery: ["mu chat --help"],
				});
			}
			message = positionalMessage;
		}
	}

	if (jsonMode && message == null) {
		return jsonError("--json requires --message", {
			recovery: ['mu chat --message "What is ready?" --json'],
		});
	}

	const provider = providerRaw?.trim() || undefined;
	const model = modelRaw?.trim() || undefined;
	const thinking = thinkingRaw?.trim() || undefined;
	const systemPrompt = systemPromptRaw?.trim() || DEFAULT_OPERATOR_SYSTEM_PROMPT;

	const createOperatorSession = async (): Promise<OperatorSession> => {
		if (ctx.operatorSessionFactory) {
			return ctx.operatorSessionFactory({ cwd: ctx.repoRoot, systemPrompt, provider, model, thinking });
		}

		const { createMuSession } = await import("@femtomc/mu-agent");
		const session = await createMuSession({
			cwd: ctx.repoRoot,
			systemPrompt,
			provider,
			model,
			thinking,
			extensionPaths: ctx.serveExtensionPaths,
		});

		return session;
	};

	// One-shot mode: --message provided
	if (message != null) {
		const session = await createOperatorSession();
		try {
			if (ctx.operatorSessionFactory) {
				// Test seam: use lightweight operator session path
				let assistantText = "";
				const unsub = session.subscribe((event: any) => {
					if (event?.type === "message_end" && event?.message?.role === "assistant") {
						const msg = event.message;
						if (typeof msg.text === "string") assistantText = msg.text;
						else if (typeof msg.content === "string") assistantText = msg.content;
					}
				});
				try {
					await session.prompt(message, { expandPromptTemplates: false });
				} finally {
					unsub();
				}
				if (jsonMode) {
					return ok(jsonText({ role: "assistant", content: assistantText }, true));
				}
				return ok(assistantText.length > 0 ? `${assistantText}\n` : "");
			}
			const { runPrintMode } = await import("@mariozechner/pi-coding-agent");
			await runPrintMode(session as any, { mode: jsonMode ? "json" : "text", initialMessage: message });
		} finally {
			session.dispose();
		}
		return ok();
	}

	// Interactive mode: full pi TUI
	if (!(process.stdin as { isTTY?: boolean }).isTTY) {
		return jsonError("interactive operator session requires a TTY; use --message for one-shot mode", {
			recovery: ['mu chat --message "How do I configure the control plane?"'],
		});
	}

	options.onInteractiveReady?.();

	const session = await createOperatorSession();
	try {
		const { InteractiveMode } = await import("@mariozechner/pi-coding-agent");
		const mode = new InteractiveMode(session as any);
		await mode.init();
		await mode.run();
	} finally {
		session.dispose();
	}
	return ok();
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
				"",
				"See also: `mu guide`",
			].join("\n") + "\n",
		);
	}

	// Lazy-import pi SDK to avoid loading it for every mu command.
	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { getOAuthProviders } = await import("@mariozechner/pi-ai");

	const authStorage = AuthStorage.create();
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
			onAuth: (info: { url: string; instructions?: string }) => {
				process.stderr.write(`\nOpen this URL to authenticate:\n  ${info.url}\n\n`);
				if (info.instructions) {
					process.stderr.write(`${info.instructions}\n\n`);
				}
				// Try to open browser automatically.
				try {
					if (process.platform === "darwin") {
						Bun.spawn(["open", info.url], { stdout: "ignore", stderr: "ignore" });
					} else if (process.platform === "linux") {
						Bun.spawn(["xdg-open", info.url], { stdout: "ignore", stderr: "ignore" });
					}
				} catch {}
			},
			onPrompt: async (prompt: { message: string; placeholder?: string }) => {
				const msg = prompt.placeholder ? `${prompt.message} [${prompt.placeholder}]: ` : `${prompt.message}: `;
				const answer = await readLine(msg);
				if (!answer && prompt.placeholder) return prompt.placeholder;
				return answer;
			},
			onProgress: (message: string) => {
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

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

async function readApiError(response: Response, payloadOverride?: unknown): Promise<string> {
	let detail = "";
	if (payloadOverride !== undefined) {
		const payload = asRecord(payloadOverride);
		const error = payload && typeof payload.error === "string" ? payload.error.trim() : "";
		if (error.length > 0) {
			detail = error;
		}
	} else {
		try {
			const payload = asRecord(await response.json());
			const error = payload && typeof payload.error === "string" ? payload.error.trim() : "";
			if (error.length > 0) {
				detail = error;
			}
		} catch {
			// Ignore invalid/empty JSON; fallback to HTTP status text.
		}
	}
	const statusText = `${response.status} ${response.statusText}`.trim();
	if (detail.length > 0) {
		return `${detail} (${statusText})`;
	}
	return statusText;
}

function normalizeQueuedRun(value: unknown): QueuedRunSnapshot | null {
	const rec = asRecord(value);
	if (!rec) {
		return null;
	}
	const jobId = typeof rec.job_id === "string" ? rec.job_id.trim() : "";
	if (jobId.length === 0) {
		return null;
	}
	const rootRaw = typeof rec.root_issue_id === "string" ? rec.root_issue_id.trim() : "";
	const rootIssueId = rootRaw.length > 0 ? rootRaw : null;
	const maxSteps =
		typeof rec.max_steps === "number" && Number.isFinite(rec.max_steps)
			? Math.max(1, Math.trunc(rec.max_steps))
			: 20;
	return {
		job_id: jobId,
		root_issue_id: rootIssueId,
		max_steps: maxSteps,
		mode: typeof rec.mode === "string" ? rec.mode : undefined,
		status: typeof rec.status === "string" ? rec.status : undefined,
		source: typeof rec.source === "string" ? rec.source : undefined,
	};
}

function heartbeatProgramMatchesRun(program: Record<string, unknown>, run: QueuedRunSnapshot): boolean {
	const metadata = asRecord(program.metadata);
	if (typeof metadata?.auto_run_job_id === "string" && metadata.auto_run_job_id === run.job_id) {
		return true;
	}
	const target = asRecord(program.target);
	if (!target || target.kind !== "run") {
		return false;
	}
	if (typeof target.job_id === "string" && target.job_id.trim() === run.job_id) {
		return true;
	}
	if (run.root_issue_id && typeof target.root_issue_id === "string" && target.root_issue_id.trim() === run.root_issue_id) {
		return true;
	}
	return false;
}

function buildServeDeps(ctx: CliCtx): ServeDeps {
	const defaults: ServeDeps = {
		startServer: async ({ repoRoot, port }) => {
			const { createServerAsync } = await import("@femtomc/mu-server");
			const { serverConfig, controlPlane } = await createServerAsync({ repoRoot, port });

			let server: ReturnType<typeof Bun.serve>;
			try {
				server = Bun.serve(serverConfig);
			} catch (err) {
				try {
					await controlPlane?.stop();
				} catch {
					// Best effort cleanup. Preserve the original startup error.
				}
				throw err;
			}

			return {
				activeAdapters: controlPlane?.activeAdapters ?? [],
				stop: async () => {
					await controlPlane?.stop();
					server.stop();
				},
			};
		},
		runOperatorSession: async ({ onReady, provider, model, thinking }) => {
			const { operatorExtensionPaths } = await import("@femtomc/mu-agent");
			const operatorArgv: string[] = [];
			if (provider) {
				operatorArgv.push("--provider", provider);
			}
			if (model) {
				operatorArgv.push("--model", model);
			}
			if (thinking) {
				operatorArgv.push("--thinking", thinking);
			}
			return await cmdOperatorSession(
				operatorArgv,
				{ ...ctx, serveExtensionPaths: ctx.serveExtensionPaths ?? operatorExtensionPaths },
				{
					onInteractiveReady: onReady,
				},
			);
		},
		queueRun: async ({ serverUrl, prompt, maxSteps, provider, model, reasoning }) => {
			const response = await fetch(`${serverUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt,
					max_steps: maxSteps,
					provider: provider ?? null,
					model: model ?? null,
					reasoning: reasoning ?? null,
				}),
			});
			let payload: unknown = null;
			try {
				payload = await response.json();
			} catch {
				// handled below via status check + normalizeQueuedRun guard
			}
			if (!response.ok) {
				const detail = await readApiError(response, payload);
				throw new Error(`run queue request failed: ${detail}`);
			}
			const run = normalizeQueuedRun(asRecord(payload)?.run);
			if (!run) {
				throw new Error("run queue response missing run snapshot");
			}
			return run;
		},
		registerRunHeartbeat: async ({ serverUrl, run }) => {
			const listRes = await fetch(`${serverUrl}/api/heartbeats?target_kind=run&limit=500`);
			let listPayload: unknown = null;
			try {
				listPayload = await listRes.json();
			} catch {
				// handled below via status + shape checks
			}
			if (!listRes.ok) {
				throw new Error(`heartbeat listing failed: ${await readApiError(listRes, listPayload)}`);
			}
			const programsRaw = asRecord(listPayload)?.programs;
			const programs = Array.isArray(programsRaw)
				? programsRaw.map(asRecord).filter((p): p is Record<string, unknown> => p != null)
				: [];
			for (const program of programs) {
				if (!heartbeatProgramMatchesRun(program, run)) {
					continue;
				}
				const programId = typeof program.program_id === "string" ? program.program_id : null;
				return { program_id: programId, created: false };
			}

			const createRes = await fetch(`${serverUrl}/api/heartbeats/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: `Run heartbeat: ${run.root_issue_id ?? run.job_id}`,
					target_kind: "run",
					run_job_id: run.job_id,
					run_root_issue_id: run.root_issue_id,
					every_ms: 15_000,
					reason: "auto-run-heartbeat",
					wake_mode: "next_heartbeat",
					enabled: true,
					metadata: {
						auto_run_heartbeat: true,
						auto_run_job_id: run.job_id,
						auto_run_root_issue_id: run.root_issue_id,
						auto_disable_on_terminal: true,
						run_mode: run.mode ?? null,
						run_source: run.source ?? "api",
					},
				}),
			});
			let createPayload: unknown = null;
			try {
				createPayload = await createRes.json();
			} catch {
				// handled below via status + guards
			}
			if (!createRes.ok) {
				throw new Error(`heartbeat registration failed: ${await readApiError(createRes, createPayload)}`);
			}
			const createdProgram = asRecord(asRecord(createPayload)?.program);
			const createdProgramId =
				createdProgram && typeof createdProgram.program_id === "string" ? createdProgram.program_id : null;
			return { program_id: createdProgramId, created: true };
		},
		registerSignalHandler: (signal, handler) => {
			process.on(signal, handler);
			return () => {
				if (typeof process.off === "function") {
					process.off(signal, handler);
					return;
				}
				process.removeListener(signal, handler);
			};
		},
		openBrowser: (url) => {
			if (process.platform === "darwin") {
				Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
				return;
			}
			Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
		},
		isHeadless: () => !Bun.env.DISPLAY && !Bun.env.BROWSER,
	};
	return { ...defaults, ...ctx.serveDeps };
}

async function runServeLifecycle(ctx: CliCtx, opts: ServeLifecycleOptions): Promise<RunResult> {
	await ensureStoreInitialized(ctx);
	const operatorDefaults = await readServeOperatorDefaults(ctx.repoRoot);
	const operatorProvider = opts.operatorProvider ?? operatorDefaults.provider;
	const operatorModel =
		opts.operatorModel ??
		(opts.operatorProvider != null && opts.operatorProvider.length > 0 ? undefined : operatorDefaults.model);

	const io = ctx.io;
	const deps = buildServeDeps(ctx);
	let server: ServeServerHandle;
	try {
		server = await deps.startServer({ repoRoot: ctx.repoRoot, port: opts.port });
	} catch (err) {
		return jsonError(`failed to start server: ${describeError(err)}`, {
			recovery: [`mu ${opts.commandName} --port 3000`, `mu ${opts.commandName} --help`],
		});
	}

	const serverUrl = `http://localhost:${opts.port}`;
	Bun.env.MU_SERVER_URL = serverUrl;
	io?.stderr?.write(`mu server connected at ${serverUrl}\n`);
	io?.stderr?.write(`Repository: ${ctx.repoRoot}\n`);
	if (server.activeAdapters.length > 0) {
		io?.stderr?.write("Control plane: active\n");
		for (const adapter of server.activeAdapters) {
			io?.stderr?.write(`  ${adapter.name.padEnd(12)} ${adapter.route}\n`);
		}
	}

	const isHeadless = deps.isHeadless();
	const shouldOpen = !opts.noOpen && !isHeadless;
	if (isHeadless) {
		io?.stderr?.write("\nHeadless environment detected. Use SSH port forwarding:\n");
		io?.stderr?.write(`  ssh -L ${opts.port}:localhost:${opts.port} <your-server>\n\n`);
	} else if (shouldOpen) {
		try {
			deps.openBrowser(serverUrl);
			io?.stderr?.write(`Opening ${serverUrl} in browser...\n`);
		} catch {
			io?.stderr?.write(`Could not open browser. Please visit ${serverUrl}\n`);
		}
	}

	let stopError: unknown | null = null;
	let stopped = false;
	const stopServer = async (): Promise<void> => {
		if (stopped) {
			return;
		}
		stopped = true;
		try {
			await server.stop();
			io?.stderr?.write("mu server disconnected.\n");
		} catch (err) {
			stopError = err;
			io?.stderr?.write(`mu serve: failed to stop server cleanly: ${describeError(err)}\n`);
		}
	};

	let unregisterSignals: (() => void) | null = null;
	let result: RunResult = ok();
	try {
		if (opts.beforeOperatorSession) {
			try {
				await opts.beforeOperatorSession({ serverUrl, deps, io });
			} catch (err) {
				return jsonError(`failed to prepare run lifecycle: ${describeError(err)}`, {
					recovery: ["mu serve --help", "mu run --help"],
				});
			}
		}

		let operatorConnected = false;
		const onOperatorReady = (): void => {
			if (operatorConnected) {
				return;
			}
			operatorConnected = true;
			io?.stderr?.write("Operator terminal: connected\n");
		};

		io?.stderr?.write("Operator terminal: connecting...\n");

		let resolveSignal: ((signal: NodeJS.Signals) => void) | null = null;
		const signalPromise = new Promise<NodeJS.Signals>((resolve) => {
			resolveSignal = resolve;
		});
		let receivedSignal: NodeJS.Signals | null = null;
		const onSignal = (signal: NodeJS.Signals): void => {
			if (receivedSignal != null) {
				return;
			}
			receivedSignal = signal;
			resolveSignal?.(signal);
		};
		const removeSignalHandlers = [
			deps.registerSignalHandler("SIGINT", () => onSignal("SIGINT")),
			deps.registerSignalHandler("SIGTERM", () => onSignal("SIGTERM")),
		];
		unregisterSignals = () => {
			for (const remove of removeSignalHandlers) {
				try {
					remove();
				} catch {
					// no-op
				}
			}
		};

		const operatorPromise = deps
			.runOperatorSession({
				onReady: onOperatorReady,
				provider: operatorProvider,
				model: operatorModel,
				thinking: opts.operatorThinking,
			})
			.catch((err) =>
				jsonError(`operator session crashed: ${describeError(err)}`, {
					recovery: ["mu chat --help"],
				}),
			);

		const winner = await Promise.race([
			operatorPromise.then((operatorResult) => ({ kind: "operator" as const, operatorResult })),
			signalPromise.then((signal) => ({ kind: "signal" as const, signal })),
		]);

		if (winner.kind === "signal") {
			io?.stderr?.write(`\nOperator terminal: disconnected (${winner.signal}).\n`);
			await Promise.race([operatorPromise, delayMs(1_000)]);
			result = { stdout: "", stderr: "", exitCode: signalExitCode(winner.signal) };
		} else {
			if (winner.operatorResult.exitCode === 0) {
				io?.stderr?.write("Operator terminal: disconnected.\n");
			} else if (operatorConnected) {
				io?.stderr?.write("Operator terminal: disconnected (error).\n");
			} else {
				io?.stderr?.write("Operator terminal: failed to connect.\n");
			}
			result = winner.operatorResult;
		}
	} finally {
		unregisterSignals?.();
		await stopServer();
	}

	if (stopError && result.exitCode === 0) {
		return jsonError(`server shutdown failed: ${describeError(stopError)}`, {
			recovery: ["Retry `mu serve`", "Inspect local process state"],
		});
	}

	return result;
}

async function cmdServe(argv: string[], ctx: CliCtx): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu serve - start server + terminal operator session + web UI",
				"",
				"Usage:",
				"  mu serve [--port N] [--no-open]",
				"",
				"Options:",
				"  --port N       Server port (default: 3000)",
				"  --no-open      Don't open browser automatically",
				"",
				"Starts the API + bundled web UI, then attaches an interactive terminal",
				"operator session in this same shell.",
				"",
				"Control plane configuration:",
				"  .mu/config.json is the source of truth for adapter + assistant settings",
				"  Attached terminal operator session inherits control_plane.operator.provider/model when set",
				"  Use `/mu setup <adapter>` in mu serve operator session for guided setup",
				"  Use `mu control status` to inspect current config",
				"",
				"See also: `mu chat --help`, `mu guide`",
			].join("\n") + "\n",
		);
	}

	const { value: portRaw, rest: argv0 } = getFlagValue(argv, "--port");
	const { present: noOpen, rest } = popFlag(argv0, "--no-open");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu serve --help"] });
	}

	const port = portRaw ? ensureInt(portRaw, { name: "--port", min: 1, max: 65535 }) : 3000;
	if (port == null) {
		return jsonError("port must be 1-65535", { recovery: ["mu serve --port 3000"] });
	}

	return await runServeLifecycle(ctx, {
		commandName: "serve",
		port,
		noOpen,
	});
}

// ROLE_SCOPES lives in @femtomc/mu-control-plane; lazy-imported alongside IdentityStore.

async function cmdControl(argv: string[], ctx: CliCtx): Promise<RunResult> {
	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

	if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
		return ok(
			[
				"mu control - control-plane identity & config",
				"",
				"Usage:",
				"  mu control <command> [args...] [--pretty]",
				"",
				"Commands:",
				"  link          Link a channel identity",
				"  unlink        Unlink a binding (self-unlink or admin revoke)",
				"  identities    List identity bindings",
				"  status        Show control-plane status",
				"  diagnose-operator  Diagnose operator turn parsing/execution health",
				"",
				"See also: `mu guide`",
			].join("\n") + "\n",
		);
	}

	const sub = argv0[0]!;
	const rest = argv0.slice(1);

	switch (sub) {
		case "link":
			return await controlLink(rest, ctx, pretty);
		case "unlink":
			return await controlUnlink(rest, ctx, pretty);
		case "identities":
			return await controlIdentities(rest, ctx, pretty);
		case "status":
			return await controlStatus(rest, ctx, pretty);
		case "diagnose-operator":
			return await controlDiagnoseOperator(rest, ctx, pretty);
		default:
			return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu control --help"] });
	}
}

async function controlDiagnoseOperator(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu control diagnose-operator - inspect operator decision parsing/execution health",
				"",
				"Usage:",
				"  mu control diagnose-operator [--limit N] [--json] [--pretty]",
				"",
				"Reads:",
				"  .mu/control-plane/operator_turns.jsonl",
				"  .mu/control-plane/commands.jsonl",
				"",
				"Examples:",
				"  mu control diagnose-operator",
				"  mu control diagnose-operator --limit 50 --json --pretty",
			].join("\n") + "\n",
		);
	}

	const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
	const { value: limitRaw, rest } = getFlagValue(argv0, "--limit");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, {
			pretty,
			recovery: ["mu control diagnose-operator --help"],
		});
	}

	const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 20;
	if (limit == null) {
		return jsonError("limit must be an integer between 1 and 500", {
			pretty,
			recovery: ["mu control diagnose-operator --limit 20"],
		});
	}

	const asRecord = (value: unknown): Record<string, unknown> | null =>
		typeof value === "object" && value != null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

	const formatTs = (ts: number): string => {
		try {
			return new Date(ts).toISOString();
		} catch {
			return String(ts);
		}
	};

	const { getControlPlanePaths } = await import("@femtomc/mu-control-plane");
	const paths = getControlPlanePaths(ctx.repoRoot);
	const turnsPath = join(paths.controlPlaneDir, "operator_turns.jsonl");
	const turnsExists = await fileExists(turnsPath);

	const turns: Array<{
		ts_ms: number;
		request_id: string;
		session_id: string | null;
		turn_id: string | null;
		outcome: string;
		reason: string | null;
		message_preview: string | null;
		command_kind: string | null;
	}> = [];

	if (turnsExists) {
		try {
			const rows = await readJsonl(turnsPath);
			for (const row of rows) {
				const rec = asRecord(row);
				if (!rec || rec.kind !== "operator.turn") {
					continue;
				}
				const ts = typeof rec.ts_ms === "number" && Number.isFinite(rec.ts_ms) ? Math.trunc(rec.ts_ms) : null;
				const requestId = nonEmptyString(rec.request_id);
				const outcome = nonEmptyString(rec.outcome);
				if (ts == null || !requestId || !outcome) {
					continue;
				}
				const command = asRecord(rec.command);
				turns.push({
					ts_ms: ts,
					request_id: requestId,
					session_id: nonEmptyString(rec.session_id) ?? null,
					turn_id: nonEmptyString(rec.turn_id) ?? null,
					outcome,
					reason: nonEmptyString(rec.reason) ?? null,
					message_preview: nonEmptyString(rec.message_preview) ?? null,
					command_kind: nonEmptyString(command?.kind) ?? null,
				});
			}
		} catch (err) {
			return jsonError(`failed to read operator turn audit: ${describeError(err)}`, {
				pretty,
				recovery: ["mu control diagnose-operator --json --pretty"],
			});
		}
	}

	turns.sort((a, b) => a.ts_ms - b.ts_ms);

	const outcomeCounts: Record<string, number> = {};
	for (const t of turns) {
		outcomeCounts[t.outcome] = (outcomeCounts[t.outcome] ?? 0) + 1;
	}

	const recentTurns = turns.slice(-limit).reverse().map((t) => ({
		ts_ms: t.ts_ms,
		ts_iso: formatTs(t.ts_ms),
		request_id: t.request_id,
		outcome: t.outcome,
		reason: t.reason,
		command_kind: t.command_kind,
		message_preview: t.message_preview,
	}));

	const problematicTurns = turns
		.filter((t) => t.outcome === "invalid_directive" || t.outcome === "error")
		.slice(-limit)
		.reverse()
		.map((t) => ({
			ts_ms: t.ts_ms,
			ts_iso: formatTs(t.ts_ms),
			request_id: t.request_id,
			outcome: t.outcome,
			reason: t.reason,
			message_preview: t.message_preview,
		}));

	const operatorLifecycleRows: Array<{
		ts_ms: number;
		event_type: string;
		command_id: string;
		target_type: string;
		state: string;
		error_code: string | null;
		operator_session_id: string;
		operator_turn_id: string | null;
	}> = [];

	if (await fileExists(paths.commandsPath)) {
		try {
			const commandRows = await readJsonl(paths.commandsPath);
			for (const row of commandRows) {
				const rec = asRecord(row);
				if (!rec || rec.kind !== "command.lifecycle") {
					continue;
				}
				const command = asRecord(rec.command);
				if (!command) {
					continue;
				}
				const sessionId = nonEmptyString(command.operator_session_id);
				if (!sessionId) {
					continue;
				}
				const ts = typeof rec.ts_ms === "number" && Number.isFinite(rec.ts_ms) ? Math.trunc(rec.ts_ms) : null;
				const eventType = nonEmptyString(rec.event_type);
				const commandId = nonEmptyString(command.command_id);
				const targetType = nonEmptyString(command.target_type);
				const state = nonEmptyString(command.state);
				if (ts == null || !eventType || !commandId || !targetType || !state) {
					continue;
				}
				operatorLifecycleRows.push({
					ts_ms: ts,
					event_type: eventType,
					command_id: commandId,
					target_type: targetType,
					state,
					error_code: nonEmptyString(command.error_code) ?? null,
					operator_session_id: sessionId,
					operator_turn_id: nonEmptyString(command.operator_turn_id) ?? null,
				});
			}
		} catch (err) {
			return jsonError(`failed to read command journal: ${describeError(err)}`, {
				pretty,
				recovery: ["mu control diagnose-operator --json --pretty"],
			});
		}
	}

	operatorLifecycleRows.sort((a, b) => a.ts_ms - b.ts_ms);
	const operatorRunMutations = operatorLifecycleRows
		.filter((row) => row.target_type === "run start" || row.target_type === "run resume" || row.target_type === "run interrupt")
		.slice(-limit)
		.reverse()
		.map((row) => ({
			ts_ms: row.ts_ms,
			ts_iso: formatTs(row.ts_ms),
			event_type: row.event_type,
			command_id: row.command_id,
			target_type: row.target_type,
			state: row.state,
			error_code: row.error_code,
			operator_session_id: row.operator_session_id,
			operator_turn_id: row.operator_turn_id,
		}));

	const payload = {
		repo_root: ctx.repoRoot,
		operator_turn_audit: {
			path: turnsPath,
			exists: turnsExists,
			total: turns.length,
			outcomes: outcomeCounts,
			recent_problematic: problematicTurns,
			recent_turns: recentTurns,
		},
		command_journal: {
			path: paths.commandsPath,
			operator_lifecycle_events: operatorLifecycleRows.length,
			recent_operator_run_mutations: operatorRunMutations,
		},
		hints: [
			!turnsExists
				? "operator_turns.jsonl is missing. This usually means your running mu build predates operator turn auditing; upgrade and restart `mu serve`."
				: null,
			problematicTurns.length > 0
				? "Recent invalid_directive/error outcomes detected. Inspect operator_turns.jsonl for failed mu_command tool calls."
				: null,
			operatorRunMutations.length === 0
				? "No operator-attributed run mutations found in command journal. In current architecture, operator-triggered runs should appear as brokered command lifecycle events."
				: null,
		].filter((line): line is string => line != null),
	};

	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}

	let out = `Operator diagnostics for ${ctx.repoRoot}\n`;
	out += `Audit file: ${turnsPath}\n`;
	out += `Audit exists: ${turnsExists}\n`;
	if (turnsExists) {
		out += `Turns: ${turns.length}\n`;
		const outcomes = Object.entries(outcomeCounts)
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([k, v]) => `${k}=${v}`)
			.join(", ");
		out += `Outcomes: ${outcomes || "(none)"}\n`;
	}

	if (problematicTurns.length > 0) {
		out += "\nRecent problematic turns:\n";
		for (const t of problematicTurns) {
			out += `  ${t.ts_iso} req=${t.request_id} outcome=${t.outcome} reason=${t.reason ?? "(none)"}\n`;
		}
	}

	out += `\nOperator lifecycle events in commands journal: ${operatorLifecycleRows.length}\n`;
	if (operatorRunMutations.length > 0) {
		out += "Recent operator run mutations:\n";
		for (const row of operatorRunMutations) {
			out += `  ${row.ts_iso} ${row.target_type} ${row.event_type} command=${row.command_id}`;
			if (row.error_code) {
				out += ` error=${row.error_code}`;
			}
			out += "\n";
		}
	}

	if (payload.hints.length > 0) {
		out += "\nHints:\n";
		for (const hint of payload.hints) {
			out += `  - ${hint}\n`;
		}
	}

	return ok(out);
}

async function controlLink(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu control link - link a channel identity",
				"",
				"Usage:",
				"  mu control link --channel <slack|discord|telegram> --actor-id <ID> --tenant-id <ID>",
				"    [--operator-id ID] [--role <operator|viewer|contributor>] [--scope SCOPE]",
				"    [--binding-id ID] [--pretty]",
				"",
				"Roles (default: operator):",
				"  operator      Full access (read, write, execute, admin)",
				"  contributor   Read + write + execute (no admin)",
				"  viewer        Read-only",
			].join("\n") + "\n",
		);
	}

	const { value: channel, rest: argv0 } = getFlagValue(argv, "--channel");
	const { value: actorId, rest: argv1 } = getFlagValue(argv0, "--actor-id");
	const { value: tenantId, rest: argv2 } = getFlagValue(argv1, "--tenant-id");
	const { value: operatorId, rest: argv3 } = getFlagValue(argv2, "--operator-id");
	const { value: role, rest: argv4 } = getFlagValue(argv3, "--role");
	const { values: extraScopes, rest: argv5 } = getRepeatFlagValues(argv4, ["--scope"]);
	const { value: bindingIdFlag, rest } = getFlagValue(argv5, "--binding-id");

	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control link --help"] });
	}

	if (!channel) {
		return jsonError("missing --channel", { pretty, recovery: ["mu control link --help"] });
	}
	if (channel !== "slack" && channel !== "discord" && channel !== "telegram") {
		return jsonError(`invalid channel: ${channel} (slack, discord, telegram)`, {
			pretty,
			recovery: ["mu control link --channel telegram --actor-id 123 --tenant-id bot"],
		});
	}
	if (!actorId) {
		return jsonError("missing --actor-id", { pretty, recovery: ["mu control link --help"] });
	}
	if (!tenantId) {
		return jsonError("missing --tenant-id", { pretty, recovery: ["mu control link --help"] });
	}

	// Lazy-import control-plane.
	const { IdentityStore, getControlPlanePaths, ROLE_SCOPES } = await import("@femtomc/mu-control-plane");

	const roleKey = role ?? "operator";
	const roleScopes = ROLE_SCOPES[roleKey];
	if (!roleScopes) {
		return jsonError(`invalid role: ${roleKey} (operator, contributor, viewer)`, {
			pretty,
			recovery: ["mu control link --help"],
		});
	}
	const scopes = [...new Set([...roleScopes, ...extraScopes])];

	const bindingId = bindingIdFlag || `bind-${crypto.randomUUID()}`;
	const opId = operatorId || "default";
	const paths = getControlPlanePaths(ctx.repoRoot);
	const store = new IdentityStore(paths.identitiesPath);

	const decision = await store.link({
		bindingId,
		operatorId: opId,
		channel,
		channelTenantId: tenantId,
		channelActorId: actorId,
		scopes,
	});

	switch (decision.kind) {
		case "linked":
			return ok(jsonText({ ok: true, kind: "linked", binding: decision.binding }, pretty));
		case "binding_exists":
			return jsonError(`binding already exists: ${decision.binding.binding_id}`, {
				pretty,
				recovery: ["mu control identities --pretty"],
			});
		case "principal_already_linked":
			return jsonError(
				`principal already linked as ${decision.binding.binding_id} (${decision.binding.channel}/${decision.binding.channel_tenant_id}/${decision.binding.channel_actor_id})`,
				{
					pretty,
					recovery: [`mu control unlink ${decision.binding.binding_id}`, "mu control identities --pretty"],
				},
			);
		default: {
			const _exhaustive: never = decision;
			throw new Error(`unexpected link decision: ${(_exhaustive as any).kind}`);
		}
	}
}

async function controlUnlink(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu control unlink - remove an identity binding",
				"",
				"Usage:",
				"  mu control unlink <binding-id> [--revoke] [--reason TEXT] [--pretty]",
				"",
				"Without --revoke: self-unlink (binding acts on itself).",
				"With --revoke: admin revocation (synthetic cli-admin actor).",
			].join("\n") + "\n",
		);
	}

	const bindingId = argv[0]!;
	const { present: revoke, rest: argv0 } = popFlag(argv.slice(1), "--revoke");
	const { value: reason, rest } = getFlagValue(argv0, "--reason");

	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control unlink --help"] });
	}

	const { IdentityStore, getControlPlanePaths } = await import("@femtomc/mu-control-plane");
	const paths = getControlPlanePaths(ctx.repoRoot);
	const store = new IdentityStore(paths.identitiesPath);

	if (revoke) {
		const decision = await store.revoke({
			bindingId,
			actorBindingId: "cli-admin",
			reason: reason ?? null,
		});

		switch (decision.kind) {
			case "revoked":
				return ok(jsonText({ ok: true, kind: "revoked", binding: decision.binding }, pretty));
			case "not_found":
				return jsonError(`binding not found: ${bindingId}`, {
					pretty,
					recovery: ["mu control identities --all --pretty"],
				});
			case "already_inactive":
				return jsonError(`binding already inactive (status=${decision.binding.status})`, {
					pretty,
					recovery: ["mu control identities --all --pretty"],
				});
			default: {
				const _exhaustive: never = decision;
				throw new Error(`unexpected revoke decision: ${(_exhaustive as any).kind}`);
			}
		}
	}

	const decision = await store.unlinkSelf({
		bindingId,
		actorBindingId: bindingId,
		reason: reason ?? null,
	});

	switch (decision.kind) {
		case "unlinked":
			return ok(jsonText({ ok: true, kind: "unlinked", binding: decision.binding }, pretty));
		case "not_found":
			return jsonError(`binding not found: ${bindingId}`, {
				pretty,
				recovery: ["mu control identities --all --pretty"],
			});
		case "invalid_actor":
			return jsonError("self-unlink failed (actor mismatch)", {
				pretty,
				recovery: [`mu control unlink ${bindingId} --revoke`],
			});
		case "already_inactive":
			return jsonError(`binding already inactive (status=${decision.binding.status})`, {
				pretty,
				recovery: ["mu control identities --all --pretty"],
			});
		default: {
			const _exhaustive: never = decision;
			throw new Error(`unexpected unlink decision: ${(_exhaustive as any).kind}`);
		}
	}
}

async function controlIdentities(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu control identities - list identity bindings",
				"",
				"Usage:",
				"  mu control identities [--all] [--pretty]",
				"",
				"By default shows active bindings. Use --all to include inactive.",
			].join("\n") + "\n",
		);
	}

	const { present: all, rest } = popFlag(argv, "--all");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control identities --help"] });
	}

	const { IdentityStore, getControlPlanePaths } = await import("@femtomc/mu-control-plane");
	const paths = getControlPlanePaths(ctx.repoRoot);
	const store = new IdentityStore(paths.identitiesPath);
	await store.load();

	const bindings = store.listBindings({ includeInactive: all });
	return ok(jsonText(bindings, pretty));
}

async function controlStatus(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu control status - show control-plane status",
				"",
				"Usage:",
				"  mu control status [--json] [--pretty]",
			].join("\n") + "\n",
		);
	}

	const { present: jsonMode, rest } = popFlag(argv, "--json");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu control status --help"] });
	}

	const { IdentityStore, getControlPlanePaths } = await import("@femtomc/mu-control-plane");
	const paths = getControlPlanePaths(ctx.repoRoot);
	const store = new IdentityStore(paths.identitiesPath);
	await store.load();

	const bindings = store.listBindings();
	const allBindings = store.listBindings({ includeInactive: true });
	const hasPolicyFile = await fileExists(paths.policyPath);

	const configPath = join(ctx.repoRoot, ".mu", "config.json");
	let config: Record<string, unknown> = {};
	try {
		const raw = await Bun.file(configPath).text();
		config = JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		const code = (err as { code?: string })?.code;
		if (code !== "ENOENT") {
			return ok(`failed to read ${configPath}: ${describeError(err)}`, 1);
		}
	}

	const controlPlane = (config.control_plane as Record<string, unknown> | undefined) ?? {};
	const adaptersCfg = (controlPlane.adapters as Record<string, unknown> | undefined) ?? {};
	const slackCfg = (adaptersCfg.slack as Record<string, unknown> | undefined) ?? {};
	const discordCfg = (adaptersCfg.discord as Record<string, unknown> | undefined) ?? {};
	const telegramCfg = (adaptersCfg.telegram as Record<string, unknown> | undefined) ?? {};
	const gmailCfg = (adaptersCfg.gmail as Record<string, unknown> | undefined) ?? {};
	const operatorCfg = (controlPlane.operator as Record<string, unknown> | undefined) ?? {};

	const present = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
	const boolOr = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
	const strOrNull = (value: unknown): string | null =>
		typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

	const adapters: { channel: string; configured: boolean }[] = [
		{ channel: "slack", configured: present(slackCfg.signing_secret) },
		{ channel: "discord", configured: present(discordCfg.signing_secret) },
		{ channel: "telegram", configured: present(telegramCfg.webhook_secret) },
		{ channel: "gmail", configured: boolOr(gmailCfg.enabled, false) },
	];

	const operator = {
		enabled: boolOr(operatorCfg.enabled, true),
		run_triggers_enabled: boolOr(operatorCfg.run_triggers_enabled, true),
		provider: strOrNull(operatorCfg.provider),
		model: strOrNull(operatorCfg.model),
	};

	const payload = {
		repo_root: ctx.repoRoot,
		identities: {
			active: bindings.length,
			total: allBindings.length,
		},
		policy: {
			path: paths.policyPath,
			exists: hasPolicyFile,
		},
		adapters,
		operator: operator,
		config_path: configPath,
	};

	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}

	let out = `Control plane: ${ctx.repoRoot}\n`;
	out += `Identities: ${bindings.length} active, ${allBindings.length} total\n`;
	out += `Policy: ${hasPolicyFile ? paths.policyPath : "(none)"}\n`;
	out += `Config: ${configPath}\n`;
	out += "\nAdapter config:\n";
	for (const a of adapters) {
		const status = a.configured ? "configured" : "not configured";
		out += `  ${a.channel.padEnd(12)} ${status}\n`;
	}
	out += "\nOperator config:\n";
	out += `  enabled              ${operator.enabled}\n`;
	out += `  run_triggers_enabled ${operator.run_triggers_enabled}\n`;
	out += `  provider             ${operator.provider ?? "(default)"}\n`;
	out += `  model                ${operator.model ?? "(default)"}\n`;
	out += "  Use `mu chat` for direct terminal operator access.\n";

	return ok(out);
}
