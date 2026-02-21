import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";

type IssueStatus = "open" | "in_progress" | "closed";

type IssueDigest = {
	id: string;
	title: string;
	status: IssueStatus;
	priority: number;
	tags: string[];
};

type SpawnMode = "worker" | "reviewer" | "researcher";

type SubagentsState = {
	enabled: boolean;
	prefix: string;
	sessions: string[];
	sessionError: string | null;
	issueRootId: string | null;
	issueRoleTag: string | null;
	readyIssues: IssueDigest[];
	activeIssues: IssueDigest[];
	issueError: string | null;
	lastUpdatedMs: number | null;
	refreshIntervalMs: number;
	staleAfterMs: number;
	spawnPaused: boolean;
	spawnMode: SpawnMode;
};

type MuCliOutcome = {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error: string | null;
};

type SubagentsToolAction =
	| "status"
	| "snapshot"
	| "on"
	| "off"
	| "toggle"
	| "refresh"
	| "set_prefix"
	| "set_root"
	| "set_role"
	| "set_mode"
	| "set_refresh_interval"
	| "set_stale_after"
	| "set_spawn_paused"
	| "update"
	| "spawn";

type SubagentsToolParams = {
	action: SubagentsToolAction;
	prefix?: string;
	root_issue_id?: string;
	role_tag?: string;
	count?: number | "all";
	spawn_mode?: string;
	refresh_seconds?: number;
	stale_after_seconds?: number;
	spawn_paused?: boolean;
	snapshot_format?: string;
};

const DEFAULT_PREFIX = "mu-sub-";
const DEFAULT_ROLE_TAG = "role:worker";
const DEFAULT_SPAWN_MODE: SpawnMode = "worker";
const ISSUE_LIST_LIMIT = 40;
const MU_CLI_TIMEOUT_MS = 12_000;
const DEFAULT_REFRESH_INTERVAL_MS = 8_000;
const MIN_REFRESH_SECONDS = 2;
const MAX_REFRESH_SECONDS = 120;
const DEFAULT_STALE_AFTER_MS = 60_000;
const MIN_STALE_SECONDS = 10;
const MAX_STALE_SECONDS = 3_600;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function spawnRunId(now = new Date()): string {
	return now
		.toISOString()
		.replaceAll(/[-:TZ.]/g, "")
		.slice(0, 14);
}

function sessionMatchesIssue(sessionName: string, issueId: string): boolean {
	return (
		sessionName === issueId ||
		sessionName.endsWith(`-${issueId}`) ||
		sessionName.includes(`-${issueId}-`) ||
		sessionName.includes(`_${issueId}`)
	);
}

function issueHasSession(sessions: readonly string[], issueId: string): boolean {
	return sessions.some((sessionName) => sessionMatchesIssue(sessionName, issueId));
}

function buildSubagentPrompt(issue: IssueDigest, mode: SpawnMode): string {
	switch (mode) {
		case "worker":
			return [
				`Work issue ${issue.id} (${truncateOneLine(issue.title, 80)}).`,
				`First run: mu issues claim ${issue.id}.`,
				`Keep forum updates in topic issue:${issue.id}.`,
				"When done, close with an explicit outcome and summary.",
			].join(" ");
		case "reviewer":
			return [
				`Review issue ${issue.id} (${truncateOneLine(issue.title, 80)}).`,
				`First run: mu issues claim ${issue.id}.`,
				"Validate acceptance criteria with concrete checks and evidence.",
				"Post PASS/FAIL verdict, blockers, and required fixes in topic issue:<id>.",
				"Close the issue with explicit outcome and review summary.",
			].join(" ");
		case "researcher":
			return [
				`Research issue ${issue.id} (${truncateOneLine(issue.title, 80)}).`,
				`First run: mu issues claim ${issue.id}.`,
				"Collect concrete evidence and options; call out uncertainty explicitly.",
				`Keep findings in topic issue:${issue.id}.`,
				"Close the issue with a concise recommendation and rationale.",
			].join(" ");
	}
}

