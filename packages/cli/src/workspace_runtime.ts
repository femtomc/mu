import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { getStorePaths as resolveStorePaths } from "@femtomc/mu-core/node";
import type { EventLog, StorePaths } from "@femtomc/mu-core/node";
import type { ForumStore } from "@femtomc/mu-forum";
import type { IssueStore } from "@femtomc/mu-issue";
import type { OperatorSessionStartOpts } from "./serve_runtime.js";

const require = createRequire(import.meta.url);

export type WorkspaceCliContext = {
	cwd: string;
	repoRoot: string;
	store: IssueStore;
	forum: ForumStore;
	events: EventLog;
	paths: StorePaths;
};

export async function fileExists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

async function writeFileIfMissing(path: string, content: string | Uint8Array): Promise<void> {
	try {
		if (typeof content === "string") {
			await writeFile(path, content, { encoding: "utf8", flag: "wx" });
		} else {
			await writeFile(path, content, { flag: "wx" });
		}
	} catch (err: unknown) {
		if (typeof err !== "object" || err == null || !("code" in err) || (err as { code?: string }).code !== "EEXIST") {
			throw err;
		}
	}
}

const BUNDLED_SKILL_FILE_NAME = "SKILL.md";
const STARTER_SKILLS_VERSION_FILE_NAME = ".starter-skills-version";

const LEGACY_TOP_LEVEL_STARTER_SKILL_DIRS = [
	"mu",
	"memory",
	"planning",
	"hud",
	"orchestration",
	"control-flow",
	"model-routing",
	"code-mode",
	"tmux",
	"heartbeats",
	"crons",
	"setup-slack",
	"setup-discord",
	"setup-telegram",
	"setup-neovim",
] as const;

async function removeLegacyTopLevelStarterSkillDirs(targetRoot: string): Promise<void> {
	for (const dirName of LEGACY_TOP_LEVEL_STARTER_SKILL_DIRS) {
		await rm(join(targetRoot, dirName), { recursive: true, force: true });
	}
}

function bundledSkillsTemplateDir(): string | null {
	try {
		const agentPkgPath = require.resolve("@femtomc/mu-agent/package.json");
		return join(dirname(agentPkgPath), "prompts", "skills");
	} catch {
		return null;
	}
}

function bundledSkillsPackageVersion(): string | null {
	try {
		const agentPkgPath = require.resolve("@femtomc/mu-agent/package.json");
		const parsed = JSON.parse(readFileSync(agentPkgPath, "utf8")) as { version?: unknown };
		if (typeof parsed.version !== "string") {
			return null;
		}
		const normalized = parsed.version.trim();
		return normalized.length > 0 ? normalized : null;
	} catch {
		return null;
	}
}

async function copyDirectoryFiles(sourceDir: string, targetDir: string, overwriteExisting: boolean): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	const entries = await readdir(sourceDir, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			await copyDirectoryFiles(sourcePath, targetPath, overwriteExisting);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		const content = await readFile(sourcePath);
		if (overwriteExisting) {
			await writeFile(targetPath, content);
		} else {
			await writeFileIfMissing(targetPath, content);
		}
	}
}

async function installBundledStarterSkills(muHomeDir: string): Promise<void> {
	const templateDir = bundledSkillsTemplateDir();
	if (!templateDir || !existsSync(templateDir)) {
		return;
	}

	const targetRoot = join(muHomeDir, "skills");
	await mkdir(targetRoot, { recursive: true });

	// Hard-cutover: always remove known legacy top-level starter-skill directories.
	// This prevents stale name-collisions from surviving once the version marker
	// is already current.
	await removeLegacyTopLevelStarterSkillDirs(targetRoot);

	const versionPath = join(targetRoot, STARTER_SKILLS_VERSION_FILE_NAME);
	const bundledVersion = bundledSkillsPackageVersion();
	let installedVersion: string | null = null;
	try {
		installedVersion = nonEmptyString(await Bun.file(versionPath).text()) ?? null;
	} catch {
		installedVersion = null;
	}
	const overwriteExisting = bundledVersion != null && installedVersion !== bundledVersion;

	const entries = await readdir(templateDir, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const sourceSkillDir = join(templateDir, entry.name);
		const sourceSkillFile = join(sourceSkillDir, BUNDLED_SKILL_FILE_NAME);
		if (!existsSync(sourceSkillFile)) {
			continue;
		}
		const targetSkillDir = join(targetRoot, entry.name);
		await copyDirectoryFiles(sourceSkillDir, targetSkillDir, overwriteExisting);
	}

	if (bundledVersion != null) {
		await writeFile(versionPath, `${bundledVersion}\n`, "utf8");
	}
}

