/**
 * command — Approved mutation tool.
 *
 * Single execution path:
 * - Requires MU_SERVER_URL.
 * - Always POSTs to /api/commands/submit.
 * - Supports mutation-capable command kinds only.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const COMMAND_TOOL_NAME = "command";

type CommandParams = {
	kind: string;
	prompt?: string;
	root_issue_id?: string;
	max_steps?: number;
	id?: string;
	title?: string;
	body?: string;
	topic?: string;
	author?: string;
	tags?: string;
	add_tags?: string;
	remove_tags?: string;
	priority?: number;
	status?: string;
	outcome?: string;
	parent_id?: string;
	src_id?: string;
	dst_id?: string;
	dep_type?: string;
	program_id?: string;
	target_kind?: string;
	run_job_id?: string;
	run_root_issue_id?: string;
	activity_id?: string;
	every_ms?: number;
	reason?: string;
	wake_mode?: string;
	enabled?: boolean;
	schedule_kind?: string;
	at_ms?: number;
	at?: string;
	anchor_ms?: number;
	expr?: string;
	tz?: string;
};

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
		kind: StringEnum(
			[
				"run_start",
				"run_resume",
				"run_interrupt",
				"reload",
				"update",
				"issue_create",
				"issue_update",
				"issue_claim",
				"issue_open",
				"issue_close",
				"issue_dep",
				"issue_undep",
				"forum_post",
				"heartbeat_create",
				"heartbeat_update",
				"heartbeat_delete",
				"heartbeat_trigger",
				"heartbeat_enable",
				"heartbeat_disable",
				"cron_create",
				"cron_update",
				"cron_delete",
				"cron_trigger",
				"cron_enable",
				"cron_disable",
			] as const,
		),
		prompt: Type.Optional(Type.String({ description: "Prompt for run_start" })),
		root_issue_id: Type.Optional(Type.String({ description: "Root issue ID for run_resume / run_interrupt" })),
		max_steps: Type.Optional(Type.Number({ description: "Max steps for run_start / run_resume" })),
		id: Type.Optional(Type.String({ description: "Issue ID for issue_update/issue_claim/issue_open/issue_close" })),
		title: Type.Optional(Type.String({ description: "Issue title for issue_create" })),
		body: Type.Optional(Type.String({ description: "Issue/forum body text (issue_create, issue_update, forum_post)" })),
		topic: Type.Optional(Type.String({ description: "Forum topic for forum_post" })),
		author: Type.Optional(Type.String({ description: "Forum author for forum_post (default: operator)" })),
		tags: Type.Optional(Type.String({ description: "Comma-separated tags for issue_create/issue_update" })),
		add_tags: Type.Optional(Type.String({ description: "Comma-separated tags to add for issue_update" })),
		remove_tags: Type.Optional(Type.String({ description: "Comma-separated tags to remove for issue_update" })),
		priority: Type.Optional(Type.Number({ description: "Issue priority for issue_create/issue_update" })),
		status: Type.Optional(Type.String({ description: "Issue status for issue_update" })),
		outcome: Type.Optional(Type.String({ description: "Outcome for issue_update/issue_close" })),
		parent_id: Type.Optional(Type.String({ description: "Optional parent issue id for issue_create" })),
		src_id: Type.Optional(Type.String({ description: "Source issue id for issue_dep/issue_undep" })),
		dst_id: Type.Optional(Type.String({ description: "Destination issue id for issue_dep/issue_undep" })),
		dep_type: Type.Optional(Type.String({ description: "Dependency type: blocks|parent" })),
		program_id: Type.Optional(Type.String({ description: "Program ID for heartbeat/cron update|delete|trigger|enable|disable" })),
		target_kind: Type.Optional(Type.String({ description: "Program target kind: run|activity" })),
		run_job_id: Type.Optional(Type.String({ description: "Run target job ID for heartbeat/cron program mutations" })),
		run_root_issue_id: Type.Optional(
			Type.String({ description: "Run target root issue ID for heartbeat/cron program mutations" }),
		),
		activity_id: Type.Optional(Type.String({ description: "Activity target ID for heartbeat/cron program mutations" })),
		every_ms: Type.Optional(Type.Number({ description: "Heartbeat interval ms, or cron every schedule interval ms" })),
		reason: Type.Optional(Type.String({ description: "Heartbeat/cron execution reason" })),
		wake_mode: Type.Optional(Type.String({ description: "Wake mode for run targets: immediate|next_heartbeat" })),
		enabled: Type.Optional(Type.Boolean({ description: "Program enabled state" })),
		schedule_kind: Type.Optional(Type.String({ description: "Cron schedule kind: at|every|cron" })),
		at_ms: Type.Optional(Type.Number({ description: "Cron one-shot timestamp epoch ms" })),
		at: Type.Optional(Type.String({ description: "Cron one-shot timestamp ISO-8601" })),
		anchor_ms: Type.Optional(Type.Number({ description: "Cron every schedule anchor epoch ms" })),
		expr: Type.Optional(Type.String({ description: "Cron expression (5-field)" })),
		tz: Type.Optional(Type.String({ description: "Cron expression timezone (IANA)" })),
	});

	pi.registerTool({
		name: COMMAND_TOOL_NAME,
		label: "Command",
		description: [
			"Execute approved mutation commands through the command API.",
			"Supports run lifecycle, control-plane lifecycle, issue/forum mutations, and heartbeat/cron program management.",
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
