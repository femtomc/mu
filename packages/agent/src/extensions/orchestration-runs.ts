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

export function orchestrationRunsExtension(pi: ExtensionAPI) {
	const RunsParams = Type.Object({
		action: StringEnum(["list", "status", "start", "resume", "interrupt", "heartbeat", "trace"] as const),
		job_id: Type.Optional(Type.String({ description: "Run job ID" })),
		root_issue_id: Type.Optional(Type.String({ description: "Run root issue ID (mu-...)" })),
		prompt: Type.Optional(Type.String({ description: "Prompt for run start" })),
		max_steps: Type.Optional(Type.Number({ description: "Optional max steps for start/resume" })),
		limit: Type.Optional(Type.Number({ description: "Optional limit (list/trace). Defaults to 20 for list and 40 lines for trace." })),
		status: Type.Optional(Type.String({ description: "Optional status filter for list" })),
		fields: Type.Optional(
			Type.String({ description: "Comma-separated fields for status/trace selection (e.g. status,exit_code,prompt)" }),
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
					const runs = asArray(payload.runs)
						.map((run) => asRecord(run))
						.filter((run): run is Record<string, unknown> => run != null)
						.map((run) => summarizeRun(run));
					return textResult(
						toJsonText({ count: runs.length, runs }),
						{ action: "list", status, limit, payload },
					);
				}
				case "status": {
					const id = trimOrNull(params.job_id) ?? trimOrNull(params.root_issue_id);
					if (!id) return textResult("status requires job_id or root_issue_id");
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}`);
					const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
					const content =
						fields.length > 0 ? { id, selected: selectFields(payload, fields) } : { run: summarizeRun(payload) };
					return textResult(toJsonText(content), { action: "status", id, fields, payload });
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
					return textResult(
						toJsonText({ ok: payload.ok ?? true, run: run ? summarizeRun(run) : null }),
						{ action: "start", prompt, maxSteps, payload },
					);
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
					return textResult(
						toJsonText({ ok: payload.ok ?? true, run: run ? summarizeRun(run) : null }),
						{ action: "resume", rootIssueId, maxSteps, payload },
					);
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
						toJsonText({ ok: payload.ok ?? null, reason: payload.reason ?? null, run: run ? summarizeRun(run) : null }),
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
						toJsonText({ ok: payload.ok ?? null, reason: payload.reason ?? null, run: run ? summarizeRun(run) : null }),
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