export async function ensureStoreInitialized(ctx: Pick<WorkspaceCliContext, "paths">): Promise<void> {
	await mkdir(ctx.paths.storeDir, { recursive: true });
	await writeFile(ctx.paths.issuesPath, "", { encoding: "utf8", flag: "a" });
	await writeFile(ctx.paths.forumPath, "", { encoding: "utf8", flag: "a" });
	await writeFile(ctx.paths.eventsPath, "", { encoding: "utf8", flag: "a" });
	await mkdir(ctx.paths.logsDir, { recursive: true });

	await writeFileIfMissing(
		join(ctx.paths.storeDir, ".gitignore"),
		[
			"# Auto-generated by mu for this workspace store.",
			"# Includes logs, config, event history, and any local secrets.",
			"*",
			"!.gitignore",
			"",
		].join("\n"),
	);

	try {
		await installBundledStarterSkills(ctx.paths.muHomeDir);
	} catch {
		// Best-effort skill bootstrap. Keep store initialization resilient.
	}
}

export async function findRepoRoot(start: string): Promise<string> {
	let current = resolve(start);
	while (true) {
		if ((await fileExists(join(current, ".git", "HEAD"))) || (await fileExists(join(current, ".git")))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolve(start);
		}
		current = parent;
	}
}

export function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function storePathForRepoRoot(repoRoot: string, ...parts: string[]): string {
	return join(resolveStorePaths(repoRoot).storeDir, ...parts);
}

function operatorSessionDir(repoRoot: string): string {
	return storePathForRepoRoot(repoRoot, "operator", "sessions");
}

export function defaultOperatorSessionStart(repoRoot: string): OperatorSessionStartOpts {
	return {
		mode: "new",
		sessionDir: operatorSessionDir(repoRoot),
	};
}

export async function readServeOperatorDefaults(
	repoRoot: string,
): Promise<{ provider?: string; model?: string; thinking?: string }> {
	const configPath = storePathForRepoRoot(repoRoot, "config.json");
	try {
		const raw = await Bun.file(configPath).text();
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const controlPlane = parsed.control_plane;
		if (!controlPlane || typeof controlPlane !== "object" || Array.isArray(controlPlane)) {
			return {};
		}
		const operator = (controlPlane as Record<string, unknown>).operator;
		if (!operator || typeof operator !== "object" || Array.isArray(operator)) {
			return {};
		}
		const operatorObj = operator as Record<string, unknown>;
		return {
			provider: nonEmptyString(operatorObj.provider),
			model: nonEmptyString(operatorObj.model),
			thinking: nonEmptyString(operatorObj.thinking),
		};
	} catch {
		return {};
	}
}

export async function ensureCtx(cwd: string): Promise<WorkspaceCliContext> {
	const { FsJsonlStore, fsEventLog, getStorePaths } = await import("@femtomc/mu-core/node");
	const { IssueStore } = await import("@femtomc/mu-issue");
	const { ForumStore } = await import("@femtomc/mu-forum");
	const repoRoot = await findRepoRoot(cwd);
	const paths = getStorePaths(repoRoot);
	const events = fsEventLog(paths.eventsPath);
	const store = new IssueStore(new FsJsonlStore(paths.issuesPath), { events });
	const forum = new ForumStore(new FsJsonlStore(paths.forumPath), { events });
	return { cwd, repoRoot, store, forum, events, paths };
}
