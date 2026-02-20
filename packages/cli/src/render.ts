import type { ForumMessage, Issue } from "@femtomc/mu-core";
import type { ForumTopicSummary } from "@femtomc/mu-forum";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}


export function issueJson(issue: Issue): Record<string, unknown> {
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

export function renderIssueCompactTable(issues: readonly Issue[]): string {
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

export function renderIssueDetailCompact(issue: Issue): string {
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

export function renderIssueMutationCompact(
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

export function renderIssueDepMutationCompact(action: "added" | "removed", dep: {
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

export function renderForumPostCompact(msg: ForumMessage): string {
	const bodySummary = truncateInline(summarizeBodySingleLine(msg.body, 64), 64);
	return `posted: ${msg.topic} by ${msg.author} at ${formatTsIsoMinute(msg.created_at)} \"${bodySummary}\"\n`;
}

export function renderForumReadCompact(topic: string, messages: readonly ForumMessage[]): string {
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

export function renderForumTopicsCompact(topics: readonly ForumTopicSummary[]): string {
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

export function renderEventsCompactTable(rows: readonly Record<string, unknown>[]): string {
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

export function renderRunPayloadCompact(payload: Record<string, unknown>): string {
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
	const prompt = recordString(program, "prompt") ?? null;
	const enabled = recordBool(program, "enabled");
	const everyMs = recordInt(program, "every_ms");
	const reason = recordString(program, "reason") ?? "-";
	const updated = recordInt(program, "updated_at_ms");
	const lines = [
		`Heartbeat ${id}`,
		`title=${truncateInline(title, 120)}`,
		`enabled=${enabled == null ? "-" : String(enabled)} every_ms=${everyMs ?? "-"} reason=${truncateInline(reason, 80)}`,
	];
	if (prompt != null) {
		lines.push(`prompt=${truncateInline(prompt, 140)}`);
	}
	lines.push(`updated=${formatTsIsoMinute(updated ?? 0)} (${formatAgeShort(updated ?? 0)})`);
	return `${lines.join("\n")}\n`;
}

export function renderHeartbeatsPayloadCompact(payload: Record<string, unknown>): string {
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

export function renderCronPayloadCompact(payload: Record<string, unknown>): string {
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

