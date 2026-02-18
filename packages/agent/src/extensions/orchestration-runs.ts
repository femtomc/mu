import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	asArray,
	asNumber,
	asRecord,
	asString,
	clampInt,
	fetchMuJson,
	parseFieldPaths,
	previewLines,
	previewText,
	selectFields,
	textResult,
	toJsonText,
} from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function summarizeRun(run: Record<string, unknown>): Record<string, unknown> {
	return {
		job_id: asString(run.job_id),
		root_issue_id: asString(run.root_issue_id),
		status: asString(run.status),
		source: asString(run.source),
		started_at_ms: asNumber(run.started_at_ms),
		finished_at_ms: asNumber(run.finished_at_ms),
		exit_code: asNumber(run.exit_code),
		provider: asString(run.provider),
		model: asString(run.model),
		reasoning: asString(run.reasoning),
		prompt_preview: previewText(run.prompt, 140),
	};
}

function summarizeTrace(trace: Record<string, unknown>, lineLimit: number): Record<string, unknown> {
	const run = asRecord(trace.run);
	return {
		run: run ? summarizeRun(run) : null,
		stdout: previewLines(trace.stdout, { maxLines: lineLimit, maxCharsPerLine: 220 }),
		stderr: previewLines(trace.stderr, { maxLines: lineLimit, maxCharsPerLine: 220 }),
		log_hints: asArray(trace.log_hints).slice(0, 20),
		trace_files: asArray(trace.trace_files).slice(0, 20),
	};
}

function runFromStartEvent(event: Record<string, unknown>): Record<string, unknown> | null {
	const runId = asString(event.run_id);
	if (!runId) {
		return null;
	}
	const payload = asRecord(event.payload);
	const issueId = asString(event.issue_id);
	const role = payload ? asString(payload.role) : null;
	const explicitRoot = payload ? asString(payload.root_issue_id) : null;
	const rootIssueId = explicitRoot ?? (role === "orchestrator" ? issueId : null);
	return {
		job_id: runId,
		root_issue_id: rootIssueId,
		issue_id: issueId,
		role,
		status: "history",
		source: "event_log",
		started_at_ms: asNumber(event.ts_ms),
		finished_at_ms: null,
		exit_code: null,
		provider: payload ? asString(payload.provider) : null,
		model: payload ? asString(payload.model) : null,
		reasoning: payload ? asString(payload.reasoning) : null,
		prompt: payload ? asString(payload.prompt) : null,
	};
}

async function fetchHistoricalRuns(limit: number): Promise<Record<string, unknown>[]> {
	const payload = await fetchMuJson<unknown>(`/api/events?type=backend.run.start&limit=${Math.max(limit * 4, 80)}`);
	const payloadRecord = asRecord(payload);
	const events = Array.isArray(payload) ? payload : asArray(payloadRecord?.events);
	const runIndex = new Map<string, number>();
	const runs: Record<string, unknown>[] = [];
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = asRecord(events[index]);
		if (!event) {
			continue;
		}
		const run = runFromStartEvent(event);
		if (!run) {
			continue;
		}
		const runId = asString(run.job_id);
		if (!runId) {
			continue;
		}
		const existingIdx = runIndex.get(runId);
		if (existingIdx == null) {
			if (runs.length >= limit) {
				continue;
			}
			runIndex.set(runId, runs.length);
			runs.push(run);
			continue;
		}
		const existing = runs[existingIdx]!;
		if (!asString(existing.root_issue_id)) {
			existing.root_issue_id = asString(run.root_issue_id) ?? asString(run.issue_id);
		}
		if (!asString(existing.provider)) {
			existing.provider = asString(run.provider);
		}
		if (!asString(existing.model)) {
			existing.model = asString(run.model);
		}
		if (!asString(existing.reasoning)) {
			existing.reasoning = asString(run.reasoning);
		}
		if (!asString(existing.prompt)) {
			existing.prompt = asString(run.prompt);
		}
	}
	return runs;
}

async function findHistoricalRun(idOrRoot: string): Promise<Record<string, unknown> | null> {
	const payload = await fetchMuJson<unknown>("/api/events?type=backend.run.start&limit=200");
	const payloadRecord = asRecord(payload);
	const events = Array.isArray(payload) ? payload : asArray(payloadRecord?.events);
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = asRecord(events[index]);
		if (!event) {
			continue;
		}
		const run = runFromStartEvent(event);
		if (!run) {
			continue;
		}
		const runId = asString(run.job_id);
		const rootIssueId = asString(run.root_issue_id);
		if (runId === idOrRoot || rootIssueId === idOrRoot) {
			return run;
		}
	}
	return null;
}

function isRunNotFoundError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	return message.includes("mu server 404") || message.includes("run not found");
}

