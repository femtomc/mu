import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionSpecFromDict } from "@mu/core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-core-"));
}

async function writeRole(repoRoot: string, name: string, frontmatter: string, body: string): Promise<void> {
	const rolesDir = join(repoRoot, ".mu", "roles");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, `${name}.md`), `---\n${frontmatter}---\n${body}`, "utf8");
}

describe("executionSpecFromDict", () => {
	test("empty dict", () => {
		const spec = executionSpecFromDict({});
		expect(spec.role).toBeNull();
		expect(spec.prompt_path).toBeNull();
		expect(spec.cli).toBeNull();
		expect(spec.model).toBeNull();
		expect(spec.reasoning).toBeNull();
	});

	test("explicit fields", () => {
		const spec = executionSpecFromDict({
			role: "reviewer",
			cli: "claude",
			model: "opus",
			reasoning: "high",
			prompt_path: "/some/path.md",
		});
		expect(spec.role).toBe("reviewer");
		expect(spec.cli).toBe("claude");
		expect(spec.model).toBe("opus");
		expect(spec.reasoning).toBe("high");
		expect(spec.prompt_path).toBe("/some/path.md");
	});

	test("auto resolve prompt_path from role", async () => {
		const repoRoot = await mkTempDir();
		await writeRole(repoRoot, "worker", "cli: codex\n", "Worker.\n");

		const spec = executionSpecFromDict({ role: "worker" }, repoRoot);
		expect(spec.prompt_path).toBe(join(repoRoot, ".mu", "roles", "worker.md"));
	});

	test("no auto resolve without repoRoot", () => {
		const spec = executionSpecFromDict({ role: "worker" });
		expect(spec.prompt_path).toBeNull();
	});

	test("no auto resolve if role file missing", async () => {
		const repoRoot = await mkTempDir();
		await mkdir(join(repoRoot, ".mu", "roles"), { recursive: true });

		const spec = executionSpecFromDict({ role: "missing" }, repoRoot);
		expect(spec.prompt_path).toBeNull();
	});

	test("explicit prompt_path wins over role", async () => {
		const repoRoot = await mkTempDir();
		await writeRole(repoRoot, "worker", "cli: codex\n", "Worker.\n");

		const spec = executionSpecFromDict({ role: "worker", prompt_path: "/custom/prompt.md" }, repoRoot);
		expect(spec.prompt_path).toBe("/custom/prompt.md");
	});

	test("relative prompt_path resolved", async () => {
		const repoRoot = await mkTempDir();
		const spec = executionSpecFromDict({ prompt_path: "prompts/test.md" }, repoRoot);
		expect(spec.prompt_path).toBe(join(repoRoot, "prompts/test.md"));
	});

	test("empty string fields become null", () => {
		const spec = executionSpecFromDict({
			role: "",
			cli: "",
			model: "",
			reasoning: "",
			prompt_path: "",
		});
		expect(spec.role).toBeNull();
		expect(spec.cli).toBeNull();
		expect(spec.model).toBeNull();
		expect(spec.reasoning).toBeNull();
		expect(spec.prompt_path).toBeNull();
	});
});
