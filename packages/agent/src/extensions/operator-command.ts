/**
 * mu_command — Operator mutation tool.
 *
 * Single execution path:
 * - Requires MU_SERVER_URL.
 * - Always POSTs to /api/commands/submit.
 *
 * All command validation/execution must route through the server command pipeline.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const MU_COMMAND_TOOL_NAME = "mu_command";

type CommandParams = {
	kind: string;
	prompt?: string;
	issue_id?: string;
	topic?: string;
	limit?: number;
	root_issue_id?: string;
	max_steps?: number;
};

const READONLY_COMMAND_KINDS = new Set([
	"status",
	"ready",
	"issue_list",
	"issue_get",
	"forum_read",
	"run_list",
	"run_status",
]);

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizedLimit(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value == null || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function fetchReadOnlyMirror(serverUrl: string, params: CommandParams): Promise<unknown | null> {
	if (!READONLY_COMMAND_KINDS.has(params.kind)) {
		return null;
	}

	const base = serverUrl.replace(/\/+$/, "");
	const limit = normalizedLimit(params.limit, 20, 1, 200);
	let path: string | null = null;

	switch (params.kind) {
		case "status":
			path = "/api/status";
			break;
		case "ready":
			path = `/api/issues/ready?limit=${limit}`;
			break;
		case "issue_list":
			path = `/api/issues?status=open&limit=${limit}`;
			break;
		case "issue_get": {
			const issueId = trimOrNull(params.issue_id);
			if (!issueId) return { error: "issue_id is required for issue_get mirror fetch" };
			path = `/api/issues/${encodeURIComponent(issueId)}`;
			break;
		}
		case "forum_read": {
			const topic = trimOrNull(params.topic);
			if (!topic) return { error: "topic is required for forum_read mirror fetch" };
			path = `/api/forum/read?topic=${encodeURIComponent(topic)}&limit=${limit}`;
			break;
		}
		case "run_list":
			path = `/api/runs?limit=${limit}`;
			break;
		case "run_status": {
			const rootIssueId = trimOrNull(params.root_issue_id);
			if (!rootIssueId) return { error: "root_issue_id is required for run_status mirror fetch" };
			path = `/api/runs/${encodeURIComponent(rootIssueId)}`;
			break;
		}
		default:
			return null;
	}

	if (!path) {
		return null;
	}

	try {
		const response = await fetch(`${base}${path}`);
		const raw = await response.text();
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			payload = raw;
		}
		if (!response.ok) {
			return { error: `mirror fetch failed (${response.status})`, path, payload };
		}
		return payload;
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err), path };
	}
}

async function executeViaServer(
	serverUrl: string,
	params: CommandParams,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}> {
	const url = `${serverUrl.replace(/\/+$/, "")}/api/commands/submit`;
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(params),
	});

	const contentType = response.headers.get("content-type") ?? "";
	const raw = await response.text();
	let body: Record<string, unknown> | null = null;
	try {
		body = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		body = null;
	}

	if (!body) {
		const preview = raw.slice(0, 200).replaceAll(/\s+/g, " ").trim();
		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Command API mismatch at ${url}.`,
						`Expected JSON response, got content-type ${contentType || "unknown"} (status ${response.status}).`,
						preview ? `Body preview: ${preview}` : "",
						"This usually means MU_SERVER_URL points at an outdated server or wrong base URL.",
					]
						.filter(Boolean)
						.join("\n"),
				},
			],
			details: {
				kind: params.kind,
				error: "command_api_mismatch",
				status: response.status,
				content_type: contentType,
				body_preview: preview,
				url,
			},
		};
	}

	if (!response.ok) {
		const error = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
		return {
			content: [{ type: "text" as const, text: `Command failed: ${error}` }],
			details: { kind: params.kind, error, status: response.status },
		};
	}

	const result = body.result as Record<string, unknown> | undefined;
	const resultKind = typeof result?.kind === "string" ? result.kind : "unknown";

	let summary: string;
	let readResult: unknown = null;
	if (resultKind === "completed" || resultKind === "awaiting_confirmation") {
		const command = result?.command as Record<string, unknown> | undefined;
		summary = `Command ${resultKind}: ${params.kind}`;
		if (command?.target_type) {
			summary += ` (${command.target_type})`;
		}
		if (resultKind === "completed" && command?.result) {
			summary += `\n${JSON.stringify(command.result, null, 2)}`;
		}
		if (resultKind === "completed" && READONLY_COMMAND_KINDS.has(params.kind)) {
			readResult = await fetchReadOnlyMirror(serverUrl, params);
			if (readResult != null) {
				summary += `\n${JSON.stringify({ query_result: readResult }, null, 2)}`;
			}
		}
	} else if (resultKind === "denied" || resultKind === "invalid" || resultKind === "failed") {
		const reason = result?.reason ?? "unknown";
		summary = `Command ${resultKind}: ${reason}`;
	} else {
		summary = `Command result: ${resultKind}`;
	}

	return {
		content: [{ type: "text" as const, text: summary }],
		details: { kind: params.kind, pipeline_result: result, query_result: readResult },
	};
}

export function operatorCommandExtension(pi: ExtensionAPI) {
	const CommandParams = Type.Object({
		kind: StringEnum([
			"status",
			"ready",
			"issue_list",
			"issue_get",
			"forum_read",
			"run_list",
			"run_status",
			"run_start",
			"run_resume",
			"run_interrupt",
			"reload",
			"update",
		] as const),
		prompt: Type.Optional(Type.String({ description: "Prompt for run_start" })),
		issue_id: Type.Optional(Type.String({ description: "Issue ID for issue_get" })),
		topic: Type.Optional(Type.String({ description: "Topic for forum_read" })),
		limit: Type.Optional(Type.Number({ description: "Limit for forum_read / run_resume" })),
		root_issue_id: Type.Optional(
			Type.String({ description: "Root issue ID for run_status / run_resume / run_interrupt" }),
		),
		max_steps: Type.Optional(Type.Number({ description: "Max steps for run_start / run_resume" })),
	});

	pi.registerTool({
		name: MU_COMMAND_TOOL_NAME,
		label: "Command",
		description: [
			"Propose an approved mu command for execution.",
			"This is the ONLY way to trigger mutations (starting runs, resuming runs, interrupting runs).",
			"Read-only queries (status, issue_list, etc.) can also be proposed here.",
			"The command will be validated and executed through the control-plane pipeline.",
		].join(" "),
		parameters: CommandParams,
		async execute(_toolCallId, params) {
			const serverUrl = process.env.MU_SERVER_URL;
			if (serverUrl) {
				return await executeViaServer(serverUrl, params);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: "No server running. Start with `mu serve` for command execution.",
					},
				],
				details: { kind: params.kind, error: "no_server" },
			};
		},
	});
}

export default operatorCommandExtension;