async function spawnIssueTmuxSession(opts: {
	cwd: string;
	sessionName: string;
	issue: IssueDigest;
	mode: SpawnMode;
}): Promise<{ ok: boolean; error: string | null }> {
	const shellCommand = `cd ${shellQuote(opts.cwd)} && mu exec ${shellQuote(buildSubagentPrompt(opts.issue, opts.mode))} ; rc=$?; echo __MU_DONE__:$rc`;

	let proc: Bun.Subprocess | null = null;
	try {
		proc = Bun.spawn({
			cmd: ["tmux", "new-session", "-d", "-s", opts.sessionName, shellCommand],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `failed to launch tmux session: ${message}` };
	}

	const [exitCode, stderr] = await Promise.all([proc.exited, readableText(proc.stderr)]);
	if (exitCode !== 0) {
		const detail = stderr.trim();
		return { ok: false, error: detail.length > 0 ? detail : `tmux exited ${exitCode}` };
	}
	return { ok: true, error: null };
}

function readableText(stream: unknown): Promise<string> {
	if (stream && typeof stream === "object" && "getReader" in stream) {
		return new Response(stream as ReadableStream).text().catch(() => "");
	}
	return Promise.resolve("");
}

function createDefaultState(): SubagentsState {
	return {
		enabled: false,
		prefix: DEFAULT_PREFIX,
		sessions: [],
		sessionError: null,
		issueRootId: null,
		issueRoleTag: DEFAULT_ROLE_TAG,
		readyIssues: [],
		activeIssues: [],
		issueError: null,
		lastUpdatedMs: null,
		refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
		staleAfterMs: DEFAULT_STALE_AFTER_MS,
		spawnPaused: false,
		spawnMode: DEFAULT_SPAWN_MODE,
	};
}

function truncateOneLine(input: string, maxLen = 68): string {
	const compact = input.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLen) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLen - 1))}…`;
}

function summarizeFailure(label: string, outcome: MuCliOutcome): string {
	if (outcome.error) {
		return `${label}: ${outcome.error}`;
	}
	if (outcome.timedOut) {
		return `${label}: timed out after ${MU_CLI_TIMEOUT_MS}ms`;
	}
	const stderr = outcome.stderr.trim();
	if (stderr.length > 0) {
		return `${label}: ${stderr}`;
	}
	const stdout = outcome.stdout.trim();
	if (stdout.length > 0) {
		return `${label}: ${truncateOneLine(stdout, 120)}`;
	}
	return `${label}: exit ${outcome.exitCode}`;
}

function normalizeIssueDigest(row: unknown): IssueDigest | null {
	if (!row || typeof row !== "object") {
		return null;
	}
	const value = row as Record<string, unknown>;
	const id = typeof value.id === "string" ? value.id.trim() : "";
	const title = typeof value.title === "string" ? value.title : "";
	const status = value.status;
	const priorityRaw = value.priority;
	const tagsRaw = value.tags;
	if (!id || !title) {
		return null;
	}
	if (status !== "open" && status !== "in_progress" && status !== "closed") {
		return null;
	}
	const priority = typeof priorityRaw === "number" && Number.isFinite(priorityRaw) ? Math.trunc(priorityRaw) : 3;
	const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((tag): tag is string => typeof tag === "string") : [];
	return {
		id,
		title,
		status,
		priority,
		tags,
	};
}

function parseIssueArray(label: string, jsonText: string): { issues: IssueDigest[]; error: string | null } {
	const trimmed = jsonText.trim();
	if (trimmed.length === 0) {
		return { issues: [], error: null };
	}

	let parsed: unknown = null;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { issues: [], error: `${label}: invalid JSON output from mu issues command` };
	}
	if (!Array.isArray(parsed)) {
		return { issues: [], error: `${label}: expected JSON array output from mu issues command` };
	}
	const issues = parsed.map(normalizeIssueDigest).filter((issue): issue is IssueDigest => issue !== null);
	issues.sort((left, right) => {
		if (left.priority !== right.priority) {
			return left.priority - right.priority;
		}
		return left.id.localeCompare(right.id);
	});
	return { issues, error: null };
}

async function runMuCli(args: string[]): Promise<MuCliOutcome> {
	let proc: Bun.Subprocess | null = null;
	try {
		proc = Bun.spawn({
			cmd: ["mu", ...args],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			exitCode: 1,
			stdout: "",
			stderr: "",
			timedOut: false,
			error: `failed to launch mu CLI (${message})`,
		};
	}

	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		proc?.kill();
	}, MU_CLI_TIMEOUT_MS);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		readableText(proc.stdout),
		readableText(proc.stderr),
	]);
	clearTimeout(timeout);
	return {
		exitCode,
		stdout,
		stderr,
		timedOut,
		error: null,
	};
}

async function listTmuxSessions(prefix: string): Promise<{ sessions: string[]; error: string | null }> {
	let proc: Bun.Subprocess | null = null;
	try {
		proc = Bun.spawn({
			cmd: ["tmux", "ls"],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { sessions: [], error: `failed to launch tmux: ${message}` };
	}

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		readableText(proc.stdout),
		readableText(proc.stderr),
	]);
	const stderrTrimmed = stderr.trim();

	if (exitCode !== 0) {
		const lowered = stderrTrimmed.toLowerCase();
		if (lowered.includes("no server running") || lowered.includes("failed to connect to server")) {
			return { sessions: [], error: null };
		}
		const detail = stderrTrimmed.length > 0 ? stderrTrimmed : `tmux exited ${exitCode}`;
		return { sessions: [], error: detail };
	}

	const sessions = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const colon = line.indexOf(":");
			return colon >= 0 ? line.slice(0, colon).trim() : line;
		})
		.filter((name) => name.length > 0)
		.filter((name) => (prefix.length > 0 ? name.startsWith(prefix) : true))
		.sort((left, right) => left.localeCompare(right));

	return { sessions, error: null };
}

async function listIssueSlices(
	rootId: string | null,
	roleTag: string | null,
): Promise<{
	ready: IssueDigest[];
	active: IssueDigest[];
	error: string | null;
}> {
	const readyArgs = ["issues", "ready", "--json", "--limit", String(ISSUE_LIST_LIMIT)];
	const activeArgs = ["issues", "list", "--status", "in_progress", "--json", "--limit", String(ISSUE_LIST_LIMIT)];
	if (rootId) {
		readyArgs.push("--root", rootId);
		activeArgs.push("--root", rootId);
	}
	if (roleTag) {
		readyArgs.push("--tag", roleTag);
		activeArgs.push("--tag", roleTag);
	}

	const [readyOutcome, activeOutcome] = await Promise.all([runMuCli(readyArgs), runMuCli(activeArgs)]);
	if (readyOutcome.exitCode !== 0 || readyOutcome.error || readyOutcome.timedOut) {
		return {
			ready: [],
			active: [],
			error: summarizeFailure("ready", readyOutcome),
		};
	}
	if (activeOutcome.exitCode !== 0 || activeOutcome.error || activeOutcome.timedOut) {
		return {
			ready: [],
			active: [],
			error: summarizeFailure("in-progress", activeOutcome),
		};
	}

	const readyParsed = parseIssueArray("ready", readyOutcome.stdout);
	if (readyParsed.error) {
		return { ready: [], active: [], error: readyParsed.error };
	}
	const activeParsed = parseIssueArray("in-progress", activeOutcome.stdout);
	if (activeParsed.error) {
		return { ready: [], active: [], error: activeParsed.error };
	}

	return {
		ready: readyParsed.issues,
		active: activeParsed.issues,
		error: null,
	};
}

function formatIssueLine(
	ctx: ExtensionContext,
	issue: IssueDigest,
	opts: { marker?: string; tone?: "accent" | "success" | "warning" } = {},
): string {
	const marker = opts.marker ?? "•";
	const tone = opts.tone ?? "accent";
	const id = ctx.ui.theme.fg("dim", issue.id);
	const priority = ctx.ui.theme.fg("muted", `p${issue.priority}`);
	const title = ctx.ui.theme.fg("text", truncateOneLine(issue.title));
	return `  ${ctx.ui.theme.fg(tone, marker)} ${id} ${priority} ${title}`;
}

function queueMeter(value: number, total: number, width = 10): string {
	if (width <= 0 || total <= 0) {
		return "";
	}
	const clamped = Math.max(0, Math.min(total, value));
	const full = Math.floor((clamped / total) * width);
	const empty = Math.max(0, width - full);
	return "█".repeat(full) + "░".repeat(empty);
}

function formatRefreshAge(lastUpdatedMs: number | null): string {
	if (lastUpdatedMs == null) {
		return "never";
	}
	const deltaSec = Math.max(0, Math.round((Date.now() - lastUpdatedMs) / 1000));
	if (deltaSec < 60) {
		return `${deltaSec}s ago`;
	}
	const mins = Math.floor(deltaSec / 60);
	if (mins < 60) {
		return `${mins}m ago`;
	}
	const hours = Math.floor(mins / 60);
	return `${hours}h ago`;
}

function isRefreshStale(lastUpdatedMs: number | null, staleAfterMs: number): boolean {
	if (lastUpdatedMs == null) {
		return false;
	}
	return Date.now() - lastUpdatedMs > staleAfterMs;
}

function computeQueueDrift(
	sessions: readonly string[],
	activeIssues: readonly IssueDigest[],
): {
	activeWithoutSessionIds: string[];
	orphanSessions: string[];
} {
	const activeWithoutSessionIds = activeIssues
		.filter((issue) => !issueHasSession(sessions, issue.id))
		.map((issue) => issue.id);
	const orphanSessions = sessions.filter(
		(sessionName) => !activeIssues.some((issue) => sessionMatchesIssue(sessionName, issue.id)),
	);
	return {
		activeWithoutSessionIds,
		orphanSessions,
	};
}

function normalizeRoleTag(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.toLowerCase() === "clear") {
		return null;
	}
	if (trimmed === "worker" || trimmed === "orchestrator" || trimmed === "reviewer" || trimmed === "researcher") {
		return `role:${trimmed}`;
	}
	return trimmed;
}

function parseSpawnMode(raw: string): SpawnMode | null {
	const value = raw.trim().toLowerCase();
	if (value === "worker" || value === "reviewer" || value === "researcher") {
		return value;
	}
	return null;
}

function parseOnOff(raw: string | undefined): boolean | null {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "on" || value === "yes" || value === "true" || value === "1") {
		return true;
	}
	if (value === "off" || value === "no" || value === "false" || value === "0") {
		return false;
	}
	return null;
}

function parseSnapshotFormat(raw: string | undefined): "compact" | "multiline" {
	const value = (raw ?? "compact").trim().toLowerCase();
	return value === "multiline" ? "multiline" : "compact";
}

function parseSecondsBounded(
	secondsRaw: unknown,
	minSeconds: number,
	maxSeconds: number,
	field: string,
): { ok: true; ms: number } | { ok: false; error: string } {
	if (typeof secondsRaw !== "number" || !Number.isFinite(secondsRaw)) {
		return { ok: false, error: `${field} must be a number.` };
	}
	const rounded = Math.round(secondsRaw);
	if (rounded < minSeconds || rounded > maxSeconds) {
		return { ok: false, error: `${field} must be ${minSeconds}-${maxSeconds} seconds.` };
	}
	return { ok: true, ms: rounded * 1_000 };
}

function subagentsSnapshot(state: SubagentsState, format: "compact" | "multiline"): string {
	const issueScope = state.issueRootId ?? "(all roots)";
	const roleScope = state.issueRoleTag ?? "(all roles)";
	const drift = computeQueueDrift(state.sessions, state.activeIssues);
	const refreshStale = isRefreshStale(state.lastUpdatedMs, state.staleAfterMs);
	const staleCount = drift.activeWithoutSessionIds.length + drift.orphanSessions.length;
	const health = state.issueError || state.sessionError || refreshStale || staleCount > 0 ? "degraded" : "healthy";
	const refreshAge = formatRefreshAge(state.lastUpdatedMs);
	const paused = state.spawnPaused ? "yes" : "no";
	const refreshSeconds = Math.round(state.refreshIntervalMs / 1_000);
	const staleAfterSeconds = Math.round(state.staleAfterMs / 1_000);
	if (format === "multiline") {
		return [
			"Subagents HUD snapshot",
			`health: ${health}`,
			`prefix: ${state.prefix || "(all sessions)"}`,
			`issue_root: ${issueScope}`,
			`issue_role: ${roleScope}`,
			`spawn_mode: ${state.spawnMode}`,
			`spawn_paused: ${paused}`,
			`queues: ${state.readyIssues.length} ready / ${state.activeIssues.length} active`,
			`sessions: ${state.sessions.length}`,
			`drift_active_without_session: ${drift.activeWithoutSessionIds.length}`,
			`drift_orphan_sessions: ${drift.orphanSessions.length}`,
			`refresh_age: ${refreshAge}`,
			`refresh_stale: ${refreshStale ? "yes" : "no"}`,
			`refresh_seconds: ${refreshSeconds}`,
			`stale_after_seconds: ${staleAfterSeconds}`,
		].join("\n");
	}
	return [
		"HUD(subagents)",
		`health=${health}`,
		`root=${issueScope}`,
		`role=${roleScope}`,
		`mode=${state.spawnMode}`,
		`paused=${paused}`,
		`ready=${state.readyIssues.length}`,
		`active=${state.activeIssues.length}`,
		`sessions=${state.sessions.length}`,
		`drift=${staleCount}`,
		`refresh=${refreshAge}`,
	].join(" · ");
}

function renderSubagentsUi(ctx: ExtensionContext, state: SubagentsState): void {
	if (!ctx.hasUI) {
		return;
	}
	if (!state.enabled) {
		ctx.ui.setStatus("mu-subagents", undefined);
		ctx.ui.setWidget("mu-subagents", undefined);
		return;
	}

	const issueScope = state.issueRootId ? `root:${state.issueRootId}` : "all-roots";
	const roleScope = state.issueRoleTag ? state.issueRoleTag : "(all roles)";
	const refreshStale = isRefreshStale(state.lastUpdatedMs, state.staleAfterMs);
	const drift = computeQueueDrift(state.sessions, state.activeIssues);
	const staleCount = drift.activeWithoutSessionIds.length + drift.orphanSessions.length;
	const hasError = Boolean(state.sessionError || state.issueError || refreshStale || staleCount > 0);
	const healthColor: "success" | "warning" = hasError ? "warning" : "success";
	const healthLabel = hasError ? "degraded" : "healthy";
	const queueTotal = state.readyIssues.length + state.activeIssues.length;
	const queueBar = queueMeter(state.activeIssues.length, Math.max(1, queueTotal), 10);
	const refreshAge = formatRefreshAge(state.lastUpdatedMs);
	const pausedLabel = state.spawnPaused ? "yes" : "no";
	const pausedColor: "warning" | "dim" = state.spawnPaused ? "warning" : "dim";
	const refreshSeconds = Math.round(state.refreshIntervalMs / 1_000);
	const staleAfterSeconds = Math.round(state.staleAfterMs / 1_000);

	ctx.ui.setStatus(
		"mu-subagents",
		[
			ctx.ui.theme.fg("dim", "subagents"),
			ctx.ui.theme.fg(healthColor, healthLabel),
			ctx.ui.theme.fg("dim", `${state.spawnMode}`),
			ctx.ui.theme.fg(pausedColor, `paused:${pausedLabel}`),
			ctx.ui.theme.fg("dim", `${state.sessions.length} tmux`),
			ctx.ui.theme.fg("dim", `${state.readyIssues.length} ready/${state.activeIssues.length} active`),
			ctx.ui.theme.fg("muted", issueScope),
		].join(` ${ctx.ui.theme.fg("muted", "·")} `),
	);

	const lines = [
		ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Subagents board")),
		`  ${ctx.ui.theme.fg("muted", "health:")} ${ctx.ui.theme.fg(healthColor, healthLabel)}`,
		`  ${ctx.ui.theme.fg("muted", "scope:")} ${ctx.ui.theme.fg("dim", `${issueScope} · ${roleScope}`)}`,
		`  ${ctx.ui.theme.fg("muted", "tmux prefix:")} ${ctx.ui.theme.fg("dim", state.prefix || "(all sessions)")}`,
		`  ${ctx.ui.theme.fg("muted", "spawn mode:")} ${ctx.ui.theme.fg("accent", state.spawnMode)}`,
		`  ${ctx.ui.theme.fg("muted", "spawn paused:")} ${ctx.ui.theme.fg(pausedColor, pausedLabel)}`,
		`  ${ctx.ui.theme.fg("muted", "refresh:")} ${ctx.ui.theme.fg("dim", `${refreshSeconds}s`)} ${ctx.ui.theme.fg("muted", "| stale after:")} ${ctx.ui.theme.fg("dim", `${staleAfterSeconds}s`)}`,
		`  ${ctx.ui.theme.fg("muted", "queues:")} ${ctx.ui.theme.fg("accent", `${state.readyIssues.length} ready`)} ${ctx.ui.theme.fg("muted", "| ")} ${ctx.ui.theme.fg("warning", `${state.activeIssues.length} active`)} ${ctx.ui.theme.fg("dim", queueBar)}`,
		`  ${ctx.ui.theme.fg("muted", "last refresh:")} ${ctx.ui.theme.fg(refreshStale ? "warning" : "dim", refreshAge)}`,
		`  ${ctx.ui.theme.fg("dim", "────────────────────────────")}`,
		ctx.ui.theme.fg("accent", `tmux sessions (${state.sessions.length})`),
	];

	if (state.sessionError) {
		lines.push(ctx.ui.theme.fg("warning", `  tmux error: ${state.sessionError}`));
	} else if (state.sessions.length === 0) {
		lines.push(ctx.ui.theme.fg("muted", "  (no matching sessions)"));
	} else {
		for (const name of state.sessions.slice(0, 8)) {
			lines.push(`  ${ctx.ui.theme.fg("success", "●")} ${ctx.ui.theme.fg("text", name)}`);
		}
		if (state.sessions.length > 8) {
			lines.push(ctx.ui.theme.fg("muted", `  ... +${state.sessions.length - 8} more tmux sessions`));
		}
	}

	lines.push(`  ${ctx.ui.theme.fg("dim", "────────────────────────────")}`);
	if (state.issueError) {
		lines.push(ctx.ui.theme.fg("warning", `issue error: ${state.issueError}`));
	} else {
		lines.push(ctx.ui.theme.fg("accent", `ready queue (${state.readyIssues.length})`));
		if (state.readyIssues.length === 0) {
			lines.push(ctx.ui.theme.fg("muted", "  (no ready issues)"));
		} else {
			for (const issue of state.readyIssues.slice(0, 6)) {
				lines.push(formatIssueLine(ctx, issue, { marker: "→", tone: "accent" }));
			}
			if (state.readyIssues.length > 6) {
				lines.push(ctx.ui.theme.fg("muted", `  ... +${state.readyIssues.length - 6} more ready issues`));
			}
		}

		lines.push(ctx.ui.theme.fg("accent", `active queue (${state.activeIssues.length})`));
		if (state.activeIssues.length === 0) {
			lines.push(ctx.ui.theme.fg("muted", "  (no in-progress issues)"));
		} else {
			for (const issue of state.activeIssues.slice(0, 6)) {
				lines.push(formatIssueLine(ctx, issue, { marker: "●", tone: "warning" }));
			}
			if (state.activeIssues.length > 6) {
				lines.push(ctx.ui.theme.fg("muted", `  ... +${state.activeIssues.length - 6} more active issues`));
			}
		}
	}

	if (refreshStale) {
		lines.push(
			ctx.ui.theme.fg("warning", `refresh warning: last successful refresh is stale (>${staleAfterSeconds}s)`),
		);
	}
	if (drift.activeWithoutSessionIds.length > 0) {
		lines.push(
			ctx.ui.theme.fg(
				"warning",
				`drift warning: active issues without tmux sessions (${drift.activeWithoutSessionIds.length})`,
			),
		);
		lines.push(
			ctx.ui.theme.fg(
				"warning",
				`  missing sessions for: ${drift.activeWithoutSessionIds.slice(0, 8).join(", ")}${drift.activeWithoutSessionIds.length > 8 ? " ..." : ""}`,
			),
		);
	}
	if (drift.orphanSessions.length > 0) {
		lines.push(
			ctx.ui.theme.fg(
				"warning",
				`drift warning: tmux sessions without active issues (${drift.orphanSessions.length})`,
			),
		);
		lines.push(
			ctx.ui.theme.fg(
				"warning",
				`  orphan sessions: ${drift.orphanSessions.slice(0, 8).join(", ")}${drift.orphanSessions.length > 8 ? " ..." : ""}`,
			),
		);
	}

	ctx.ui.setWidget("mu-subagents", lines, { placement: "belowEditor" });
}

function subagentsUsageText(): string {
	return [
		"Usage:",
		"  /mu subagents on|off|toggle|status|refresh|snapshot",
		"  /mu subagents prefix <text|clear>",
		"  /mu subagents root <issue-id|clear>",
		"  /mu subagents role <tag|clear>",
		"  /mu subagents mode <worker|reviewer|researcher>",
		"  /mu subagents refresh-interval <seconds>",
		"  /mu subagents stale-after <seconds>",
		"  /mu subagents pause <on|off>",
		"  /mu subagents spawn [N|all]",
	].join("\n");
}

function subagentsDetails(state: SubagentsState) {
	const drift = computeQueueDrift(state.sessions, state.activeIssues);
	return {
		enabled: state.enabled,
		prefix: state.prefix,
		issue_root_id: state.issueRootId,
		issue_role_tag: state.issueRoleTag,
		spawn_mode: state.spawnMode,
		spawn_paused: state.spawnPaused,
		refresh_seconds: Math.round(state.refreshIntervalMs / 1_000),
		stale_after_seconds: Math.round(state.staleAfterMs / 1_000),
		sessions: [...state.sessions],
		ready_issue_ids: state.readyIssues.map((issue) => issue.id),
		active_issue_ids: state.activeIssues.map((issue) => issue.id),
		active_without_session_ids: drift.activeWithoutSessionIds,
		orphan_sessions: drift.orphanSessions,
		refresh_stale: isRefreshStale(state.lastUpdatedMs, state.staleAfterMs),
		issue_error: state.issueError,
		session_error: state.sessionError,
		last_updated_ms: state.lastUpdatedMs,
		snapshot_compact: subagentsSnapshot(state, "compact"),
		snapshot_multiline: subagentsSnapshot(state, "multiline"),
	};
}

function subagentsToolError(message: string, state: SubagentsState) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: {
			ok: false,
			error: message,
			...subagentsDetails(state),
		},
	};
}

export function subagentsUiExtension(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	const state = createDefaultState();

	const refresh = async (ctx: ExtensionContext) => {
		if (!state.enabled) {
			renderSubagentsUi(ctx, state);
			return;
		}
		const [tmux, issues] = await Promise.all([
			listTmuxSessions(state.prefix),
			listIssueSlices(state.issueRootId, state.issueRoleTag),
		]);
		state.sessions = tmux.sessions;
		state.sessionError = tmux.error;
		state.readyIssues = issues.ready;
		state.activeIssues = issues.active;
		state.issueError = issues.error;
		state.lastUpdatedMs = Date.now();
		renderSubagentsUi(ctx, state);
	};

	const stopPolling = () => {
		if (!pollTimer) {
			return;
		}
		clearInterval(pollTimer);
		pollTimer = null;
	};

	const ensurePolling = () => {
		if (pollTimer) {
			return;
		}
		pollTimer = setInterval(() => {
			if (!activeCtx) {
				return;
			}
			void refresh(activeCtx);
		}, state.refreshIntervalMs);
	};

	const restartPolling = () => {
		if (!state.enabled) {
			return;
		}
		stopPolling();
		ensurePolling();
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		ctx.ui.notify(`${message}\n\n${subagentsUsageText()}`, level);
	};

	const statusSummary = () => {
		const when = state.lastUpdatedMs == null ? "never" : new Date(state.lastUpdatedMs).toLocaleTimeString();
		const status = state.enabled ? "enabled" : "disabled";
		const issueScope = state.issueRootId ?? "(all roots)";
		const issueRole = state.issueRoleTag ?? "(all roles)";
		const drift = computeQueueDrift(state.sessions, state.activeIssues);
		const refreshStale = isRefreshStale(state.lastUpdatedMs, state.staleAfterMs);
		const issueError = state.issueError ? `\nissue_error: ${state.issueError}` : "";
		const tmuxError = state.sessionError ? `\ntmux_error: ${state.sessionError}` : "";
		const driftInfo =
			drift.activeWithoutSessionIds.length > 0 || drift.orphanSessions.length > 0
				? `\ndrift_active_without_session: ${drift.activeWithoutSessionIds.length}\ndrift_orphan_sessions: ${drift.orphanSessions.length}`
				: "";
		const staleInfo = refreshStale ? "\nrefresh_stale: yes" : "\nrefresh_stale: no";
		return {
			level:
				state.issueError ||
				state.sessionError ||
				refreshStale ||
				drift.activeWithoutSessionIds.length > 0 ||
				drift.orphanSessions.length > 0
					? "warning"
					: "info",
			text:
				[
					`Subagents monitor ${status}`,
					`prefix: ${state.prefix || "(all sessions)"}`,
					`issue_root: ${issueScope}`,
					`issue_role: ${issueRole}`,
					`spawn_mode: ${state.spawnMode}`,
					`spawn_paused: ${state.spawnPaused ? "yes" : "no"}`,
					`refresh_seconds: ${Math.round(state.refreshIntervalMs / 1_000)}`,
					`stale_after_seconds: ${Math.round(state.staleAfterMs / 1_000)}`,
					`sessions: ${state.sessions.length}`,
					`ready_issues: ${state.readyIssues.length}`,
					`active_issues: ${state.activeIssues.length}`,
					`last refresh: ${when}`,
				].join("\n") +
				issueError +
				tmuxError +
				driftInfo +
				staleInfo,
		};
	};

	const applySubagentsAction = async (
		params: SubagentsToolParams,
		ctx: ExtensionContext,
	): Promise<{ ok: boolean; message: string; level: "info" | "warning" | "error" }> => {
		switch (params.action) {
			case "status": {
				const summary = statusSummary();
				return { ok: true, message: summary.text, level: summary.level as "info" | "warning" | "error" };
			}
			case "snapshot": {
				const format = parseSnapshotFormat(params.snapshot_format);
				return { ok: true, message: subagentsSnapshot(state, format), level: "info" };
			}
			case "on":
				state.enabled = true;
				ensurePolling();
				await refresh(ctx);
				return { ok: true, message: "Subagents monitor enabled.", level: "info" };
			case "off":
				state.enabled = false;
				stopPolling();
				renderSubagentsUi(ctx, state);
				return { ok: true, message: "Subagents monitor disabled.", level: "info" };
			case "toggle":
				state.enabled = !state.enabled;
				if (state.enabled) {
					ensurePolling();
					await refresh(ctx);
				} else {
					stopPolling();
					renderSubagentsUi(ctx, state);
				}
				return { ok: true, message: `Subagents monitor ${state.enabled ? "enabled" : "disabled"}.`, level: "info" };
			case "refresh":
				await refresh(ctx);
				return { ok: true, message: "Subagents monitor refreshed.", level: "info" };
			case "set_prefix": {
				const value = params.prefix?.trim();
				if (!value) {
					return { ok: false, message: "Missing prefix value.", level: "error" };
				}
				state.prefix = value.toLowerCase() === "clear" ? "" : value;
				state.enabled = true;
				ensurePolling();
				await refresh(ctx);
				return { ok: true, message: `Subagents prefix set to ${state.prefix || "(all sessions)"}.`, level: "info" };
			}
			case "set_root": {
				const value = params.root_issue_id?.trim();
				if (!value) {
					return { ok: false, message: "Missing root issue id.", level: "error" };
				}
				state.issueRootId = value.toLowerCase() === "clear" ? null : value;
				state.enabled = true;
				ensurePolling();
				await refresh(ctx);
				return { ok: true, message: `Subagents root set to ${state.issueRootId ?? "(all roots)"}.`, level: "info" };
			}
			case "set_role": {
				const value = params.role_tag?.trim();
				if (!value) {
					return { ok: false, message: "Missing role/tag value.", level: "error" };
				}
				state.issueRoleTag = normalizeRoleTag(value);
				state.enabled = true;
				ensurePolling();
				await refresh(ctx);
				return {
					ok: true,
					message: `Subagents issue tag filter set to ${state.issueRoleTag ?? "(all roles)"}.`,
					level: "info",
				};
			}
			case "set_mode": {
				const modeRaw = params.spawn_mode?.trim() ?? "";
				const mode = parseSpawnMode(modeRaw);
				if (!mode) {
					return { ok: false, message: "Invalid spawn mode.", level: "error" };
				}
				state.spawnMode = mode;
				state.enabled = true;
				ensurePolling();
				await refresh(ctx);
				return { ok: true, message: `Subagents spawn mode set to ${mode}.`, level: "info" };
			}
			case "set_refresh_interval": {
				const parsed = parseSecondsBounded(
					params.refresh_seconds,
					MIN_REFRESH_SECONDS,
					MAX_REFRESH_SECONDS,
					"refresh_seconds",
				);
				if (!parsed.ok) {
					return { ok: false, message: parsed.error, level: "error" };
				}
				state.refreshIntervalMs = parsed.ms;
				state.enabled = true;
				restartPolling();
				await refresh(ctx);
				return {
					ok: true,
					message: `Subagents refresh interval set to ${Math.round(state.refreshIntervalMs / 1_000)}s.`,
					level: "info",
				};
			}
			case "set_stale_after": {
				const parsed = parseSecondsBounded(
					params.stale_after_seconds,
					MIN_STALE_SECONDS,
					MAX_STALE_SECONDS,
					"stale_after_seconds",
				);
				if (!parsed.ok) {
					return { ok: false, message: parsed.error, level: "error" };
				}
				state.staleAfterMs = parsed.ms;
				state.enabled = true;
				ensurePolling();
				await refresh(ctx);
				return {
					ok: true,
					message: `Subagents stale threshold set to ${Math.round(state.staleAfterMs / 1_000)}s.`,
					level: "info",
				};
			}
			case "set_spawn_paused": {
				if (typeof params.spawn_paused !== "boolean") {
					return { ok: false, message: "spawn_paused must be a boolean.", level: "error" };
				}
				state.spawnPaused = params.spawn_paused;
				state.enabled = true;
				ensurePolling();
				await refresh(ctx);
				return {
					ok: true,
					message: `Subagents spawn pause set to ${state.spawnPaused ? "on" : "off"}.`,
					level: "info",
				};
			}
			case "update": {
				const changed: string[] = [];
				let refreshIntervalChanged = false;

				if (params.prefix !== undefined) {
					if (typeof params.prefix !== "string") {
						return { ok: false, message: "prefix must be a string.", level: "error" };
					}
					const trimmed = params.prefix.trim();
					if (trimmed.length === 0) {
						return { ok: false, message: "prefix must not be empty.", level: "error" };
					}
					state.prefix = trimmed.toLowerCase() === "clear" ? "" : trimmed;
					changed.push("prefix");
				}

				if (params.root_issue_id !== undefined) {
					if (typeof params.root_issue_id !== "string") {
						return { ok: false, message: "root_issue_id must be a string.", level: "error" };
					}
					const trimmed = params.root_issue_id.trim();
					if (trimmed.length === 0) {
						return { ok: false, message: "root_issue_id must not be empty.", level: "error" };
					}
					state.issueRootId = trimmed.toLowerCase() === "clear" ? null : trimmed;
					changed.push("root_issue_id");
				}

				if (params.role_tag !== undefined) {
					if (typeof params.role_tag !== "string") {
						return { ok: false, message: "role_tag must be a string.", level: "error" };
					}
					const trimmed = params.role_tag.trim();
					if (trimmed.length === 0) {
						return { ok: false, message: "role_tag must not be empty.", level: "error" };
					}
					state.issueRoleTag = normalizeRoleTag(trimmed);
					changed.push("role_tag");
				}

				if (params.spawn_mode !== undefined) {
					if (typeof params.spawn_mode !== "string") {
						return { ok: false, message: "spawn_mode must be a string.", level: "error" };
					}
					const mode = parseSpawnMode(params.spawn_mode);
					if (!mode) {
						return { ok: false, message: "Invalid spawn mode.", level: "error" };
					}
					state.spawnMode = mode;
					changed.push("spawn_mode");
				}

				if (params.refresh_seconds !== undefined) {
					const parsed = parseSecondsBounded(
						params.refresh_seconds,
						MIN_REFRESH_SECONDS,
						MAX_REFRESH_SECONDS,
						"refresh_seconds",
					);
					if (!parsed.ok) {
						return { ok: false, message: parsed.error, level: "error" };
					}
					state.refreshIntervalMs = parsed.ms;
					refreshIntervalChanged = true;
					changed.push("refresh_seconds");
				}

				if (params.stale_after_seconds !== undefined) {
					const parsed = parseSecondsBounded(
						params.stale_after_seconds,
						MIN_STALE_SECONDS,
						MAX_STALE_SECONDS,
						"stale_after_seconds",
					);
					if (!parsed.ok) {
						return { ok: false, message: parsed.error, level: "error" };
					}
					state.staleAfterMs = parsed.ms;
					changed.push("stale_after_seconds");
				}

				if (params.spawn_paused !== undefined) {
					if (typeof params.spawn_paused !== "boolean") {
						return { ok: false, message: "spawn_paused must be a boolean.", level: "error" };
					}
					state.spawnPaused = params.spawn_paused;
					changed.push("spawn_paused");
				}

				if (changed.length === 0) {
					return { ok: false, message: "No update fields provided.", level: "error" };
				}

				state.enabled = true;
				if (refreshIntervalChanged) {
					restartPolling();
				} else {
					ensurePolling();
				}
				await refresh(ctx);
				return { ok: true, message: `Subagents monitor updated (${changed.join(", ")}).`, level: "info" };
			}
			case "spawn": {
				if (state.spawnPaused) {
					return {
						ok: false,
						message: "Spawn is paused. Use set_spawn_paused=false before spawning.",
						level: "error",
					};
				}
				if (!state.issueRootId) {
					return {
						ok: false,
						message: "Set a root first (`/mu subagents root <root-id>`) before spawning.",
						level: "error",
					};
				}

				let spawnLimit: number | null = null;
				if (params.count != null && params.count !== "all") {
					const countNum =
						typeof params.count === "number" ? params.count : Number.parseInt(String(params.count), 10);
					const parsed = Math.trunc(countNum);
					if (!Number.isFinite(parsed) || parsed < 1 || parsed > ISSUE_LIST_LIMIT) {
						return { ok: false, message: `Spawn count must be 1-${ISSUE_LIST_LIMIT} or 'all'.`, level: "error" };
					}
					spawnLimit = parsed;
				}

				const issueSlices = await listIssueSlices(state.issueRootId, state.issueRoleTag);
				state.readyIssues = issueSlices.ready;
				state.activeIssues = issueSlices.active;
				state.issueError = issueSlices.error;
				if (issueSlices.error) {
					state.enabled = true;
					ensurePolling();
					renderSubagentsUi(ctx, state);
					return { ok: false, message: `Cannot spawn: ${issueSlices.error}`, level: "error" };
				}

				const candidates = spawnLimit == null ? issueSlices.ready : issueSlices.ready.slice(0, spawnLimit);
				if (candidates.length === 0) {
					state.enabled = true;
					ensurePolling();
					await refresh(ctx);
					return { ok: true, message: "No ready issues to spawn for current root/tag filter.", level: "info" };
				}

				const spawnPrefix = state.prefix.length > 0 ? state.prefix : DEFAULT_PREFIX;
				const tmux = await listTmuxSessions(spawnPrefix);
				if (tmux.error) {
					state.sessionError = tmux.error;
					state.enabled = true;
					ensurePolling();
					renderSubagentsUi(ctx, state);
					return { ok: false, message: `Cannot spawn: ${tmux.error}`, level: "error" };
				}

				const existingSessions = [...tmux.sessions];
				const runId = spawnRunId();
				const launched: string[] = [];
				const skipped: string[] = [];
				const failed: string[] = [];

				for (const issue of candidates) {
					if (issueHasSession(existingSessions, issue.id)) {
						skipped.push(`${issue.id} (session exists)`);
						continue;
					}

					let sessionName = `${spawnPrefix}${runId}-${issue.id}`;
					if (existingSessions.includes(sessionName)) {
						let suffix = 1;
						while (existingSessions.includes(`${sessionName}-${suffix}`)) {
							suffix += 1;
						}
						sessionName = `${sessionName}-${suffix}`;
					}

					const spawned = await spawnIssueTmuxSession({
						cwd: ctx.cwd,
						sessionName,
						issue,
						mode: state.spawnMode,
					});
					if (spawned.ok) {
						existingSessions.push(sessionName);
						launched.push(`${issue.id} -> ${sessionName}`);
					} else {
						failed.push(`${issue.id} (${spawned.error ?? "unknown error"})`);
					}
				}

				state.enabled = true;
				ensurePolling();
				await refresh(ctx);

				const summary = [
					`Spawned ${launched.length}/${candidates.length} ready issue sessions (mode=${state.spawnMode}).`,
					launched.length > 0 ? `launched: ${launched.join(", ")}` : "launched: (none)",
					`skipped: ${skipped.length}`,
					`failed: ${failed.length}`,
				];
				if (failed.length > 0) {
					summary.push(`failures: ${failed.join("; ")}`);
				}
				return { ok: true, message: summary.join("\n"), level: failed.length > 0 ? "warning" : "info" };
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		if (state.enabled) {
			ensurePolling();
		}
		await refresh(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		activeCtx = ctx;
		if (state.enabled) {
			ensurePolling();
		}
		await refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		activeCtx = null;
	});

	registerMuSubcommand(pi, {
		subcommand: "subagents",
		summary: "Monitor tmux subagent sessions + issue queue, and spawn ready issue sessions",
		usage: "/mu subagents on|off|toggle|status|refresh|snapshot|prefix|root|role|mode|refresh-interval|stale-after|pause|spawn",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const tokens = args
				.trim()
				.split(/\s+/)
				.filter((token) => token.length > 0);

			const command = tokens[0] ?? "status";
			let params: SubagentsToolParams;
			switch (command) {
				case "status":
					params = { action: "status" };
					break;
				case "snapshot":
					params = { action: "snapshot", snapshot_format: tokens[1] };
					break;
				case "on":
					params = { action: "on" };
					break;
				case "off":
					params = { action: "off" };
					break;
				case "toggle":
					params = { action: "toggle" };
					break;
				case "refresh":
					params = { action: "refresh" };
					break;
				case "prefix":
					params = { action: "set_prefix", prefix: tokens.slice(1).join(" ") };
					break;
				case "root":
					params = { action: "set_root", root_issue_id: tokens.slice(1).join(" ") };
					break;
				case "role":
					params = { action: "set_role", role_tag: tokens.slice(1).join(" ") };
					break;
				case "mode":
					params = { action: "set_mode", spawn_mode: tokens[1] };
					break;
				case "refresh-interval":
					params = { action: "set_refresh_interval", refresh_seconds: Number.parseFloat(tokens[1] ?? "") };
					break;
				case "stale-after":
					params = { action: "set_stale_after", stale_after_seconds: Number.parseFloat(tokens[1] ?? "") };
					break;
				case "pause": {
					const parsed = parseOnOff(tokens[1]);
					params = { action: "set_spawn_paused", spawn_paused: parsed ?? undefined };
					break;
				}
				case "spawn":
					params = {
						action: "spawn",
						count: (() => {
							const token = tokens[1]?.trim();
							if (!token || token.toLowerCase() === "all") {
								return "all";
							}
							const parsed = Number.parseInt(token, 10);
							return Number.isFinite(parsed) ? parsed : Number.NaN;
						})(),
					};
					break;
				default:
					notify(ctx, `Unknown subagents command: ${command}`, "error");
					return;
			}

			const result = await applySubagentsAction(params, ctx);
			if (!result.ok) {
				notify(ctx, result.message, result.level);
				return;
			}
			ctx.ui.notify(result.message, result.level);
		},
	});

	pi.registerTool({
		name: "mu_subagents_hud",
		label: "mu subagents HUD",
		description:
			"Control or inspect subagents HUD state, including tmux scope, queue filters, spawn profile, and health policies.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"status",
						"snapshot",
						"on",
						"off",
						"toggle",
						"refresh",
						"set_prefix",
						"set_root",
						"set_role",
						"set_mode",
						"set_refresh_interval",
						"set_stale_after",
						"set_spawn_paused",
						"update",
						"spawn",
					],
				},
				prefix: { type: "string" },
				root_issue_id: { type: "string" },
				role_tag: { type: "string" },
				spawn_mode: { type: "string", enum: ["worker", "reviewer", "researcher"] },
				refresh_seconds: { type: "number", minimum: MIN_REFRESH_SECONDS, maximum: MAX_REFRESH_SECONDS },
				stale_after_seconds: { type: "number", minimum: MIN_STALE_SECONDS, maximum: MAX_STALE_SECONDS },
				spawn_paused: { type: "boolean" },
				snapshot_format: { type: "string", enum: ["compact", "multiline"] },
				count: {
					anyOf: [
						{ type: "integer", minimum: 1, maximum: ISSUE_LIST_LIMIT },
						{ type: "string", enum: ["all"] },
					],
				},
			},
			required: ["action"],
			additionalProperties: false,
		} as unknown as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
		execute: async (_toolCallId, paramsRaw, _signal, _onUpdate, ctx) => {
			activeCtx = ctx;
			const params = paramsRaw as SubagentsToolParams;
			const result = await applySubagentsAction(params, ctx);
			if (!result.ok) {
				return subagentsToolError(result.message, state);
			}
			return {
				content: [{ type: "text", text: result.message }],
				details: {
					ok: true,
					action: params.action,
					...subagentsDetails(state),
				},
			};
		},
	});
}

export default subagentsUiExtension;
