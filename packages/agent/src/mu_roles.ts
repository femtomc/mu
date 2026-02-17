import { DEFAULT_ORCHESTRATOR_PROMPT, DEFAULT_WORKER_PROMPT } from "./default_prompts.js";

export type MuRole = "orchestrator" | "worker";

/** Determine role from tags. Defaults to orchestrator if no role tag present. */
export function roleFromTags(tags: readonly string[]): MuRole {
	for (const tag of tags) {
		if (tag === "role:worker") return "worker";
		if (tag === "role:orchestrator") return "orchestrator";
	}
	return "orchestrator";
}

export { DEFAULT_ORCHESTRATOR_PROMPT, DEFAULT_WORKER_PROMPT };

/**
 * Load the system prompt for a role.
 *
 * Role prompts are sourced from bundled markdown defaults only.
 * Repo-local `.mu/roles/*.md` overrides are intentionally unsupported.
 */
export async function systemPromptForRole(role: MuRole, _repoRoot?: string): Promise<string> {
	return role === "orchestrator" ? DEFAULT_ORCHESTRATOR_PROMPT : DEFAULT_WORKER_PROMPT;
}
