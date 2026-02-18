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

async function executeViaServer(serverUrl: string, params: CommandParams): Promise<{
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
			content: [{
				type: "text" as const,
				text: [
					`Command API mismatch at ${url}.`,
					`Expected JSON response, got content-type ${contentType || "unknown"} (status ${response.status}).`,
					preview ? `Body preview: ${preview}` : "",
					"This usually means MU_SERVER_URL points at an outdated server or wrong base URL.",
				].filter(Boolean).join("\n"),
			}],
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
	if (resultKind === "completed" || resultKind === "awaiting_confirmation") {
		const command = result?.command as Record<string, unknown> | undefined;
		summary = `Command ${resultKind}: ${params.kind}`;
		if (command?.target_type) {
			summary += ` (${command.target_type})`;
		}
		if (resultKind === "completed" && command?.result) {
			summary += `\n${JSON.stringify(command.result, null, 2)}`;
		}
	} else if (resultKind === "denied" || resultKind === "invalid" || resultKind === "failed") {
		const reason = result?.reason ?? "unknown";
		summary = `Command ${resultKind}: ${reason}`;
	} else {
		summary = `Command result: ${resultKind}`;
	}

	return {
		content: [{ type: "text" as const, text: summary }],
		details: { kind: params.kind, pipeline_result: result },
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
		root_issue_id: Type.Optional(Type.String({ description: "Root issue ID for run_status / run_resume / run_interrupt" })),
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
				content: [{
					type: "text" as const,
					text: "No server running. Start with `mu serve` for command execution.",
				}],
				details: { kind: params.kind, error: "no_server" },
			};
		},
	});
}

export default operatorCommandExtension;
