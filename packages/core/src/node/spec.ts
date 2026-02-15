import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExecutionSpec } from "../spec.js";

function emptyStringToNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function executionSpecFromDict(d: Record<string, unknown>, repoRoot?: string): ExecutionSpec {
	let prompt_path = emptyStringToNull(d.prompt_path);
	const role = emptyStringToNull(d.role);

	// Auto-resolve prompt_path from role name
	if (!prompt_path && role && repoRoot) {
		const candidate = join(repoRoot, ".inshallah", "roles", `${role}.md`);
		if (existsSync(candidate)) {
			prompt_path = candidate;
		}
	}

	// Resolve relative prompt_path against repoRoot
	if (repoRoot && prompt_path && !isAbsolute(prompt_path)) {
		prompt_path = join(repoRoot, prompt_path);
	}

	return {
		role,
		prompt_path,
		cli: emptyStringToNull(d.cli),
		model: emptyStringToNull(d.model),
		reasoning: emptyStringToNull(d.reasoning),
	};
}
