import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuResourceLoader } from "@femtomc/mu-agent";
import { getStorePaths } from "@femtomc/mu-core/node";

async function writeSkill(baseDir: string, name: string, description?: string): Promise<void> {
	const skillDir = join(baseDir, name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description ?? `${name} description`}\n---\n\n# ${name}\n`,
		"utf8",
	);
}

describe("createMuResourceLoader skill discovery", () => {
	test("loads both pi and mu customization skill roots when present", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "mu-agent-skills-repo-"));
		const piAgentDir = await mkdtemp(join(tmpdir(), "mu-agent-skills-pi-"));
		const muHome = await mkdtemp(join(tmpdir(), "mu-agent-skills-mu-"));
		const prevMuHome = process.env.MU_HOME;
		process.env.MU_HOME = muHome;

		try {
			await writeSkill(join(piAgentDir, "skills"), "pi-global-skill");
			await writeSkill(join(repoRoot, ".pi", "skills"), "pi-project-skill");
			await writeSkill(join(repoRoot, "skills"), "repo-top-level-skill");
			await writeSkill(join(muHome, "skills"), "mu-global-skill");
			await writeSkill(join(getStorePaths(repoRoot).storeDir, "skills"), "mu-workspace-skill");

			await writeSkill(join(piAgentDir, "skills"), "prefer-mu-collision", "pi wins if ordered first");
			await writeSkill(join(muHome, "skills"), "prefer-mu-collision", "mu should win by default");

			const loader = createMuResourceLoader({ cwd: repoRoot, agentDir: piAgentDir, systemPrompt: "X" });
			await loader.reload();

			const skillNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
			expect(skillNames.has("pi-global-skill")).toBe(true);
			expect(skillNames.has("pi-project-skill")).toBe(true);
			expect(skillNames.has("repo-top-level-skill")).toBe(true);
			expect(skillNames.has("mu-global-skill")).toBe(true);
			expect(skillNames.has("mu-workspace-skill")).toBe(true);

			const preferred = loader.getSkills().skills.find((skill) => skill.name === "prefer-mu-collision");
			expect(preferred).toBeDefined();
			expect(preferred?.filePath.startsWith(join(muHome, "skills"))).toBe(true);
		} finally {
			if (prevMuHome === undefined) {
				delete process.env.MU_HOME;
			} else {
				process.env.MU_HOME = prevMuHome;
			}

			await rm(repoRoot, { recursive: true, force: true });
			await rm(piAgentDir, { recursive: true, force: true });
			await rm(muHome, { recursive: true, force: true });
		}
	});
});
