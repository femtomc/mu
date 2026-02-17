import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitFrontmatter } from "./prompt.js";

function bundledPromptPath(name: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "prompts", name);
}

/**
 * Load a bundled markdown prompt from packages/agent/prompts.
 *
 * This is intentionally strict: bundled prompt markdown is the single source
 * of truth for default system prompts.
 */
export function loadBundledPrompt(name: string): string {
	const path = bundledPromptPath(name);
	const raw = readFileSync(path, "utf8");
	const { body } = splitFrontmatter(raw);
	const prompt = body.trim();
	if (prompt.length === 0) {
		throw new Error(`bundled prompt is empty: ${name}`);
	}
	return prompt;
}

export const DEFAULT_ORCHESTRATOR_PROMPT = loadBundledPrompt("orchestrator.md");
export const DEFAULT_WORKER_PROMPT = loadBundledPrompt("worker.md");
export const DEFAULT_OPERATOR_SYSTEM_PROMPT = loadBundledPrompt("operator.md");
