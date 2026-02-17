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

export function appendSharedSoul(basePrompt: string, soulPrompt: string): string {
	const base = basePrompt.trim();
	const soul = soulPrompt.trim();
	if (soul.length === 0) {
		return base;
	}
	return `${base}\n\n${soul}`;
}

export const DEFAULT_SOUL_PROMPT = loadBundledPrompt("roles/soul.md");

const BASE_ORCHESTRATOR_PROMPT = loadBundledPrompt("roles/orchestrator.md");
const BASE_WORKER_PROMPT = loadBundledPrompt("roles/worker.md");
const BASE_OPERATOR_SYSTEM_PROMPT = loadBundledPrompt("roles/operator.md");

export const DEFAULT_ORCHESTRATOR_PROMPT = appendSharedSoul(BASE_ORCHESTRATOR_PROMPT, DEFAULT_SOUL_PROMPT);
export const DEFAULT_WORKER_PROMPT = appendSharedSoul(BASE_WORKER_PROMPT, DEFAULT_SOUL_PROMPT);
export const DEFAULT_OPERATOR_SYSTEM_PROMPT = appendSharedSoul(BASE_OPERATOR_SYSTEM_PROMPT, DEFAULT_SOUL_PROMPT);
