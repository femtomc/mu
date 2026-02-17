import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { clampInt, fetchMuJson, textResult, toJsonText } from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function orchestrationRunsExtension(pi: ExtensionAPI) {
	const RunsParams = Type.Object({
		action: StringEnum(["list", "status", "start", "resume", "interrupt", "heartbeat", "trace"] as const),
		job_id: Type.Optional(Type.String({ description: "Run job ID" })),
		root_issue_id: Type.Optional(Type.String({ description: "Run root issue ID (mu-...)" })),
		prompt: Type.Optional(Type.String({ description: "Prompt for run start" })),
		max_steps: Type.Optional(Type.Number({ description: "Optional max steps for start/resume" })),
		limit: Type.Optional(Type.Number({ description: "Optional limit (list/trace)" })),
		status: Type.Optional(Type.String({ description: "Optional status filter for list" })),
		reason: Type.Optional(Type.String({ description: "Optional heartbeat reason (default: manual)" })),
	});

	pi.registerTool({
		name: "mu_runs",
		label: "Runs",
		description:
			"Manage orchestration runs. Actions: list, status, start, resume, interrupt, heartbeat, trace (stdout/stderr + .mu/log hints).",
		parameters: RunsParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const query = new URLSearchParams();
					const status = trimOrNull(params.status);
					if (status) query.set("status", status);
					const limit = clampInt(params.limit, 50, 1, 500);
					query.set("limit", String(limit));
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/runs?${query.toString()}`);
					return textResult(toJsonText(payload), { action: "list", status, limit });
				}
				case "status": {
					const id = trimOrNull(params.job_id) ?? trimOrNull(params.root_issue_id);
					if (!id) return textResult("status requires job_id or root_issue_id");
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}`);
					return textResult(toJsonText(payload), { action: "status", id });
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
					return textResult(toJsonText(payload), { action: "start", prompt, maxSteps });
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
					return textResult(toJsonText(payload), { action: "resume", rootIssueId, maxSteps });
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
					return textResult(toJsonText(payload), { action: "interrupt", jobId, rootIssueId });
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
					return textResult(toJsonText(payload), { action: "heartbeat", jobId, rootIssueId, reason });
				}
				case "trace": {
					const id = trimOrNull(params.job_id) ?? trimOrNull(params.root_issue_id);
					if (!id) return textResult("trace requires job_id or root_issue_id");
					const limit = clampInt(params.limit, 200, 1, 2_000);
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/runs/${encodeURIComponent(id)}/trace?limit=${limit}`,
					);
					return textResult(toJsonText(payload), { action: "trace", id, limit });
				}
				default:
					return textResult(`unknown action: ${params.action}`);
			}
		},
	});
}

export default orchestrationRunsExtension;
