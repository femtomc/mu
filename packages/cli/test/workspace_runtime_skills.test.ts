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

const STARTER_SKILLS = [
	"mu",
	"memory",
	"planning",
	"hud",
	"orchestration",
	"control-flow",
	"subagents",
	"heartbeats",
	"crons",
	"setup-slack",
	"setup-discord",
	"setup-telegram",
	"setup-neovim",
] as const;

test("ensureStoreInitialized seeds bundled starter skills into MU_HOME/skills", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	try {
		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });

		for (const skillName of STARTER_SKILLS) {
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

test("ensureStoreInitialized refreshes bundled starter skills when version marker is missing", async () => {
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

		const refreshed = await readFile(customSkillPath, "utf8");
		expect(refreshed).not.toBe(customSkill);
		expect(refreshed).toContain("name: subagents");
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

test("ensureStoreInitialized preserves local skill edits after initial version sync", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	const customSkillPath = join(muHome, "skills", "subagents", "SKILL.md");
	const customSkill = "---\nname: subagents\ndescription: custom override\n---\n\n# Custom\n";

	try {
		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });
		await writeFile(customSkillPath, customSkill, "utf8");
		await ensureStoreInitialized({ paths });

		expect(await readFile(customSkillPath, "utf8")).toBe(customSkill);
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
		for (const skillName of STARTER_SKILLS) {
			expect(names.has(skillName)).toBe(true);
		}

		expect(typeof session?._rebuildSystemPrompt).toBe("function");
		const prompt = session?._rebuildSystemPrompt?.(["bash", "read", "write", "edit"]) ?? "";
		expect(prompt).toContain("<available_skills>");
		for (const skillName of STARTER_SKILLS) {
			expect(prompt).toContain(`<name>${skillName}</name>`);
		}
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
