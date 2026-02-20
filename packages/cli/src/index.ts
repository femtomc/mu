import { existsSync, openSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { BackendRunner } from "@femtomc/mu-agent";
import type { ForumMessage, Issue } from "@femtomc/mu-core";
import { getStorePaths as resolveStorePaths } from "@femtomc/mu-core/node";
import type { EventLog, StorePaths } from "@femtomc/mu-core/node";
import type { ForumTopicSummary } from "@femtomc/mu-forum";
import type { ForumStore } from "@femtomc/mu-forum";
import type { IssueStore } from "@femtomc/mu-issue";
import type { ModelOverrides } from "@femtomc/mu-orchestrator";
import { cmdControl as cmdControlCommand } from "./commands/control.js";
import { cmdReplay as cmdReplayCommand } from "./commands/replay.js";
import { cmdResume as cmdResumeCommand } from "./commands/resume.js";
import { cmdRun as cmdRunCommand } from "./commands/run.js";
import { cmdRunDirect as cmdRunDirectCommand } from "./commands/run_direct.js";
import { cmdServe as cmdServeCommand, cmdStop as cmdStopCommand } from "./commands/serve.js";
import { cmdSession as cmdSessionCommand } from "./commands/session.js";
import { cmdStore as cmdStoreCommand } from "./commands/store.js";
import { cmdStatus as cmdStatusCommand } from "./commands/status.js";
import {
	cmdCron as cmdCronCommand,
	cmdHeartbeats as cmdHeartbeatsCommand,
	cmdRuns as cmdRunsCommand,
} from "./commands/scheduling.js";
import { cmdMemory as cmdMemoryCommand } from "./commands/memory.js";
import { cmdTurn as cmdTurnCommand } from "./commands/turn.js";

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

type OperatorSessionStartMode = "in-memory" | "continue-recent" | "new" | "open";

type OperatorSessionStartOpts = {
	mode: OperatorSessionStartMode;
	sessionDir?: string;
	sessionFile?: string;
};

type ServeDeps = {
	startServer: (opts: { repoRoot: string; port: number }) => Promise<ServeServerHandle>;
	spawnBackgroundServer: (opts: { repoRoot: string; port: number }) => Promise<{ pid: number; url: string }>;
	requestServerShutdown: (opts: { serverUrl: string }) => Promise<{ ok: boolean }>;
	runOperatorSession: (opts: {
		onReady: () => void;
		provider?: string;
		model?: string;
		thinking?: string;
		sessionMode?: OperatorSessionStartMode;
		sessionDir?: string;
		sessionFile?: string;
	}) => Promise<RunResult>;
	queueRun: (opts: {
		serverUrl: string;
		prompt: string;
		maxSteps: number;
		provider?: string;
		model?: string;
		reasoning?: string;
	}) => Promise<QueuedRunSnapshot>;
	registerSignalHandler: (signal: NodeJS.Signals, handler: () => void) => () => void;
	registerProcessExitHandler: (handler: () => void) => () => void;
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
	paths: StorePaths;
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
	session?: OperatorSessionStartOpts;
};

type ServeLifecycleOptions = {
	commandName: "serve" | "run" | "session";
	port: number;
	operatorProvider?: string;
	operatorModel?: string;
	operatorThinking?: string;
	operatorSession?: OperatorSessionStartOpts;
	beforeOperatorSession?: (opts: { serverUrl: string; deps: ServeDeps; io: CliIO | undefined }) => Promise<void>;
};

function hasAnsiSequences(text: string): boolean {
	return /\x1b\[[0-9;]*m/.test(text);
}

function styleHelpLine(line: string, index: number): string {
	if (line.length === 0) {
		return line;
	}
	const match = line.match(/^(\s*)(.*)$/);
	const indent = match?.[1] ?? "";
	const body = match?.[2] ?? line;
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return line;
	}

	if (index === 0 && trimmed.startsWith("mu ")) {
		const header = trimmed.match(/^mu\s+([\w-]+)(\s+-\s+.*)?$/);
		if (header) {
			const subcommand = header[1] ?? "";
			const summary = header[2] ?? "";
			return `${indent}${chalk.bold.magenta("mu")} ${chalk.cyan(subcommand)}${chalk.dim(summary)}`;
		}
	}

	if (/^[A-Za-z][A-Za-z0-9 /_-]*:$/.test(trimmed)) {
		return `${indent}${chalk.bold(trimmed)}`;
	}

	const usageLine = body.match(/^mu\s+([\w-]+)(.*)$/);
	if (usageLine) {
		const subcommand = usageLine[1] ?? "";
		const rest = usageLine[2] ?? "";
		return `${indent}${chalk.bold.magenta("mu")} ${chalk.cyan(subcommand)}${chalk.dim(rest)}`;
	}

	const optionLine = body.match(/^(--[\w-]+)(\s+.*)?$/);
	if (optionLine) {
		const flag = optionLine[1] ?? "";
		const rest = optionLine[2] ?? "";
		return `${indent}${chalk.cyan(flag)}${chalk.dim(rest)}`;
	}

	return `${indent}${body.replace(/`(mu [^`]+)`/g, (_m, cmdText) => `\`${chalk.cyan(cmdText)}\``)}`;
}

function styleHelpTextIfNeeded(stdout: string): string {
	if (!process.stdout.isTTY) {
		return stdout;
	}
	if (hasAnsiSequences(stdout)) {
		return stdout;
	}
	if (!stdout.includes("\nUsage:\n") && !stdout.startsWith("mu ")) {
		return stdout;
	}
	const lines = stdout.split("\n");
	return lines.map((line, index) => styleHelpLine(line, index)).join("\n");
}

function ok(stdout: string = "", exitCode: number = 0): RunResult {
	return { stdout: styleHelpTextIfNeeded(stdout), stderr: "", exitCode };
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

function storePathForRepoRoot(repoRoot: string, ...parts: string[]): string {
	return join(resolveStorePaths(repoRoot).storeDir, ...parts);
}

async function readServeOperatorDefaults(
	repoRoot: string,
): Promise<{ provider?: string; model?: string; thinking?: string }> {
	const configPath = storePathForRepoRoot(repoRoot, "config.json");
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
			thinking: nonEmptyString(operatorObj.thinking),
		};
	} catch {
		return {};
	}
}

function operatorSessionDir(repoRoot: string): string {
	return storePathForRepoRoot(repoRoot, "operator", "sessions");
}

function defaultOperatorSessionStart(repoRoot: string): OperatorSessionStartOpts {
	return {
		mode: "continue-recent",
		sessionDir: operatorSessionDir(repoRoot),
	};
}

async function ensureCtx(cwd: string): Promise<CliCtx> {
	const { FsJsonlStore, fsEventLog, getStorePaths } = await import("@femtomc/mu-core/node");
	const { IssueStore } = await import("@femtomc/mu-issue");
	const { ForumStore } = await import("@femtomc/mu-forum");
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
			"# Auto-generated by mu for this workspace store.",
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

function compactId(value: string, width: number = 10): string {
	const normalized = value.trim();
	if (normalized.length <= width) {
		return normalized;
	}
	return normalized.slice(0, width);
}

function truncateInline(value: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= width) {
		return normalized;
	}
	if (width === 1) {
		return "…";
	}
	return `${normalized.slice(0, width - 1)}…`;
}

function normalizeEpochMs(ts: number): number | null {
	if (!Number.isFinite(ts) || ts <= 0) {
		return null;
	}
	const normalized = Math.trunc(ts);
	if (normalized < 10_000_000_000) {
		return normalized * 1000;
	}
	return normalized;
}

function formatTsIsoMinute(ts: number): string {
	const tsMs = normalizeEpochMs(ts);
	if (tsMs == null) {
		return "-";
	}
	try {
		return new Date(tsMs).toISOString().slice(0, 16).replace("T", " ");
	} catch {
		return "-";
	}
}

function formatAgeShort(ts: number, nowMs: number = Date.now()): string {
	const tsMs = normalizeEpochMs(ts);
	if (tsMs == null) {
		return "-";
	}
	const diffMs = Math.max(0, nowMs - tsMs);
	if (diffMs < 60_000) {
		return `${Math.max(1, Math.floor(diffMs / 1000))}s`;
	}
	if (diffMs < 3_600_000) {
		return `${Math.floor(diffMs / 60_000)}m`;
	}
	if (diffMs < 86_400_000) {
		return `${Math.floor(diffMs / 3_600_000)}h`;
	}
	if (diffMs < 7 * 86_400_000) {
		return `${Math.floor(diffMs / 86_400_000)}d`;
	}
	if (diffMs < 30 * 86_400_000) {
		return `${Math.floor(diffMs / (7 * 86_400_000))}w`;
	}
	return `${Math.floor(diffMs / (30 * 86_400_000))}mo`;
}

function summarizeBodySingleLine(body: string, width: number): string {
	const normalized = body.replaceAll("\r\n", "\n");
	const lines = normalized.split("\n");
	const first = truncateInline(lines[0] ?? "", width);
	const base = first.length > 0 ? first : "(empty)";
	const extraLines = Math.max(0, lines.length - 1);
	if (extraLines === 0) {
		return base;
	}
	const suffix = ` (+${extraLines} more line${extraLines === 1 ? "" : "s"})`;
	return truncateInline(`${base}${suffix}`, width + suffix.length);
}

function summarizeTags(tags: readonly string[], width: number): string {
	if (tags.length === 0) {
		return "-";
	}
	return truncateInline(tags.join(","), width);
}

function renderIssueCompactTable(issues: readonly Issue[]): string {
	const header = `${"ID".padEnd(10)} ${"STATUS".padEnd(11)} ${"P".padStart(2)} ${"UPD".padEnd(4)} ${"TITLE".padEnd(44)} TAGS`;
	if (issues.length === 0) {
		return `${header}\n(no issues)\n`;
	}
	const rows = issues.map((issue) => {
		const id = compactId(issue.id, 10).padEnd(10);
		const status = issue.status.padEnd(11);
		const priority = String(issue.priority ?? 3).padStart(2);
		const age = formatAgeShort(issue.updated_at ?? 0).padEnd(4);
		const title = truncateInline(issue.title, 44).padEnd(44);
		const tags = summarizeTags(issue.tags ?? [], 36);
		return `${id} ${status} ${priority} ${age} ${title} ${tags}`;
	});
	return `${[header, ...rows].join("\n")}\n`;
}

function renderIssueDetailCompact(issue: Issue): string {
	const tags = issue.tags.length > 0 ? issue.tags.join(", ") : "-";
	const lines = [
		`ID: ${issue.id}`,
		`Status: ${issue.status}  Priority: ${issue.priority}  Updated: ${formatTsIsoMinute(issue.updated_at)} (${formatAgeShort(issue.updated_at)})`,
		`Outcome: ${issue.outcome ?? "-"}`,
		`Tags: ${tags}`,
	];

	if (issue.deps.length > 0) {
		lines.push("Deps:");
		for (const dep of issue.deps) {
			lines.push(`  - ${dep.type} -> ${dep.target}`);
		}
	}

	lines.push("", "Body:");
	lines.push(issue.body.length > 0 ? issue.body : "(empty)");
	return `${lines.join("\n")}\n`;
}

function renderIssueMutationCompact(
	action: "created" | "updated" | "claimed" | "opened" | "closed",
	issue: Issue,
	opts: { fields?: readonly string[] } = {},
): string {
	const parts = [
		`${action}:`,
		issue.id,
		`status=${issue.status}`,
		`p=${issue.priority}`,
		`updated=${formatAgeShort(issue.updated_at)}`,
	];
	if (issue.outcome != null) {
		parts.push(`outcome=${issue.outcome}`);
	}
	if (opts.fields && opts.fields.length > 0) {
		parts.push(`fields=${opts.fields.join(",")}`);
	}
	parts.push(`title=\"${truncateInline(issue.title, 56)}\"`);
	return `${parts.join(" ")}\n`;
}

function renderIssueDepMutationCompact(action: "added" | "removed", dep: {
	src: string;
	type: string;
	dst: string;
	ok?: boolean;
}): string {
	const base = `dep ${action}: ${dep.src} ${dep.type} ${dep.dst}`;
	if (dep.ok == null) {
		return `${base}\n`;
	}
	return `${base} ok=${dep.ok ? "true" : "false"}\n`;
}

function renderForumPostCompact(msg: ForumMessage): string {
	const bodySummary = truncateInline(summarizeBodySingleLine(msg.body, 64), 64);
	return `posted: ${msg.topic} by ${msg.author} at ${formatTsIsoMinute(msg.created_at)} \"${bodySummary}\"\n`;
}

function renderForumReadCompact(topic: string, messages: readonly ForumMessage[]): string {
	const lines = [
		`Topic: ${topic} (${messages.length} message${messages.length === 1 ? "" : "s"})`,
		`${"TS (UTC)".padEnd(16)} ${"AGE".padEnd(4)} ${"AUTHOR".padEnd(12)} MESSAGE`,
	];
	if (messages.length === 0) {
		lines.push("(no messages)");
		return `${lines.join("\n")}\n`;
	}
	for (const msg of messages) {
		const ts = formatTsIsoMinute(msg.created_at).padEnd(16);
		const age = formatAgeShort(msg.created_at).padEnd(4);
		const author = truncateInline(msg.author, 12).padEnd(12);
		const summary = truncateInline(summarizeBodySingleLine(msg.body, 72), 72);
		lines.push(`${ts} ${age} ${author} ${summary}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderForumTopicsCompact(topics: readonly ForumTopicSummary[]): string {
	const lines = [`${"TOPIC".padEnd(44)} ${"MSG".padStart(3)} ${"LAST (UTC)".padEnd(16)} AGE`];
	if (topics.length === 0) {
		lines.push("(no topics)");
		return `${lines.join("\n")}\n`;
	}
	for (const topic of topics) {
		const topicName = truncateInline(topic.topic, 44).padEnd(44);
		const messages = String(topic.messages).padStart(3);
		const lastAt = formatTsIsoMinute(topic.last_at).padEnd(16);
		const age = formatAgeShort(topic.last_at);
		lines.push(`${topicName} ${messages} ${lastAt} ${age}`);
	}
	return `${lines.join("\n")}\n`;
}

function summarizeEventScalar(value: unknown): string {
	if (value == null) {
		return "null";
	}
	if (typeof value === "string") {
		return truncateInline(value, 28);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.length}]`;
	}
	const rec = asRecord(value);
	if (rec) {
		if (typeof rec.id === "string") {
			return compactId(rec.id, 14);
		}
		if (typeof rec.title === "string") {
			return truncateInline(rec.title, 24);
		}
		const keys = Object.keys(rec);
		if (keys.length === 0) {
			return "{}";
		}
		return `{${keys.slice(0, 2).join(",")}${keys.length > 2 ? ",…" : ""}}`;
	}
	return String(value);
}

function summarizeEventPayload(payload: unknown): string {
	const rec = asRecord(payload);
	if (!rec) {
		return summarizeEventScalar(payload);
	}

	const issue = asRecord(rec.issue);
	if (issue) {
		const parts: string[] = ["issue"];
		if (typeof issue.status === "string") {
			parts.push(`status=${issue.status}`);
		}
		if (typeof issue.title === "string") {
			parts.push(`title=${truncateInline(issue.title, 36)}`);
		}
		return truncateInline(parts.join(" "), 72);
	}

	const message = asRecord(rec.message);
	if (message) {
		const parts: string[] = [];
		if (typeof message.author === "string") {
			parts.push(message.author);
		}
		if (typeof message.topic === "string") {
			parts.push(`@${message.topic}`);
		}
		if (typeof message.body === "string") {
			parts.push(`\"${truncateInline(summarizeBodySingleLine(message.body, 28), 28)}\"`);
		}
		if (parts.length > 0) {
			return truncateInline(parts.join(" "), 72);
		}
	}

	const changed = asRecord(rec.changed);
	if (changed) {
		const keys = Object.keys(changed);
		if (keys.length > 0) {
			return truncateInline(`changed=${keys.join(",")}`, 72);
		}
	}

	const entries = Object.entries(rec).slice(0, 3).map(([key, value]) => `${key}=${summarizeEventScalar(value)}`);
	if (Object.keys(rec).length > 3) {
		entries.push("…");
	}
	if (entries.length === 0) {
		return "{}";
	}
	return truncateInline(entries.join(" "), 72);
}

function renderEventsCompactTable(rows: readonly Record<string, unknown>[]): string {
	const lines = [
		`${"TS (UTC)".padEnd(16)} ${"TYPE".padEnd(18)} ${"SOURCE".padEnd(14)} ${"ISSUE".padEnd(10)} ${"RUN".padEnd(10)} DETAIL`,
	];
	if (rows.length === 0) {
		lines.push("(no events)");
		return `${lines.join("\n")}\n`;
	}
	for (const row of rows) {
		const ts = typeof row.ts_ms === "number" ? Math.trunc(row.ts_ms) : 0;
		const type = typeof row.type === "string" ? row.type : "-";
		const source = typeof row.source === "string" ? row.source : "-";
		const issueId = typeof row.issue_id === "string" ? row.issue_id : "-";
		const runId = typeof row.run_id === "string" ? row.run_id : "-";
		const detail = summarizeEventPayload(row.payload);
		lines.push(
			`${formatTsIsoMinute(ts).padEnd(16)} ${truncateInline(type, 18).padEnd(18)} ${truncateInline(source, 14).padEnd(14)} ${compactId(issueId, 10).padEnd(10)} ${compactId(runId, 10).padEnd(10)} ${truncateInline(detail, 72)}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry != null);
}

function recordString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function recordInt(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return Math.trunc(value);
}

function recordBool(record: Record<string, unknown>, key: string): boolean | null {
	const value = record[key];
	if (typeof value !== "boolean") {
		return null;
	}
	return value;
}

function summarizeRunRow(run: Record<string, unknown>): string {
	const job = recordString(run, "job_id") ?? "-";
	const status = recordString(run, "status") ?? "-";
	const mode = recordString(run, "mode") ?? "-";
	const root = recordString(run, "root_issue_id") ?? "-";
	const steps = recordInt(run, "max_steps");
	const updated = recordInt(run, "updated_at_ms") ?? recordInt(run, "started_at_ms") ?? 0;
	const progress = recordString(run, "last_progress") ?? "";
	return `${compactId(job, 18).padEnd(18)} ${truncateInline(status, 10).padEnd(10)} ${truncateInline(mode, 10).padEnd(10)} ${compactId(root, 10).padEnd(10)} ${String(steps ?? "-").padStart(5)} ${formatAgeShort(updated).padEnd(4)} ${truncateInline(progress, 52)}`;
}

function renderRunsListCompact(payload: Record<string, unknown>): string {
	const runs = asRecordArray(payload.runs);
	const count = recordInt(payload, "count") ?? runs.length;
	const lines = [
		`Runs: ${runs.length} shown (reported count=${count})`,
		`${"JOB".padEnd(18)} ${"STATUS".padEnd(10)} ${"MODE".padEnd(10)} ${"ROOT".padEnd(10)} ${"STEPS".padStart(5)} ${"UPD".padEnd(4)} LAST`,
	];
	if (runs.length === 0) {
		lines.push("(no runs)");
		return `${lines.join("\n")}\n`;
	}
	for (const run of runs) {
		lines.push(summarizeRunRow(run));
	}
	return `${lines.join("\n")}\n`;
}

function renderRunSnapshotCompact(run: Record<string, unknown>): string {
	const job = recordString(run, "job_id") ?? "-";
	const status = recordString(run, "status") ?? "-";
	const mode = recordString(run, "mode") ?? "-";
	const root = recordString(run, "root_issue_id") ?? "-";
	const steps = recordInt(run, "max_steps");
	const started = recordInt(run, "started_at_ms");
	const updated = recordInt(run, "updated_at_ms");
	const finished = recordInt(run, "finished_at_ms");
	const exitCode = recordInt(run, "exit_code");
	const prompt = recordString(run, "prompt");
	const progress = recordString(run, "last_progress");
	const lines = [
		`Run ${job}`,
		`status=${status} mode=${mode} root=${root} steps=${steps ?? "-"}`,
		`started=${formatTsIsoMinute(started ?? 0)} updated=${formatTsIsoMinute(updated ?? 0)} finished=${finished ? formatTsIsoMinute(finished) : "-"}`,
	];
	if (exitCode != null) {
		lines.push(`exit_code=${exitCode}`);
	}
	if (progress) {
		lines.push(`progress: ${truncateInline(progress, 120)}`);
	}
	if (prompt) {
		lines.push(`prompt: ${truncateInline(prompt, 120)}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderRunTraceCompact(payload: Record<string, unknown>): string {
	const run = asRecord(payload.run);
	if (!run) {
		return "(run trace unavailable)\n";
	}
	const stdout = Array.isArray(payload.stdout)
		? payload.stdout.filter((entry): entry is string => typeof entry === "string")
		: [];
	const stderr = Array.isArray(payload.stderr)
		? payload.stderr.filter((entry): entry is string => typeof entry === "string")
		: [];
	const hints = Array.isArray(payload.log_hints)
		? payload.log_hints.filter((entry): entry is string => typeof entry === "string")
		: [];
	const traceFiles = Array.isArray(payload.trace_files)
		? payload.trace_files.filter((entry): entry is string => typeof entry === "string")
		: [];

	const lines = [renderRunSnapshotCompact(run).trimEnd()];
	lines.push(`stdout_lines=${stdout.length} stderr_lines=${stderr.length} hints=${hints.length} trace_files=${traceFiles.length}`);
	if (hints.length > 0) {
		lines.push(`log_hints: ${hints.slice(0, 5).map((hint) => truncateInline(hint, 64)).join(" | ")}`);
	}
	if (traceFiles.length > 0) {
		lines.push(`trace_files: ${traceFiles.slice(0, 5).map((path) => truncateInline(path, 64)).join(" | ")}`);
	}
	if (stdout.length > 0) {
		lines.push("stdout tail:");
		for (const line of stdout.slice(-5)) {
			lines.push(`  ${truncateInline(line, 120)}`);
		}
	}
	if (stderr.length > 0) {
		lines.push("stderr tail:");
		for (const line of stderr.slice(-5)) {
			lines.push(`  ${truncateInline(line, 120)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function renderRunPayloadCompact(payload: Record<string, unknown>): string {
	if (Array.isArray(payload.runs)) {
		return renderRunsListCompact(payload);
	}
	if (payload.run && (Array.isArray(payload.stdout) || Array.isArray(payload.stderr))) {
		return renderRunTraceCompact(payload);
	}
	if (payload.run) {
		const run = asRecord(payload.run);
		if (run) {
			return renderRunSnapshotCompact(run);
		}
	}
	if (recordString(payload, "job_id")) {
		return renderRunSnapshotCompact(payload);
	}
	return `${truncateInline(JSON.stringify(payload), 240)}\n`;
}

function summarizeHeartbeatProgram(program: Record<string, unknown>): string {
	const id = recordString(program, "program_id") ?? "-";
	const enabled = recordBool(program, "enabled");
	const everyMs = recordInt(program, "every_ms");
	const triggered = recordInt(program, "last_triggered_at_ms");
	const lastResult = recordString(program, "last_result") ?? "-";
	const title = recordString(program, "title") ?? "-";
	return `${compactId(id, 18).padEnd(18)} ${(enabled == null ? "-" : enabled ? "y" : "n").padEnd(2)} ${String(everyMs ?? "-").padStart(8)} ${formatAgeShort(triggered ?? 0).padEnd(5)} ${truncateInline(lastResult, 10).padEnd(10)} ${truncateInline(title, 64)}`;
}

function renderHeartbeatProgramCompact(program: Record<string, unknown>): string {
	const id = recordString(program, "program_id") ?? "-";
	const title = recordString(program, "title") ?? "-";
	const enabled = recordBool(program, "enabled");
	const everyMs = recordInt(program, "every_ms");
	const reason = recordString(program, "reason") ?? "-";
	const updated = recordInt(program, "updated_at_ms");
	return [
		`Heartbeat ${id}`,
		`title=${truncateInline(title, 120)}`,
		`enabled=${enabled == null ? "-" : String(enabled)} every_ms=${everyMs ?? "-"} reason=${truncateInline(reason, 80)}`,
		`updated=${formatTsIsoMinute(updated ?? 0)} (${formatAgeShort(updated ?? 0)})`,
	].join("\n") + "\n";
}

function renderHeartbeatsPayloadCompact(payload: Record<string, unknown>): string {
	if (Array.isArray(payload.programs)) {
		const programs = asRecordArray(payload.programs);
		const count = recordInt(payload, "count") ?? programs.length;
		const lines = [
			`Heartbeats: ${programs.length} shown (reported count=${count})`,
			`${"PROGRAM".padEnd(18)} ${"EN".padEnd(2)} ${"EVERY_MS".padStart(8)} ${"LAST".padEnd(5)} ${"RESULT".padEnd(10)} TITLE`,
		];
		if (programs.length === 0) {
			lines.push("(no heartbeat programs)");
			return `${lines.join("\n")}\n`;
		}
		for (const program of programs) {
			lines.push(summarizeHeartbeatProgram(program));
		}
		return `${lines.join("\n")}\n`;
	}
	if (recordString(payload, "program_id")) {
		return renderHeartbeatProgramCompact(payload);
	}
	if (payload.program) {
		const program = asRecord(payload.program);
		if (program) {
			if (recordBool(payload, "ok") === false) {
				return `heartbeat op failed: reason=${recordString(payload, "reason") ?? "unknown"}\n${renderHeartbeatProgramCompact(program)}`;
			}
			return renderHeartbeatProgramCompact(program);
		}
	}
	if (recordBool(payload, "ok") != null) {
		const okStatus = recordBool(payload, "ok") ? "ok" : "failed";
		return `heartbeat op: ${okStatus} reason=${recordString(payload, "reason") ?? "-"}\n`;
	}
	return `${truncateInline(JSON.stringify(payload), 240)}\n`;
}

function summarizeCronSchedule(schedule: Record<string, unknown> | null): string {
	if (!schedule) {
		return "-";
	}
	const kind = recordString(schedule, "kind") ?? "-";
	if (kind === "every") {
		const everyMs = recordInt(schedule, "every_ms");
		return `every ${everyMs ?? "?"}ms`;
	}
	if (kind === "at") {
		const atMs = recordInt(schedule, "at_ms");
		return `at ${formatTsIsoMinute(atMs ?? 0)}`;
	}
	if (kind === "cron") {
		const expr = recordString(schedule, "expr") ?? "?";
		const tz = recordString(schedule, "tz") ?? "UTC";
		return `cron ${truncateInline(expr, 28)} ${tz}`;
	}
	return truncateInline(kind, 32);
}

function summarizeCronProgram(program: Record<string, unknown>): string {
	const id = recordString(program, "program_id") ?? "-";
	const enabled = recordBool(program, "enabled");
	const schedule = summarizeCronSchedule(asRecord(program.schedule));
	const nextRun = recordInt(program, "next_run_at_ms");
	const lastResult = recordString(program, "last_result") ?? "-";
	const title = recordString(program, "title") ?? "-";
	return `${compactId(id, 18).padEnd(18)} ${(enabled == null ? "-" : enabled ? "y" : "n").padEnd(2)} ${truncateInline(schedule, 34).padEnd(34)} ${formatAgeShort(nextRun ?? 0).padEnd(5)} ${truncateInline(lastResult, 10).padEnd(10)} ${truncateInline(title, 42)}`;
}

function renderCronProgramCompact(program: Record<string, unknown>): string {
	const id = recordString(program, "program_id") ?? "-";
	const title = recordString(program, "title") ?? "-";
	const enabled = recordBool(program, "enabled");
	const schedule = summarizeCronSchedule(asRecord(program.schedule));
	const reason = recordString(program, "reason") ?? "-";
	const nextRun = recordInt(program, "next_run_at_ms");
	return [
		`Cron ${id}`,
		`title=${truncateInline(title, 120)}`,
		`enabled=${enabled == null ? "-" : String(enabled)} schedule=${truncateInline(schedule, 96)}`,
		`next_run=${formatTsIsoMinute(nextRun ?? 0)} (${formatAgeShort(nextRun ?? 0)}) reason=${truncateInline(reason, 80)}`,
	].join("\n") + "\n";
}

function renderCronPayloadCompact(payload: Record<string, unknown>): string {
	if (Array.isArray(payload.programs)) {
		const programs = asRecordArray(payload.programs);
		const count = recordInt(payload, "count") ?? programs.length;
		const lines = [
			`Cron programs: ${programs.length} shown (reported count=${count})`,
			`${"PROGRAM".padEnd(18)} ${"EN".padEnd(2)} ${"SCHEDULE".padEnd(34)} ${"NEXT".padEnd(5)} ${"RESULT".padEnd(10)} TITLE`,
		];
		if (programs.length === 0) {
			lines.push("(no cron programs)");
			return `${lines.join("\n")}\n`;
		}
		for (const program of programs) {
			lines.push(summarizeCronProgram(program));
		}
		return `${lines.join("\n")}\n`;
	}
	if (recordInt(payload, "armed_count") != null && Array.isArray(payload.armed)) {
		const armed = asRecordArray(payload.armed);
		const lines = [
			`Cron status: total=${recordInt(payload, "count") ?? 0} enabled=${recordInt(payload, "enabled_count") ?? 0} armed=${recordInt(payload, "armed_count") ?? armed.length}`,
		];
		if (armed.length > 0) {
			lines.push(`${"PROGRAM".padEnd(18)} DUE`);
			for (const row of armed) {
				const id = recordString(row, "program_id") ?? "-";
				const due = recordInt(row, "due_at_ms") ?? 0;
				lines.push(`${compactId(id, 18).padEnd(18)} ${formatTsIsoMinute(due)} (${formatAgeShort(due)})`);
			}
		}
		return `${lines.join("\n")}\n`;
	}
	if (recordString(payload, "program_id")) {
		return renderCronProgramCompact(payload);
	}
	if (payload.program) {
		const program = asRecord(payload.program);
		if (program) {
			if (recordBool(payload, "ok") === false) {
				return `cron op failed: reason=${recordString(payload, "reason") ?? "unknown"}\n${renderCronProgramCompact(program)}`;
			}
			return renderCronProgramCompact(program);
		}
	}
	if (recordBool(payload, "ok") != null) {
		const okStatus = recordBool(payload, "ok") ? "ok" : "failed";
		return `cron op: ${okStatus} reason=${recordString(payload, "reason") ?? "-"}\n`;
	}
	return `${truncateInline(JSON.stringify(payload), 240)}\n`;
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
		`  ${dim("2)")} mu status --pretty`,
		`  ${dim("3)")} mu issues ready --root ${dim("<root-id>")} --pretty`,
		"",
		h("Agent quick navigation:"),
		`  ${dim("Inspect:")}   ${cmd("mu status --pretty")}`,
		`  ${dim("Work queue:")} ${cmd("mu issues ready --root <root-id> --tag role:worker --pretty")}`,
		`  ${dim("Memory:")}    ${cmd("mu memory search --query <text> --limit 20")}`,
		`  ${dim("Index:")}     ${cmd("mu memory index status")} ${dim("/ ")} ${cmd("mu memory index rebuild")}`,
		`  ${dim("Forensics:")} ${cmd("mu store tail events --limit 20")}`,
		"",
		h("Commands (grouped):"),
		`  ${cmd("guide")}                                 ${dim("In-CLI guide")}`,
		`  ${cmd("status")} ${dim("[--json] [--pretty]")}            Repo + work summary`,
		`  ${cmd("issues")} ${dim("<subcmd>")}                       Work-item lifecycle`,
		`  ${cmd("forum")} ${dim("<subcmd>")}                        Coordination topics/messages`,
		`  ${cmd("memory")} ${dim("<subcmd>")}                       Cross-store memory (search/timeline/stats/index)`,
		`  ${cmd("events")} ${dim("<subcmd>")}                       Event-log queries`,
		`  ${cmd("run")} ${dim("<prompt...>")}                       Queue run + attach operator session`,
		`  ${cmd("resume")} ${dim("<root-id>")}                      Resume a run`,
		`  ${cmd("runs")} ${dim("<subcmd>")}                         Queued-run management + traces`,
		`  ${cmd("heartbeats")} ${dim("<subcmd>")}                   Heartbeat program lifecycle`,
		`  ${cmd("cron")} ${dim("<subcmd>")}                         Cron program lifecycle`,
		`  ${cmd("control")} ${dim("<subcmd>")}                      Messaging integrations + identity`,
		`  ${cmd("turn")} ${dim("[opts]")}                            Inject prompt into existing session transcript`,
		`  ${cmd("session")} ${dim("[list|<id>] [opts]")}               Reconnect/list terminal operator sessions`,
		`  ${cmd("serve")} ${dim("[--port N]")}                    Start API + operator session`,
		`  ${cmd("stop")} ${dim("[--force]")}                        Stop background server`,
		`  ${cmd("store")} ${dim("<subcmd>")}                        Inspect workspace store files/logs`,
		`  ${cmd("replay")} ${dim("<id|path>")}                      Replay previous run log`,
		`  ${cmd("login")} ${dim("[<provider>] [--list]")}           Authenticate with an AI provider`,
		"",
		`${h("Output defaults:")} compact-by-default for most read/mutation commands; add --json for full records.`,
		`${dim("Run")} ${cmd("mu <command> --help")} ${dim("for command-specific options/examples.")}`,
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
			return jsonError(
				"`mu init` has been removed. mu now auto-initializes the workspace store on `mu run` and `mu serve`.",
				{
					recovery: ['mu run "Break down and execute this goal"', "mu serve", "mu --help"],
				},
			);
		case "status":
			return await cmdStatus(rest, ctx);
		case "store":
			return await cmdStore(rest, ctx);
		case "issues":
			return await cmdIssues(rest, ctx);
		case "forum":
			return await cmdForum(rest, ctx);
		case "events":
			return await cmdEvents(rest, ctx);
		case "runs":
			return await cmdRuns(rest, ctx);
		case "heartbeats":
			return await cmdHeartbeats(rest, ctx);
		case "cron":
			return await cmdCron(rest, ctx);
		case "memory":
			return await cmdMemoryDelegated(rest, ctx);
		case "context":
			return await cmdMemoryDelegated(rest, ctx);
		case "turn":
			return await cmdTurn(rest, ctx);
		case "run":
			return await cmdRun(rest, ctx);
		case "_run-direct":
			return await cmdRunDirect(rest, ctx);
		case "resume":
			return await cmdResume(rest, ctx);
		case "login":
			return await cmdLogin(rest);
		case "replay":
			return await cmdReplay(rest, ctx);
		case "control":
			return await cmdControl(rest, ctx);
		case "session":
			return await cmdSession(rest, ctx);
		case "serve":
			return await cmdServe(rest, ctx);
		case "stop":
			return await cmdStop(rest, ctx);
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
	const { guideText } = await import("./guide.js");
	return ok(`${guideText()}\n`);
}

function statusCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		jsonError,
		jsonText,
		ok,
	};
}

async function cmdStatus(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStatusCommand(argv, ctx, statusCommandDeps());
}

function storeCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
	};
}

async function cmdStore(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStoreCommand(argv, ctx, storeCommandDeps());
}

async function cmdIssues(argv: string[], ctx: CliCtx): Promise<RunResult> {
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

async function issuesList(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

	if (!jsonMode || compact) {
		return ok(renderIssueCompactTable(issues));
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

async function issuesCreate(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesUpdate(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesClaim(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesOpen(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesClose(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesDep(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesUndep(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesChildren(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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

async function issuesReady(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
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
				"mu forum - append-only coordination messages (JSON + compact output)",
				"",
				"Usage:",
				"  mu forum <command> [args...] [--pretty]",
				"",
				"Commands:",
				"  post     Add a message to a topic",
				"  read     Read recent messages in one topic",
				"  topics   List topics by recency",
				"",
				"Output mode:",
				"  compact-by-default output for forum post/read/topics; add --json for full records.",
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
				"  mu forum post <topic> -m <message> [--author NAME] [--json] [--pretty]",
				"",
				"Options:",
				"  -m, --message <TEXT>   Required message body",
				"  --author <NAME>        Author label (default: operator)",
				"  --json                 Emit full JSON row (default is compact ack)",
				"",
				"Examples:",
				'  mu forum post issue:<id> -m "claimed and starting" --author worker',
				'  mu forum post issue:<id> -m "blocked on env setup" --author worker',
				'  mu forum post research:mu:help-audit -m "notes" --author orchestrator --json --pretty',
			].join("\n") + "\n",
		);
	}

	const topic = argv[0]!;
	const { value: message, rest: argv0 } = getFlagValue(argv.slice(1), "--message");
	const { value: messageShort, rest: argv1 } = getFlagValue(argv0, "-m");
	const { value: author, rest: argv2 } = getFlagValue(argv1, "--author");
	const { present: jsonMode, rest: argv3 } = popFlag(argv2, "--json");
	const { present: compact, rest } = popFlag(argv3, "--compact");

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

	const msg = await ctx.forum.post(topic, msgBody, author ?? "operator");
	if (jsonMode && !compact) {
		return ok(jsonText(msg, pretty));
	}
	return ok(renderForumPostCompact(msg));
}

async function forumRead(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu forum read - read messages from a topic (chronological)",
				"",
				"Usage:",
				"  mu forum read <topic> [--limit N] [--json] [--pretty]",
				"",
				"Options:",
				"  --limit <N>    Number of messages to return (default: 50)",
				"  --json         Emit full JSON rows (default is compact list)",
				"",
				"Examples:",
				"  mu forum read issue:<id>",
				"  mu forum read issue:<id> --limit 20",
				"  mu forum read issue:<id> --json --pretty",
			].join("\n") + "\n",
		);
	}

	const topic = argv[0]!;
	const { value: limitRaw, rest: argv0 } = getFlagValue(argv.slice(1), "--limit");
	const { present: jsonMode, rest: argv1 } = popFlag(argv0, "--json");
	const { present: compact, rest } = popFlag(argv1, "--compact");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu forum read --help"] });
	}

	const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1 }) : 50;
	if (limit == null) {
		return jsonError("limit must be >= 1", { pretty, recovery: [`mu forum read ${topic} --limit 20`] });
	}

	const msgs = await ctx.forum.read(topic, limit);
	if (!jsonMode || compact) {
		return ok(renderForumReadCompact(topic, msgs));
	}
	return ok(jsonText(msgs, pretty));
}

async function forumTopics(argv: string[], ctx: CliCtx, pretty: boolean): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu forum topics - list active topics sorted by most recent message",
				"",
				"Usage:",
				"  mu forum topics [--prefix PREFIX] [--limit N] [--json] [--pretty]",
				"",
				"Options:",
				"  --prefix <PREFIX>   Restrict topics by prefix (e.g. issue:, research:)",
				"  --limit <N>         Max topics returned (default: 100)",
				"  --json              Emit full JSON rows (default is compact table)",
				"",
				"Examples:",
				"  mu forum topics",
				"  mu forum topics --prefix issue:",
				"  mu forum topics --prefix issue: --limit 20 --json --pretty",
			].join("\n") + "\n",
		);
	}

	const { value: prefix, rest: argv0 } = getFlagValue(argv, "--prefix");
	const { value: limitRaw, rest: argv1 } = getFlagValue(argv0, "--limit");
	const { present: jsonMode, rest: argv2 } = popFlag(argv1, "--json");
	const { present: compact, rest } = popFlag(argv2, "--compact");
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
	if (!jsonMode || compact) {
		return ok(renderForumTopicsCompact(topics));
	}
	return ok(jsonText(topics, pretty));
}

function setSearchParamIfPresent(search: URLSearchParams, key: string, value: string | null | undefined): void {
	if (value == null) {
		return;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return;
	}
	search.set(key, trimmed);
}

async function cmdEvents(argv: string[], ctx: CliCtx): Promise<RunResult> {
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

function schedulingCommandDeps() {
	return {
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
	};
}

async function cmdRuns(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunsCommand(argv, ctx, schedulingCommandDeps());
}

async function cmdHeartbeats(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdHeartbeatsCommand(argv, ctx, schedulingCommandDeps());
}

async function cmdCron(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdCronCommand(argv, ctx, schedulingCommandDeps());
}

async function cmdMemoryDelegated(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdMemoryCommand(argv, ctx, {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		setSearchParamIfPresent,
		jsonError,
		jsonText,
		ok,
		describeError,
	});
}

async function cmdTurn(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdTurnCommand(argv, ctx, {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		jsonError,
		ok,
		jsonText,
		describeError,
	});
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

function runCommandDeps() {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		ok,
		runServeLifecycle,
	};
}

async function cmdRun(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunCommand(argv, ctx, runCommandDeps());
}

function runDirectCommandDeps() {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		trimForHeader,
		ensureTrailingNewline,
	};
}

async function cmdRunDirect(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdRunDirectCommand(argv, ctx, runDirectCommandDeps());
}

function resumeCommandDeps() {
	return {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		resolveIssueId,
		trimForHeader,
		ensureTrailingNewline,
	};
}

async function cmdResume(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdResumeCommand(argv, ctx, resumeCommandDeps());
}

function replayCommandDeps() {
	return {
		hasHelpFlag,
		getFlagValue,
		jsonError,
		ok,
		fileExists,
	};
}

async function cmdReplay(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdReplayCommand(argv, ctx, replayCommandDeps());
}

function sessionCommandDeps() {
	return {
		hasHelpFlag,
		getFlagValue,
		popFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
		trimForHeader,
		runServeLifecycle,
	};
}

async function cmdSession(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdSessionCommand(argv, ctx, sessionCommandDeps());
}

async function cmdOperatorSession(
	argv: string[],
	ctx: CliCtx,
	options: OperatorSessionCommandOptions = {},
): Promise<RunResult> {
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu serve - operator session (server + terminal)",
				"",
				"Usage:",
				"  mu serve [--port N] [--provider ID] [--model ID] [--thinking LEVEL]",
				"",
				"Options:",
				"  --port N               Server port (default: 3000)",
				"  --provider ID          LLM provider for operator session",
				"  --model ID             Model ID (default: gpt-5.3-codex)",
				"  --thinking LEVEL       Thinking level (minimal|low|medium|high)",
				"",
				"Examples:",
				"  mu serve",
				"  mu serve --port 8080",
				"",
				"See also: `mu guide`, `mu control status`",
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
				recovery: ["mu serve --help"],
			});
		}
	}

	let message = messageLong ?? messageShort;
	if (message != null && message.trim().length === 0) {
		return jsonError("message must not be empty", {
			recovery: ["mu serve --help"],
		});
	}

	if (rest.length > 0) {
		if (rest.some((arg) => arg.startsWith("-"))) {
			return jsonError(`unknown args: ${rest.join(" ")}`, {
				recovery: ["mu serve --help"],
			});
		}
		const positionalMessage = rest.join(" ").trim();
		if (positionalMessage.length > 0) {
			if (message != null) {
				return jsonError("provide either --message/-m or positional text, not both", {
					recovery: ["mu serve --help"],
				});
			}
			message = positionalMessage;
		}
	}

	if (jsonMode && message == null) {
		return jsonError("--json requires --message", {
			recovery: ["mu serve --help"],
		});
	}

	const { DEFAULT_OPERATOR_SYSTEM_PROMPT } = await import("@femtomc/mu-agent");
	const provider = providerRaw?.trim() || undefined;
	const model = modelRaw?.trim() || undefined;
	const thinking = thinkingRaw?.trim() || undefined;
	const systemPrompt = systemPromptRaw?.trim() || DEFAULT_OPERATOR_SYSTEM_PROMPT;

	const createOperatorSession = async (): Promise<OperatorSession> => {
		if (ctx.operatorSessionFactory) {
			return ctx.operatorSessionFactory({ cwd: ctx.repoRoot, systemPrompt, provider, model, thinking });
		}

		const { createMuSession } = await import("@femtomc/mu-agent");
		const requestedSession = options.session ?? defaultOperatorSessionStart(ctx.repoRoot);
		const session = await createMuSession({
			cwd: ctx.repoRoot,
			systemPrompt,
			provider,
			model,
			thinking,
			extensionPaths: ctx.serveExtensionPaths,
			session: {
				mode: requestedSession.mode,
				sessionDir: requestedSession.sessionDir,
				sessionFile: requestedSession.sessionFile,
			},
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
			recovery: ["mu serve --help"],
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
		typeof rec.max_steps === "number" && Number.isFinite(rec.max_steps) ? Math.max(1, Math.trunc(rec.max_steps)) : 20;
	return {
		job_id: jobId,
		root_issue_id: rootIssueId,
		max_steps: maxSteps,
		mode: typeof rec.mode === "string" ? rec.mode : undefined,
		status: typeof rec.status === "string" ? rec.status : undefined,
		source: typeof rec.source === "string" ? rec.source : undefined,
	};
}

async function detectRunningServer(repoRoot: string): Promise<{ url: string; port: number; pid: number } | null> {
	const discoveryPath = storePathForRepoRoot(repoRoot, "control-plane", "server.json");
	try {
		const raw = await Bun.file(discoveryPath).text();
		const parsed = JSON.parse(raw.trim());
		const pid = parsed?.pid;
		const port = parsed?.port;
		if (typeof pid !== "number" || typeof port !== "number") return null;

		// Check if PID is alive
		try {
			process.kill(pid, 0);
		} catch {
			// PID dead — clean up stale discovery files
			cleanupStaleServerFiles(repoRoot);
			return null;
		}

		// Probe health endpoint
		const url = `http://localhost:${port}`;
		try {
			const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return { url, port, pid };
		} catch {
			/* server not responding — PID alive but not healthy yet or different process */
		}
		return null;
	} catch {
		return null;
	}
}

async function requireRunningServer(
	ctx: CliCtx,
	opts: { pretty: boolean; recoveryCommand: string },
): Promise<{ url: string } | RunResult> {
	const running = await detectRunningServer(ctx.repoRoot);
	if (running) {
		return { url: running.url };
	}
	return jsonError("no running server found", {
		pretty: opts.pretty,
		recovery: [opts.recoveryCommand, "mu serve"],
	});
}

async function requestServerJson<T>(opts: {
	ctx: CliCtx;
	pretty: boolean;
	method?: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	recoveryCommand: string;
}): Promise<{ ok: true; payload: T } | { ok: false; result: RunResult }> {
	const resolved = await requireRunningServer(opts.ctx, {
		pretty: opts.pretty,
		recoveryCommand: opts.recoveryCommand,
	});
	if ("exitCode" in resolved) {
		return { ok: false, result: resolved };
	}
	const url = `${resolved.url}${opts.path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: opts.method ?? "GET",
			headers: opts.body ? { "Content-Type": "application/json" } : undefined,
			body: opts.body ? JSON.stringify(opts.body) : undefined,
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		return {
			ok: false,
			result: jsonError(`server request failed: ${describeError(err)}`, {
				pretty: opts.pretty,
				recovery: [opts.recoveryCommand, "mu serve"],
			}),
		};
	}

	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}

	if (!response.ok) {
		const detail = await readApiError(response, payload);
		return {
			ok: false,
			result: jsonError(`request failed: ${detail}`, {
				pretty: opts.pretty,
				recovery: [opts.recoveryCommand],
			}),
		};
	}

	return { ok: true, payload: payload as T };
}

function cleanupStaleServerFiles(repoRoot: string): void {
	try {
		rmSync(storePathForRepoRoot(repoRoot, "control-plane", "server.json"), { force: true });
	} catch {
		// best-effort
	}
	try {
		rmSync(storePathForRepoRoot(repoRoot, "control-plane", "writer.lock"), { force: true });
	} catch {
		// best-effort
	}
}

function resolveServerCliPath(): string {
	// Resolve the mu-server CLI entry point from the @femtomc/mu-server package.
	// In the workspace, the source entry is src/cli.ts; in a dist build, dist/cli.js.
	const pkgDir = dirname(require.resolve("@femtomc/mu-server/package.json"));
	const srcCli = join(pkgDir, "src", "cli.ts");
	if (existsSync(srcCli)) return srcCli;
	return join(pkgDir, "dist", "cli.js");
}

async function pollUntilHealthy(url: string, timeoutMs: number, intervalMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) });
			if (res.ok) return;
		} catch {
			// not ready yet
		}
		await delayMs(intervalMs);
	}
	throw new Error(
		`server at ${url} did not become healthy within ${timeoutMs}ms — check the workspace control-plane server log`,
	);
}

function buildServeDeps(ctx: CliCtx): ServeDeps {
	const defaults: ServeDeps = {
		startServer: async ({ repoRoot, port }) => {
			const { composeServerRuntime, createServerFromRuntime } = await import("@femtomc/mu-server");
			const runtime = await composeServerRuntime({ repoRoot });
			const serverConfig = createServerFromRuntime(runtime, { port });

			let server: ReturnType<typeof Bun.serve>;
			try {
				server = Bun.serve(serverConfig);
			} catch (err) {
				try {
					await runtime.controlPlane?.stop();
				} catch {
					// Best effort cleanup. Preserve the original startup error.
				}
				throw err;
			}

			const discoveryPath = storePathForRepoRoot(repoRoot, "control-plane", "server.json");
			await mkdir(dirname(discoveryPath), { recursive: true });
			await Bun.write(
				discoveryPath,
				JSON.stringify({ pid: process.pid, port, url: `http://localhost:${port}` }) + "\n",
			);

			return {
				activeAdapters: runtime.controlPlane?.activeAdapters ?? [],
				stop: async () => {
					try {
						rmSync(discoveryPath, { force: true });
					} catch {
						// best-effort
					}
					await runtime.controlPlane?.stop();
					server.stop();
				},
			};
		},
		spawnBackgroundServer: async ({ repoRoot, port }) => {
			const serverCliPath = resolveServerCliPath();
			const logDir = storePathForRepoRoot(repoRoot, "control-plane");
			await mkdir(logDir, { recursive: true });
			const logFile = join(logDir, "server.log");
			const logFd = openSync(logFile, "w");

			const proc = Bun.spawn({
				cmd: [process.execPath, serverCliPath, "--port", String(port), "--repo-root", repoRoot],
				cwd: repoRoot,
				stdin: "ignore",
				stdout: logFd,
				stderr: logFd,
			});
			proc.unref();

			const url = `http://localhost:${port}`;
			await pollUntilHealthy(url, 15_000, 200);
			return { pid: proc.pid, url };
		},
		requestServerShutdown: async ({ serverUrl }) => {
			try {
				const res = await fetch(`${serverUrl}/api/server/shutdown`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
					signal: AbortSignal.timeout(5_000),
				});
				if (res.ok) return { ok: true };
				return { ok: false };
			} catch {
				return { ok: false };
			}
		},
		runOperatorSession: async ({ onReady, provider, model, thinking, sessionMode, sessionDir, sessionFile }) => {
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
			const requestedSession: OperatorSessionStartOpts = sessionMode
				? {
						mode: sessionMode,
						sessionDir,
						sessionFile,
					}
				: defaultOperatorSessionStart(ctx.repoRoot);
			return await cmdOperatorSession(
				operatorArgv,
				{ ...ctx, serveExtensionPaths: ctx.serveExtensionPaths ?? operatorExtensionPaths },
				{
					onInteractiveReady: onReady,
					session: requestedSession,
				},
			);
		},
		queueRun: async ({ serverUrl, prompt, maxSteps, provider, model, reasoning }) => {
			const response = await fetch(`${serverUrl}/api/control-plane/runs/start`, {
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
		registerProcessExitHandler: (handler) => {
			process.on("exit", handler);
			return () => {
				if (typeof process.off === "function") {
					process.off("exit", handler);
					return;
				}
				process.removeListener("exit", handler);
			};
		},
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
	const operatorThinking = opts.operatorThinking ?? operatorDefaults.thinking;
	const operatorSession = opts.operatorSession ?? defaultOperatorSessionStart(ctx.repoRoot);

	const io = ctx.io;
	const deps = buildServeDeps(ctx);

	// Step 1: Discover or spawn a background server
	let serverUrl: string;
	const existingServer = await detectRunningServer(ctx.repoRoot);
	if (existingServer) {
		serverUrl = existingServer.url;
		io?.stderr?.write(`mu: connecting to existing server at ${serverUrl} (pid ${existingServer.pid})\n`);
	} else {
		// Spawn server as a detached background process
		try {
			const spawned = await deps.spawnBackgroundServer({ repoRoot: ctx.repoRoot, port: opts.port });
			serverUrl = spawned.url;
			io?.stderr?.write(`mu: started background server at ${serverUrl} (pid ${spawned.pid})\n`);
		} catch (err) {
			return jsonError(`failed to start server: ${describeError(err)}`, {
				recovery: [
					`mu ${opts.commandName} --port 3000`,
					`mu ${opts.commandName} --help`,
					"check workspace control-plane server.log",
				],
			});
		}
	}

	Bun.env.MU_SERVER_URL = serverUrl;

	// Step 2: Run pre-operator hooks (mu run: queue work before operator attach)
	if (opts.beforeOperatorSession) {
		try {
			await opts.beforeOperatorSession({ serverUrl, deps, io });
		} catch (err) {
			return jsonError(`failed to prepare run lifecycle: ${describeError(err)}`, {
				recovery: [`mu ${opts.commandName} --help`, "mu serve --help", "mu run --help"],
			});
		}
	}

	// Step 3: Run operator TUI (blocks until Ctrl+D / exit)
	let operatorConnected = false;
	const onOperatorReady = (): void => {
		if (operatorConnected) return;
		operatorConnected = true;
	};

	let resolveSignal: ((signal: NodeJS.Signals) => void) | null = null;
	const signalPromise = new Promise<NodeJS.Signals>((resolve) => {
		resolveSignal = resolve;
	});
	let receivedSignal: NodeJS.Signals | null = null;
	const onSignal = (signal: NodeJS.Signals): void => {
		if (receivedSignal != null) return;
		receivedSignal = signal;
		resolveSignal?.(signal);
	};
	const removeSignalHandlers = [
		deps.registerSignalHandler("SIGINT", () => onSignal("SIGINT")),
		deps.registerSignalHandler("SIGTERM", () => onSignal("SIGTERM")),
	];
	const unregisterSignals = () => {
		for (const remove of removeSignalHandlers) {
			try {
				remove();
			} catch {
				/* no-op */
			}
		}
	};

	let result: RunResult;
	try {
		const operatorPromise = deps
			.runOperatorSession({
				onReady: onOperatorReady,
				provider: operatorProvider,
				model: operatorModel,
				thinking: operatorThinking,
				sessionMode: operatorSession.mode,
				sessionDir: operatorSession.sessionDir,
				sessionFile: operatorSession.sessionFile,
			})
			.catch((err) =>
				jsonError(`operator session crashed: ${describeError(err)}`, {
					recovery: [`mu ${opts.commandName} --help`, "mu serve --help"],
				}),
			);

		const winner = await Promise.race([
			operatorPromise.then((operatorResult) => ({ kind: "operator" as const, operatorResult })),
			signalPromise.then((signal) => ({ kind: "signal" as const, signal })),
		]);

		if (winner.kind === "signal") {
			await Promise.race([operatorPromise, delayMs(1_000)]);
			result = { stdout: "", stderr: "", exitCode: signalExitCode(winner.signal) };
		} else {
			if (winner.operatorResult.exitCode !== 0 && !operatorConnected) {
				io?.stderr?.write("mu: operator terminal failed to connect.\n");
			}
			result = winner.operatorResult;
		}
	} finally {
		unregisterSignals();
		// TUI exits — server keeps running in the background.
		// No stopServer(), no lock cleanup.
	}

	return result;
}

function serveCommandDeps() {
	return {
		hasHelpFlag,
		getFlagValue,
		popFlag,
		ensureInt,
		jsonError,
		ok,
		delayMs,
		detectRunningServer,
		buildServeDeps,
		cleanupStaleServerFiles,
		runServeLifecycle,
	};
}

async function cmdServe(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdServeCommand(argv, ctx, serveCommandDeps());
}

async function cmdStop(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdStopCommand(argv, ctx, serveCommandDeps());
}

// ROLE_SCOPES lives in @femtomc/mu-control-plane; lazy-imported alongside IdentityStore.

function controlCommandDeps() {
	return {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		getRepeatFlagValues,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		fileExists,
		nonEmptyString,
		describeError,
		storePathForRepoRoot,
		detectRunningServer,
		readApiError,
	};
}

async function cmdControl(argv: string[], ctx: CliCtx): Promise<RunResult> {
	return await cmdControlCommand(argv, ctx, controlCommandDeps());
}
