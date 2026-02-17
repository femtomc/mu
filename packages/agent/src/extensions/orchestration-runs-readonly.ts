import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { clampInt, fetchMuJson, textResult, toJsonText } from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function orchestrationRunsReadOnlyExtension(pi: ExtensionAPI) {
	const RunsParams = Type.Object({
		action: StringEnum(["list", "status", "trace"] as const),
		job_id: Type.Optional(Type.String({ description: "Run job ID" })),
		root_issue_id: Type.Optional(Type.String({ description: "Run root issue ID (mu-...)" })),
		limit: Type.Optional(Type.Number({ description: "Optional limit (list/trace)" })),
		status: Type.Optional(Type.String({ description: "Optional status filter for list" })),
	});

	pi.registerTool({
		name: "mu_runs",
		label: "Runs",
		description:
			"Read-only run inspection. Actions: list, status, trace. Mutating actions are disabled in operator mode.",
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

export default orchestrationRunsReadOnlyExtension;
