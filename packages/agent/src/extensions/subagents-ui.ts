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
};

type MuCliOutcome = {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error: string | null;
};

const DEFAULT_PREFIX = "mu-sub-";
const DEFAULT_ROLE_TAG = "role:worker";
const ISSUE_LIST_LIMIT = 40;
const MU_CLI_TIMEOUT_MS = 12_000;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function spawnRunId(now = new Date()): string {
	return now.toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 14);
}

function issueHasSession(sessions: readonly string[], issueId: string): boolean {
	return sessions.some(
		(session) =>
			session === issueId ||
			session.endsWith(`-${issueId}`) ||
			session.includes(`-${issueId}-`) ||
			session.includes(`_${issueId}`),
	);
}

function buildSubagentPrompt(issue: IssueDigest): string {
	return [
		`Work issue ${issue.id} (${truncateOneLine(issue.title, 80)}).`,
		`First run: mu issues claim ${issue.id}.`,
		`Keep forum updates in topic issue:${issue.id}.`,
		"When done, close with an explicit outcome and summary.",
	].join(" ");
}

async function spawnIssueTmuxSession(opts: {
	cwd: string;
	sessionName: string;
	issue: IssueDigest;
}): Promise<{ ok: boolean; error: string | null }> {
	const shellCommand = `cd ${shellQuote(opts.cwd)} && mu exec ${shellQuote(buildSubagentPrompt(opts.issue))} ; rc=$?; echo __MU_DONE__:$rc`;

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
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, readableText(proc.stdout), readableText(proc.stderr)]);
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

	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, readableText(proc.stdout), readableText(proc.stderr)]);
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

async function listIssueSlices(rootId: string | null, roleTag: string | null): Promise<{
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

function formatIssueLine(ctx: ExtensionContext, issue: IssueDigest): string {
	const id = ctx.ui.theme.fg("dim", issue.id);
	const priority = ctx.ui.theme.fg("muted", `p${issue.priority}`);
	return `  ${ctx.ui.theme.fg("success", "•")} ${id} ${priority} ${truncateOneLine(issue.title)}`;
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

	const issueScope = state.issueRootId ? `root ${state.issueRootId}` : "all roots";
	const roleScope = state.issueRoleTag ? state.issueRoleTag : "(all roles)";
	const issueStatus = `${state.readyIssues.length} ready / ${state.activeIssues.length} active`;

	if (state.sessionError || state.issueError) {
		ctx.ui.setStatus(
			"mu-subagents",
			ctx.ui.theme.fg("warning", `subagents ${state.sessions.length} · issues ${issueStatus} · degraded`),
		);
	} else {
		ctx.ui.setStatus(
			"mu-subagents",
			ctx.ui.theme.fg("dim", `subagents ${state.sessions.length} · issues ${issueStatus} · ${issueScope}`),
		);
	}

	const lines = [
		ctx.ui.theme.fg("accent", "Subagents monitor"),
		ctx.ui.theme.fg("dim", `  tmux prefix: ${state.prefix || "(all sessions)"}`),
		ctx.ui.theme.fg("dim", `  issue scope: ${issueScope} · tag ${roleScope}`),
	];

	if (state.sessionError) {
		lines.push(ctx.ui.theme.fg("warning", `  tmux error: ${state.sessionError}`));
	} else if (state.sessions.length === 0) {
		lines.push(ctx.ui.theme.fg("muted", "  tmux: (no matching sessions)"));
	} else {
		for (const name of state.sessions.slice(0, 8)) {
			lines.push(`  ${ctx.ui.theme.fg("success", "●")} ${name}`);
		}
		if (state.sessions.length > 8) {
			lines.push(ctx.ui.theme.fg("muted", `  ... +${state.sessions.length - 8} more tmux sessions`));
		}
	}

	if (state.issueError) {
		lines.push(ctx.ui.theme.fg("warning", `  issue error: ${state.issueError}`));
	} else {
		lines.push(ctx.ui.theme.fg("accent", "Ready issues"));
		if (state.readyIssues.length === 0) {
			lines.push(ctx.ui.theme.fg("muted", "  (no ready issues)"));
		} else {
			for (const issue of state.readyIssues.slice(0, 6)) {
				lines.push(formatIssueLine(ctx, issue));
			}
			if (state.readyIssues.length > 6) {
				lines.push(ctx.ui.theme.fg("muted", `  ... +${state.readyIssues.length - 6} more ready issues`));
			}
		}

		lines.push(ctx.ui.theme.fg("accent", "Active issues"));
		if (state.activeIssues.length === 0) {
			lines.push(ctx.ui.theme.fg("muted", "  (no in-progress issues)"));
		} else {
			for (const issue of state.activeIssues.slice(0, 6)) {
				lines.push(formatIssueLine(ctx, issue));
			}
			if (state.activeIssues.length > 6) {
				lines.push(ctx.ui.theme.fg("muted", `  ... +${state.activeIssues.length - 6} more active issues`));
			}
		}
	}

	ctx.ui.setWidget("mu-subagents", lines, { placement: "belowEditor" });
}

function subagentsUsageText(): string {
	return [
		"Usage:",
		"  /mu subagents on|off|toggle|status|refresh",
		"  /mu subagents prefix <text|clear>",
		"  /mu subagents root <issue-id|clear>",
		"  /mu subagents role <tag|clear>",
		"  /mu subagents spawn [N|all]",
	].join("\n");
}

function normalizeRoleTag(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.toLowerCase() === "clear") {
		return null;
	}
	if (trimmed === "worker" || trimmed === "orchestrator") {
		return `role:${trimmed}`;
	}
	return trimmed;
}

