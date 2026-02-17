import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export type StorePaths = {
	repoRoot: string;
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
		const storeDir = join(current, ".mu");
		if (isDirectory(storeDir)) {
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
	const storeDir = join(repoRoot, ".mu");
	return {
		repoRoot,
		storeDir,
		issuesPath: join(storeDir, "issues.jsonl"),
		forumPath: join(storeDir, "forum.jsonl"),
		eventsPath: join(storeDir, "events.jsonl"),
		logsDir: join(storeDir, "logs"),
	};
}
