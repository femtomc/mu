/**
 * mu_command — Operator mutation tool.
 *
 * Registered only in operator sessions. The LLM calls this tool with a
 * structured command proposal instead of emitting fragile text directives.
 * The tool itself does nothing except confirm receipt — the actual command
 * is captured by the PiMessagingOperatorBackend subscriber on
 * tool_execution_start and routed through the existing broker/audit pipeline.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const MU_COMMAND_TOOL_NAME = "mu_command";

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
			return {
				content: [{ type: "text" as const, text: `Command proposal accepted: ${params.kind}` }],
				details: { kind: params.kind },
			};
		},
	});
}

export default operatorCommandExtension;
