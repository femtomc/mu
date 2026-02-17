import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OPERATOR_SYSTEM_PROMPT,
	DEFAULT_ORCHESTRATOR_PROMPT,
	DEFAULT_WORKER_PROMPT,
	splitFrontmatter,
} from "@femtomc/mu-agent";

async function bundledPromptBody(name: string): Promise<string> {
	const raw = await Bun.file(new URL(`../prompts/${name}`, import.meta.url)).text();
	const { body } = splitFrontmatter(raw);
	return body.trim();
}

describe("bundled default prompts", () => {
	test("orchestrator default is sourced from prompts/orchestrator.md", async () => {
		expect(DEFAULT_ORCHESTRATOR_PROMPT).toBe(await bundledPromptBody("orchestrator.md"));
	});

	test("worker default is sourced from prompts/worker.md", async () => {
		expect(DEFAULT_WORKER_PROMPT).toBe(await bundledPromptBody("worker.md"));
	});

	test("operator default is sourced from prompts/operator.md", async () => {
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toBe(await bundledPromptBody("operator.md"));
	});
});