export function subagentsUiExtension(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let state = createDefaultState();

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
		}, 8_000);
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		ctx.ui.notify(`${message}\n\n${subagentsUsageText()}`, level);
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
		usage: "/mu subagents on|off|toggle|status|refresh|prefix|root|role|spawn",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const tokens = args
				.trim()
				.split(/\s+/)
				.filter((token) => token.length > 0);

			if (tokens.length === 0 || tokens[0] === "status") {
				const when = state.lastUpdatedMs == null ? "never" : new Date(state.lastUpdatedMs).toLocaleTimeString();
				const status = state.enabled ? "enabled" : "disabled";
				const issueScope = state.issueRootId ?? "(all roots)";
				const issueRole = state.issueRoleTag ?? "(all roles)";
				const issueError = state.issueError ? `\nissue_error: ${state.issueError}` : "";
				const tmuxError = state.sessionError ? `\ntmux_error: ${state.sessionError}` : "";
				ctx.ui.notify(
					[
						`Subagents monitor ${status}`,
						`prefix: ${state.prefix || "(all sessions)"}`,
						`issue_root: ${issueScope}`,
						`issue_role: ${issueRole}`,
						`sessions: ${state.sessions.length}`,
						`ready_issues: ${state.readyIssues.length}`,
						`active_issues: ${state.activeIssues.length}`,
						`last refresh: ${when}`,
					].join("\n") + issueError + tmuxError,
					state.issueError || state.sessionError ? "warning" : "info",
				);
				renderSubagentsUi(ctx, state);
				return;
			}

			switch (tokens[0]) {
				case "on":
					state.enabled = true;
					ensurePolling();
					await refresh(ctx);
					ctx.ui.notify("Subagents monitor enabled.", "info");
					return;
				case "off":
					state.enabled = false;
					stopPolling();
					renderSubagentsUi(ctx, state);
					ctx.ui.notify("Subagents monitor disabled.", "info");
					return;
				case "toggle":
					state.enabled = !state.enabled;
					if (state.enabled) {
						ensurePolling();
						await refresh(ctx);
					} else {
						stopPolling();
						renderSubagentsUi(ctx, state);
					}
					ctx.ui.notify(`Subagents monitor ${state.enabled ? "enabled" : "disabled"}.`, "info");
					return;
				case "refresh": {
					await refresh(ctx);
					ctx.ui.notify("Subagents monitor refreshed.", "info");
					return;
				}
				case "prefix": {
					const value = tokens.slice(1).join(" ").trim();
					if (!value) {
						notify(ctx, "Missing prefix value.", "error");
						return;
					}
					state.prefix = value.toLowerCase() === "clear" ? "" : value;
					state.enabled = true;
					ensurePolling();
					await refresh(ctx);
					ctx.ui.notify(`Subagents prefix set to ${state.prefix || "(all sessions)"}.`, "info");
					return;
				}
				case "root": {
					const value = tokens.slice(1).join(" ").trim();
					if (!value) {
						notify(ctx, "Missing root issue id.", "error");
						return;
					}
					state.issueRootId = value.toLowerCase() === "clear" ? null : value;
					state.enabled = true;
					ensurePolling();
					await refresh(ctx);
					ctx.ui.notify(`Subagents root set to ${state.issueRootId ?? "(all roots)"}.`, "info");
					return;
				}
				case "role": {
					const value = tokens.slice(1).join(" ").trim();
					if (!value) {
						notify(ctx, "Missing role/tag value.", "error");
						return;
					}
					state.issueRoleTag = normalizeRoleTag(value);
					state.enabled = true;
					ensurePolling();
					await refresh(ctx);
					ctx.ui.notify(`Subagents issue tag filter set to ${state.issueRoleTag ?? "(all roles)"}.`, "info");
					return;
				}
				case "spawn": {
					if (!state.issueRootId) {
						notify(ctx, "Set a root first (`/mu subagents root <root-id>`) before spawning.", "error");
						return;
					}

					let spawnLimit: number | null = null;
					const limitToken = tokens[1]?.trim();
					if (limitToken && limitToken.toLowerCase() !== "all") {
						const parsed = Number.parseInt(limitToken, 10);
						if (!Number.isFinite(parsed) || parsed < 1 || parsed > ISSUE_LIST_LIMIT) {
							notify(ctx, `Spawn count must be 1-${ISSUE_LIST_LIMIT} or 'all'.`, "error");
							return;
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
						notify(ctx, `Cannot spawn: ${issueSlices.error}`, "error");
						return;
					}

					const candidates = spawnLimit == null ? issueSlices.ready : issueSlices.ready.slice(0, spawnLimit);
					if (candidates.length === 0) {
						state.enabled = true;
						ensurePolling();
						await refresh(ctx);
						ctx.ui.notify("No ready issues to spawn for current root/tag filter.", "info");
						return;
					}

					const spawnPrefix = state.prefix.length > 0 ? state.prefix : DEFAULT_PREFIX;
					const tmux = await listTmuxSessions(spawnPrefix);
					if (tmux.error) {
						state.sessionError = tmux.error;
						state.enabled = true;
						ensurePolling();
						renderSubagentsUi(ctx, state);
						notify(ctx, `Cannot spawn: ${tmux.error}`, "error");
						return;
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
						`Spawned ${launched.length}/${candidates.length} ready issue sessions.`,
						launched.length > 0 ? `launched: ${launched.join(", ")}` : "launched: (none)",
						`skipped: ${skipped.length}`,
						`failed: ${failed.length}`,
					];
					if (failed.length > 0) {
						summary.push(`failures: ${failed.join("; ")}`);
					}
					ctx.ui.notify(summary.join("\n"), failed.length > 0 ? "warning" : "info");
					return;
				}
				default:
					notify(ctx, `Unknown subagents command: ${tokens[0]}`, "error");
			}
		},
	});
}

export default subagentsUiExtension;
