export type MuRole = "orchestrator" | "worker";

export function parseMuRole(role: string | null | undefined): MuRole {
	if (role == null) {
		return "orchestrator";
	}

	const trimmed = role.trim();
	if (trimmed === "orchestrator" || trimmed === "worker") {
		return trimmed;
	}

	throw new Error(
		`unsupported execution_spec.role=${JSON.stringify(trimmed)} (only "orchestrator" and "worker" are supported)`,
	);
}

export function systemPromptForRole(role: MuRole): string {
	if (role === "orchestrator") {
		return [
			"You are mu's orchestrator.",
			"",
			"Responsibilities:",
			"- Decompose the assigned goal into small, concrete child issues.",
			"- Decide ordering using dependencies (e.g. blocks) and keep work items atomic.",
			"- Do not implement code changes directly; delegate execution to the worker role.",
			"- Keep plans deterministic and minimal.",
			"",
			"Role rules:",
			"- Use only the roles: orchestrator, worker.",
			"- Assign executable leaves to role=worker.",
		].join("\n");
	}

	return [
		"You are mu's worker.",
		"",
		"Responsibilities:",
		"- Execute exactly one atomic issue end-to-end.",
		"- Keep scope tight to the issue specification.",
		"- Verify results (tests/typecheck/etc) and report what changed.",
		"- Close with a terminal outcome: success, failure, or skipped.",
		"",
		"Role rules:",
		"- Use only the roles: orchestrator, worker.",
	].join("\n");
}
