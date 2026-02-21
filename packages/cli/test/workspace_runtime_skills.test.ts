import { expect, test } from "bun:test";
import { createMuSession } from "@femtomc/mu-agent";
import { getStorePaths } from "@femtomc/mu-core/node";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStoreInitialized } from "../src/workspace_runtime.js";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-cli-skill-bootstrap-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

test("ensureStoreInitialized seeds bundled starter skills into MU_HOME/skills", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	try {
		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });

		for (const skillName of ["planning", "subagents", "reviewer"] as const) {
			const skillPath = join(muHome, "skills", skillName, "SKILL.md");
			const content = await readFile(skillPath, "utf8");
			expect(content).toContain(`name: ${skillName}`);
		}
	} finally {
		if (previousMuHome === undefined) {
			delete process.env.MU_HOME;
		} else {
			process.env.MU_HOME = previousMuHome;
		}
		await rm(repoRoot, { recursive: true, force: true });
		await rm(muHome, { recursive: true, force: true });
	}
});

test("ensureStoreInitialized preserves existing user skill files", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	const customSkillDir = join(muHome, "skills", "subagents");
	const customSkillPath = join(customSkillDir, "SKILL.md");
	const customSkill = "---\nname: subagents\ndescription: custom override\n---\n\n# Custom\n";

	try {
		await mkdir(customSkillDir, { recursive: true });
		await writeFile(customSkillPath, customSkill, "utf8");

		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });

		expect(await readFile(customSkillPath, "utf8")).toBe(customSkill);
		expect(await readFile(join(muHome, "skills", "planning", "SKILL.md"), "utf8")).toContain("name: planning");
		expect(await readFile(join(muHome, "skills", "reviewer", "SKILL.md"), "utf8")).toContain("name: reviewer");
	} finally {
		if (previousMuHome === undefined) {
			delete process.env.MU_HOME;
		} else {
			process.env.MU_HOME = previousMuHome;
		}
		await rm(repoRoot, { recursive: true, force: true });
		await rm(muHome, { recursive: true, force: true });
	}
});

type SessionSkillProbe = {
	dispose: () => void;
	resourceLoader?: {
		getSkills: () => { skills: Array<{ name: string }> };
	};
	_rebuildSystemPrompt?: (toolNames: string[]) => string;
};

test("seeded starter skills are discovered and injected into session prompts", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	let session: SessionSkillProbe | null = null;

	try {
		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });

		session = (await createMuSession({
			cwd: repoRoot,
			systemPrompt: "You are a test operator.",
		})) as unknown as SessionSkillProbe;

		const names = new Set((session?.resourceLoader?.getSkills().skills ?? []).map((skill) => skill.name));
		expect(names.has("planning")).toBe(true);
		expect(names.has("subagents")).toBe(true);
		expect(names.has("reviewer")).toBe(true);

		expect(typeof session?._rebuildSystemPrompt).toBe("function");
		const prompt = session?._rebuildSystemPrompt?.(["bash", "read", "write", "edit"]) ?? "";
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>planning</name>");
		expect(prompt).toContain("<name>subagents</name>");
		expect(prompt).toContain("<name>reviewer</name>");
	} finally {
		try {
			session?.dispose();
		} catch {
			// best-effort cleanup
		}
		if (previousMuHome === undefined) {
			delete process.env.MU_HOME;
		} else {
			process.env.MU_HOME = previousMuHome;
		}
		await rm(repoRoot, { recursive: true, force: true });
		await rm(muHome, { recursive: true, force: true });
	}
});
