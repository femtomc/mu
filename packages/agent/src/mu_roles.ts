import { join } from "node:path";
import { DEFAULT_ORCHESTRATOR_PROMPT, DEFAULT_WORKER_PROMPT } from "./default_prompts.js";
import { splitFrontmatter } from "./prompt.js";

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

/* ------------------------------------------------------------------ */
/*  Default role prompts (bundled markdown; exported for mu init/tests) */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Role-specific system prompts                                       */
/* ------------------------------------------------------------------ */

/**
 * Load the system prompt for a role.
 *
 * When `repoRoot` is provided, tries `.mu/roles/${role}.md` first.
 * The file body IS the entire system prompt — no auto-appending.
 * Frontmatter is stripped via `splitFrontmatter`.
 * Falls back to bundled markdown defaults on any error.
 */
export async function systemPromptForRole(role: MuRole, repoRoot?: string): Promise<string> {
	if (repoRoot) {
		try {
			const filePath = join(repoRoot, ".mu", "roles", `${role}.md`);
			const raw = await Bun.file(filePath).text();
			const { body } = splitFrontmatter(raw);
			return body;
		} catch {
			// File missing or unreadable — fall through to default.
		}
	}
	return role === "orchestrator" ? DEFAULT_ORCHESTRATOR_PROMPT : DEFAULT_WORKER_PROMPT;
}
