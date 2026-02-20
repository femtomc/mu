import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function toDirectory(path: string): string {
	try {
		const st = statSync(path);
		if (st.isDirectory()) {
			return path;
		}
		return dirname(path);
	} catch {
		// If the path doesn't exist, treat it as a directory-like string.
		return path;
	}
}

function isRepositoryRoot(path: string): boolean {
	return exists(join(path, ".git"));
}

function safeSlug(value: string): string {
	const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	const collapsed = cleaned.replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
	return collapsed.length > 0 ? collapsed : "workspace";
}

export function getMuHomeDir(): string {
	const env = process.env.MU_HOME?.trim();
	if (env && env.length > 0) {
		return resolve(env);
	}
	return join(homedir(), ".mu");
}

export function workspaceIdForRepoRoot(repoRoot: string): string {
	const normalizedRepoRoot = resolve(repoRoot);
	const name = safeSlug(basename(normalizedRepoRoot));
	const hash = createHash("sha256").update(normalizedRepoRoot).digest("hex").slice(0, 16);
	return `${name}-${hash}`;
}

export type StorePaths = {
	repoRoot: string;
	muHomeDir: string;
	workspaceId: string;
	storeDir: string;
	issuesPath: string;
	forumPath: string;
	eventsPath: string;
	logsDir: string;
};

export function findRepoRoot(start: string = process.cwd()): string {
	const startDir = resolve(toDirectory(start));
	let current = startDir;

	while (true) {
		if (isRepositoryRoot(current)) {
			return current;
		}

		const parent = dirname(current);
		if (parent === current) {
			return startDir;
		}
		current = parent;
	}
}

export function getStorePaths(repoRoot: string): StorePaths {
	const resolvedRepoRoot = resolve(repoRoot);
	const muHomeDir = getMuHomeDir();
	const workspaceId = workspaceIdForRepoRoot(resolvedRepoRoot);
	const storeDir = join(muHomeDir, "workspaces", workspaceId);
	return {
		repoRoot: resolvedRepoRoot,
		muHomeDir,
		workspaceId,
		storeDir,
		issuesPath: join(storeDir, "issues.jsonl"),
		forumPath: join(storeDir, "forum.jsonl"),
		eventsPath: join(storeDir, "events.jsonl"),
		logsDir: join(storeDir, "logs"),
	};
}
