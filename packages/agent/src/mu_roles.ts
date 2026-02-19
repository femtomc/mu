import { DEFAULT_ORCHESTRATOR_PROMPT, DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT } from "./default_prompts.js";

export type MuRole = "orchestrator" | "reviewer" | "worker";

/** Determine role from tags. Defaults to orchestrator if no role tag present. */
export function roleFromTags(tags: readonly string[]): MuRole {
	for (const tag of tags) {
		if (tag === "role:worker") return "worker";
		if (tag === "role:reviewer") return "reviewer";
		if (tag === "role:orchestrator") return "orchestrator";
	}
	return "orchestrator";
}

export { DEFAULT_ORCHESTRATOR_PROMPT, DEFAULT_REVIEWER_PROMPT, DEFAULT_WORKER_PROMPT };

/**
 * Load the system prompt for a role.
 *
 * Role prompts are sourced from bundled markdown defaults only.
 * Repo-local `.mu/roles/*.md` overrides are intentionally unsupported.
 */
export async function systemPromptForRole(role: MuRole, _repoRoot?: string): Promise<string> {
	if (role === "worker") {
		return DEFAULT_WORKER_PROMPT;
	}
	if (role === "reviewer") {
		return DEFAULT_REVIEWER_PROMPT;
	}
	return DEFAULT_ORCHESTRATOR_PROMPT;
}