export function orchestrationRunsExtension(pi: ExtensionAPI) {
	const RunsParams = Type.Object({
		action: StringEnum(["list", "status", "start", "resume", "interrupt", "heartbeat", "trace"] as const),
		job_id: Type.Optional(Type.String({ description: "Run job ID" })),
		root_issue_id: Type.Optional(Type.String({ description: "Run root issue ID (mu-...)" })),
		prompt: Type.Optional(Type.String({ description: "Prompt for run start" })),
		max_steps: Type.Optional(Type.Number({ description: "Optional max steps for start/resume" })),
		limit: Type.Optional(
			Type.Number({ description: "Optional limit (list/trace). Defaults to 20 for list and 40 lines for trace." }),
		),
		status: Type.Optional(Type.String({ description: "Optional status filter for list" })),
		fields: Type.Optional(
			Type.String({
				description: "Comma-separated fields for status/trace selection (e.g. status,exit_code,prompt)",
			}),
		),
		reason: Type.Optional(Type.String({ description: "Optional heartbeat reason (default: manual)" })),
	});

	pi.registerTool({
		name: "mu_runs",
		label: "Runs",
		description:
			"Manage orchestration runs. Actions: list, status, start, resume, interrupt, heartbeat, trace. List/trace return compact summaries; use fields for precise retrieval.",
		parameters: RunsParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const query = new URLSearchParams();
					const status = trimOrNull(params.status);
					if (status) query.set("status", status);
					const limit = clampInt(params.limit, 20, 1, 500);
					query.set("limit", String(limit));
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/runs?${query.toString()}`);
					let records = asArray(payload.runs)
						.map((run) => asRecord(run))
						.filter((run): run is Record<string, unknown> => run != null);
					let source: "run_supervisor" | "event_log" = "run_supervisor";
					if (records.length === 0 && (status == null || status === "history")) {
						records = await fetchHistoricalRuns(limit);
						source = "event_log";
					}
					const runs = records.map((run) => summarizeRun(run));
					return textResult(toJsonText({ count: runs.length, source, runs }), {
						action: "list",
						status,
						limit,
						source,
						payload,
						runs: records,
					});
				}
				case "status": {
					const id = trimOrNull(params.job_id) ?? trimOrNull(params.root_issue_id);
					if (!id) return textResult("status requires job_id or root_issue_id");
					let payload: Record<string, unknown> | null = null;
					let source: "run_supervisor" | "event_log" = "run_supervisor";
					try {
						payload = await fetchMuJson<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}`);
					} catch (err) {
						if (!isRunNotFoundError(err)) {
							throw err;
						}
						payload = await findHistoricalRun(id);
						source = "event_log";
						if (!payload) {
							throw err;
						}
					}
					if (!payload) {
						return textResult(`run not found: ${id}`);
					}
					const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
					const content =
						fields.length > 0
							? { id, source, selected: selectFields(payload, fields) }
							: { source, run: summarizeRun(payload) };
					return textResult(toJsonText(content), { action: "status", id, source, fields, payload });
				}
				case "start": {
					const prompt = trimOrNull(params.prompt);
					if (!prompt) return textResult("start requires prompt");
					const maxSteps =
						params.max_steps != null && Number.isFinite(params.max_steps)
							? Math.max(1, Math.trunc(params.max_steps))
							: undefined;
					const payload = await fetchMuJson<Record<string, unknown>>("/api/runs/start", {
						method: "POST",
						body: {
							prompt,
							max_steps: maxSteps,
						},
					});
					const run = asRecord(payload.run);
					return textResult(toJsonText({ ok: payload.ok ?? true, run: run ? summarizeRun(run) : null }), {
						action: "start",
						prompt,
						maxSteps,
						payload,
					});
				}
				case "resume": {
					const rootIssueId = trimOrNull(params.root_issue_id);
					if (!rootIssueId) return textResult("resume requires root_issue_id");
					const maxSteps =
						params.max_steps != null && Number.isFinite(params.max_steps)
							? Math.max(1, Math.trunc(params.max_steps))
							: undefined;
					const payload = await fetchMuJson<Record<string, unknown>>("/api/runs/resume", {
						method: "POST",
						body: {
							root_issue_id: rootIssueId,
							max_steps: maxSteps,
						},
					});
					const run = asRecord(payload.run);
					return textResult(toJsonText({ ok: payload.ok ?? true, run: run ? summarizeRun(run) : null }), {
						action: "resume",
						rootIssueId,
						maxSteps,
						payload,
					});
				}
				case "interrupt": {
					const jobId = trimOrNull(params.job_id);
					const rootIssueId = trimOrNull(params.root_issue_id);
					if (!jobId && !rootIssueId) {
						return textResult("interrupt requires job_id or root_issue_id");
					}
					const payload = await fetchMuJson<Record<string, unknown>>("/api/runs/interrupt", {
						method: "POST",
						body: {
							job_id: jobId,
							root_issue_id: rootIssueId,
						},
					});
					const run = asRecord(payload.run);
					return textResult(
						toJsonText({
							ok: payload.ok ?? null,
							reason: payload.reason ?? null,
							run: run ? summarizeRun(run) : null,
						}),
						{ action: "interrupt", jobId, rootIssueId, payload },
					);
				}
				case "heartbeat": {
					const jobId = trimOrNull(params.job_id);
					const rootIssueId = trimOrNull(params.root_issue_id);
					if (!jobId && !rootIssueId) {
						return textResult("heartbeat requires job_id or root_issue_id");
					}
					const reason = trimOrNull(params.reason) ?? "manual";
					const payload = await fetchMuJson<Record<string, unknown>>("/api/runs/heartbeat", {
						method: "POST",
						body: {
							job_id: jobId,
							root_issue_id: rootIssueId,
							reason,
						},
					});
					const run = asRecord(payload.run);
					return textResult(
						toJsonText({
							ok: payload.ok ?? null,
							reason: payload.reason ?? null,
							run: run ? summarizeRun(run) : null,
						}),
						{ action: "heartbeat", jobId, rootIssueId, reason, payload },
					);
				}
				case "trace": {
					const id = trimOrNull(params.job_id) ?? trimOrNull(params.root_issue_id);
					if (!id) return textResult("trace requires job_id or root_issue_id");
					const lineLimit = clampInt(params.limit, 40, 1, 200);
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/runs/${encodeURIComponent(id)}/trace?limit=${Math.max(lineLimit, 80)}`,
					);
					const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
					const content =
						fields.length > 0
							? { id, selected: selectFields(payload, fields) }
							: summarizeTrace(payload, lineLimit);
					return textResult(toJsonText(content), { action: "trace", id, lineLimit, fields, payload });
				}
				default:
					return textResult(`unknown action: ${params.action}`);
			}
		},
	});
}

export default orchestrationRunsExtension;
