import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OPERATOR_SYSTEM_PROMPT,
	DEFAULT_ORCHESTRATOR_PROMPT,
	DEFAULT_SOUL_PROMPT,
	DEFAULT_WORKER_PROMPT,
	appendSharedSoul,
	splitFrontmatter,
} from "@femtomc/mu-agent";

async function bundledPromptBody(name: string): Promise<string> {
	const raw = await Bun.file(new URL(`../prompts/${name}`, import.meta.url)).text();
	const { body } = splitFrontmatter(raw);
	return body.trim();
}

describe("bundled default prompts", () => {
	test("shared soul default is sourced from prompts/soul.md", async () => {
		expect(DEFAULT_SOUL_PROMPT).toBe(await bundledPromptBody("soul.md"));
	});

	test("orchestrator default is role prompt + shared soul", async () => {
		expect(DEFAULT_ORCHESTRATOR_PROMPT).toBe(
			appendSharedSoul(await bundledPromptBody("orchestrator.md"), await bundledPromptBody("soul.md")),
		);
	});

	test("worker default is role prompt + shared soul", async () => {
		expect(DEFAULT_WORKER_PROMPT).toBe(
			appendSharedSoul(await bundledPromptBody("worker.md"), await bundledPromptBody("soul.md")),
		);
	});

	test("operator default is role prompt + shared soul", async () => {
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toBe(
			appendSharedSoul(await bundledPromptBody("operator.md"), await bundledPromptBody("soul.md")),
		);
	});
});
