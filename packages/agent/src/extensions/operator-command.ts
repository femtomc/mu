/**
 * mu_command — Operator mutation tool.
 *
 * Tri-modal execution:
 * - Mode 1 (Messaging): MU_OPERATOR_MESSAGING_MODE=1. Returns stub "accepted".
 *   The actual command is captured by PiMessagingOperatorBackend via event subscription.
 * - Mode 2 (TUI with server): MU_SERVER_URL set. POSTs to /api/commands/submit.
 * - Mode 3 (No server): Returns error directing user to start `mu serve`.
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

	const body = (await response.json()) as Record<string, unknown>;
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
			// Mode 1: Messaging backend captures the tool call via event subscription.
			if (process.env.MU_OPERATOR_MESSAGING_MODE === "1") {
				return {
					content: [{ type: "text" as const, text: `Command proposal accepted: ${params.kind}` }],
					details: { kind: params.kind },
				};
			}

			// Mode 2: TUI with server — POST to /api/commands/submit.
			const serverUrl = process.env.MU_SERVER_URL;
			if (serverUrl) {
				return await executeViaServer(serverUrl, params);
			}

			// Mode 3: No server available.
			return {
				content: [{
					type: "text" as const,
					text: "No server running. Start with `mu serve` for command execution, or use messaging adapters.",
				}],
				details: { kind: params.kind, error: "no_server" },
			};
		},
	});
}

export default operatorCommandExtension;
