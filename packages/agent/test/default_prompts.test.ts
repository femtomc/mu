import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OPERATOR_SYSTEM_PROMPT,
	DEFAULT_SOUL_PROMPT,
	appendSharedSoul,
	splitFrontmatter,
} from "@femtomc/mu-agent";

async function bundledPromptBody(name: string): Promise<string> {
	const raw = await Bun.file(new URL(`../prompts/${name}`, import.meta.url)).text();
	const { body } = splitFrontmatter(raw);
	return body.trim();
}

describe("bundled default prompts", () => {
	test("shared soul default is sourced from prompts/roles/soul.md", async () => {
		expect(DEFAULT_SOUL_PROMPT).toBe(await bundledPromptBody("roles/soul.md"));
	});

	test("operator default is role prompt + shared soul + mu docs guidance", async () => {
		const base = appendSharedSoul(await bundledPromptBody("roles/operator.md"), await bundledPromptBody("roles/soul.md"));
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT.startsWith(base)).toBe(true);
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("Mu documentation (for mu feature/configuration/setup questions):");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("- Read these when users ask about mu capabilities");
		expect(
			DEFAULT_OPERATOR_SYSTEM_PROMPT.includes("- Package READMEs:") ||
				DEFAULT_OPERATOR_SYSTEM_PROMPT.includes("- Package README paths unavailable at runtime."),
		).toBe(true);
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).not.toContain("/path/to/README.md");
	});
});
