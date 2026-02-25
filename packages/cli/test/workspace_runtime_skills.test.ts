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
	{ name: "core", relPath: ["core"] },
	{ name: "mu", relPath: ["core", "mu"] },
	{ name: "memory", relPath: ["core", "memory"] },
	{ name: "tmux", relPath: ["core", "tmux"] },
	{ name: "code-mode", relPath: ["core", "code-mode"] },
	{ name: "subagents", relPath: ["subagents"] },
	{ name: "planning", relPath: ["subagents", "planning"] },
	{ name: "protocol", relPath: ["subagents", "protocol"] },
	{ name: "execution", relPath: ["subagents", "execution"] },
	{ name: "control-flow", relPath: ["subagents", "control-flow"] },
	{ name: "model-routing", relPath: ["subagents", "model-routing"] },
	{ name: "hud", relPath: ["subagents", "hud"] },
	{ name: "automation", relPath: ["automation"] },
	{ name: "heartbeats", relPath: ["automation", "heartbeats"] },
	{ name: "crons", relPath: ["automation", "crons"] },
	{ name: "messaging", relPath: ["messaging"] },
	{ name: "setup-slack", relPath: ["messaging", "setup-slack"] },
	{ name: "setup-discord", relPath: ["messaging", "setup-discord"] },
	{ name: "setup-telegram", relPath: ["messaging", "setup-telegram"] },
	{ name: "setup-neovim", relPath: ["messaging", "setup-neovim"] },
	{ name: "writing", relPath: ["writing"] },
] as const;

const STARTER_SKILL_NAMES = STARTER_SKILLS.map((skill) => skill.name);

test("ensureStoreInitialized seeds bundled starter skills into MU_HOME/skills", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	try {
		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });

		for (const skill of STARTER_SKILLS) {
			const skillPath = join(muHome, "skills", ...skill.relPath, "SKILL.md");
			const content = await readFile(skillPath, "utf8");
			expect(content).toContain(`name: ${skill.name}`);
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

test("bundled execution skill templates require explicit orchestration model args", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	try {
		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });
		const executionSkill = await readFile(join(muHome, "skills", "subagents", "execution", "SKILL.md"), "utf8");

		expect(executionSkill).toContain("usage: ./orch-heartbeat.sh <root-id> <provider> <model> <thinking>");
		expect(executionSkill).toContain("usage: ./orch-fanout.sh <root-id> <provider> <model> <thinking> [limit]");
		expect(executionSkill).toContain("example: ./orch-fanout.sh mu-4be265df openai-codex gpt-5.3-codex xhigh 3");
		expect(executionSkill).toContain("openai-codex / gpt-5.3-codex / xhigh");
		expect(executionSkill).toContain("Use skills subagents, protocol, execution, control-flow, model-routing, and hud");
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

test("ensureStoreInitialized hard-cutover prunes legacy top-level starter skill dirs", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	try {
		await mkdir(join(muHome, "skills", "orchestration"), { recursive: true });
		await mkdir(join(muHome, "skills", "mu"), { recursive: true });
		await writeFile(join(muHome, "skills", "orchestration", "SKILL.md"), "---\nname: orchestration\ndescription: legacy\n---\n", "utf8");
		await writeFile(join(muHome, "skills", "mu", "SKILL.md"), "---\nname: mu\ndescription: legacy\n---\n", "utf8");

		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });

		expect(await Bun.file(join(muHome, "skills", "orchestration", "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(join(muHome, "skills", "mu", "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(join(muHome, "skills", "core", "mu", "SKILL.md")).exists()).toBe(true);
		expect(await Bun.file(join(muHome, "skills", "subagents", "protocol", "SKILL.md")).exists()).toBe(true);
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

test("ensureStoreInitialized prunes legacy top-level starter skill dirs even when versions already match", async () => {
	const repoRoot = await mkTempRepo();
	const muHome = await mkdtemp(join(tmpdir(), "mu-cli-skill-home-"));
	const previousMuHome = process.env.MU_HOME;
	process.env.MU_HOME = muHome;

	try {
		const paths = getStorePaths(repoRoot);
		await ensureStoreInitialized({ paths });

		await mkdir(join(muHome, "skills", "control-flow"), { recursive: true });
		await mkdir(join(muHome, "skills", "setup-neovim"), { recursive: true });
		await writeFile(join(muHome, "skills", "control-flow", "SKILL.md"), "---\nname: control-flow\ndescription: legacy\n---\n", "utf8");
		await writeFile(join(muHome, "skills", "setup-neovim", "SKILL.md"), "---\nname: setup-neovim\ndescription: legacy\n---\n", "utf8");

		await ensureStoreInitialized({ paths });

		expect(await Bun.file(join(muHome, "skills", "control-flow", "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(join(muHome, "skills", "setup-neovim", "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(join(muHome, "skills", "subagents", "control-flow", "SKILL.md")).exists()).toBe(true);
		expect(await Bun.file(join(muHome, "skills", "messaging", "setup-neovim", "SKILL.md")).exists()).toBe(true);
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
		for (const skillName of STARTER_SKILL_NAMES) {
			expect(names.has(skillName)).toBe(true);
		}
		expect(names.has("orchestration")).toBe(false);

		expect(typeof session?._rebuildSystemPrompt).toBe("function");
		const prompt = session?._rebuildSystemPrompt?.(["bash", "read", "write", "edit"]) ?? "";
		expect(prompt).toContain("<available_skills>");
		for (const skillName of STARTER_SKILL_NAMES) {
			expect(prompt).toContain(`<name>${skillName}</name>`);
		}
		expect(prompt).not.toContain("<name>orchestration</name>");
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
