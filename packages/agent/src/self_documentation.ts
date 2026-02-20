import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function findPackageRoot(startDir: string): string {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return resolve(startDir);
		}
		dir = parent;
	}
}

function firstExistingPath(candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

type MuPackageReadme = {
	label: string;
	path: string;
};

const INSTALLED_PACKAGE_README_LOOKUP = [
	{ packageName: "@femtomc/mu-agent", label: "@femtomc/mu-agent" },
	{ packageName: "@femtomc/mu-control-plane", label: "@femtomc/mu-control-plane" },
	{ packageName: "@femtomc/mu-core", label: "@femtomc/mu-core" },
	{ packageName: "@femtomc/mu-forum", label: "@femtomc/mu-forum" },
	{ packageName: "@femtomc/mu-issue", label: "@femtomc/mu-issue" },
	{ packageName: "@femtomc/mu-orchestrator", label: "@femtomc/mu-orchestrator" },
	{ packageName: "@femtomc/mu-server", label: "@femtomc/mu-server" },
] as const;

const MONOREPO_PACKAGE_README_LOOKUP = [
	{ relPath: join("packages", "agent", "README.md"), label: "@femtomc/mu-agent" },
	{ relPath: join("packages", "control-plane", "README.md"), label: "@femtomc/mu-control-plane" },
	{ relPath: join("packages", "core", "README.md"), label: "@femtomc/mu-core" },
	{ relPath: join("packages", "forum", "README.md"), label: "@femtomc/mu-forum" },
	{ relPath: join("packages", "issue", "README.md"), label: "@femtomc/mu-issue" },
	{ relPath: join("packages", "orchestrator", "README.md"), label: "@femtomc/mu-orchestrator" },
	{ relPath: join("packages", "server", "README.md"), label: "@femtomc/mu-server" },
	{ relPath: join("packages", "cli", "README.md"), label: "@femtomc/mu (CLI)" },
	{ relPath: join("packages", "neovim", "README.md"), label: "mu.nvim" },
] as const;

function resolvePackageRoot(packageName: string): string | undefined {
	try {
		const entry = require.resolve(packageName);
		return findPackageRoot(dirname(entry));
	} catch {
		return undefined;
	}
}

function findPackageReadmesFromInstalledPackages(): MuPackageReadme[] {
	const readmes: MuPackageReadme[] = [];
	for (const candidate of INSTALLED_PACKAGE_README_LOOKUP) {
		const root = resolvePackageRoot(candidate.packageName);
		if (!root) {
			continue;
		}
		const readmePath = join(root, "README.md");
		if (existsSync(readmePath)) {
			readmes.push({ label: candidate.label, path: readmePath });
		}
	}
	return readmes;
}

function findPackageReadmesFromMonorepoRoots(candidateRoots: readonly string[]): MuPackageReadme[] {
	const roots = new Set<string>();
	for (const root of candidateRoots) {
		roots.add(root);
		roots.add(resolve(root, "..", ".."));
	}

	const readmes: MuPackageReadme[] = [];
	for (const root of roots) {
		for (const candidate of MONOREPO_PACKAGE_README_LOOKUP) {
			const readmePath = join(root, candidate.relPath);
			if (existsSync(readmePath)) {
				readmes.push({ label: candidate.label, path: readmePath });
			}
		}
	}
	return readmes;
}

function uniquePackageReadmes(readmes: readonly MuPackageReadme[]): MuPackageReadme[] {
	const seenPaths = new Set<string>();
	const unique: MuPackageReadme[] = [];
	for (const readme of readmes) {
		if (seenPaths.has(readme.path)) {
			continue;
		}
		seenPaths.add(readme.path);
		unique.push(readme);
	}
	return unique;
}

export type MuDocumentation = {
	readmePath?: string;
	docsPath?: string;
	packageReadmes: MuPackageReadme[];
};

export function resolveMuDocumentation(): MuDocumentation {
	const thisModuleDir = dirname(fileURLToPath(import.meta.url));
	const agentPackageRoot = findPackageRoot(thisModuleDir);

	let muPackageRoot: string | undefined;
	try {
		const muEntry = require.resolve("@femtomc/mu");
		muPackageRoot = findPackageRoot(dirname(muEntry));
	} catch {
		muPackageRoot = undefined;
	}

	const candidateRoots = [muPackageRoot, agentPackageRoot].filter((v): v is string => Boolean(v));

	const readmeCandidates: string[] = [];
	const docsCandidates: string[] = [];
	for (const root of candidateRoots) {
		readmeCandidates.push(resolve(root, "..", "..", "README.md"));
		readmeCandidates.push(join(root, "README.md"));
		docsCandidates.push(resolve(root, "..", "..", "docs"));
		docsCandidates.push(join(root, "docs"));
	}

	const packageReadmes = uniquePackageReadmes([
		...findPackageReadmesFromInstalledPackages(),
		...findPackageReadmesFromMonorepoRoots(candidateRoots),
	]);

	return {
		readmePath: firstExistingPath(readmeCandidates),
		docsPath: firstExistingPath(docsCandidates),
		packageReadmes,
	};
}

export function appendMuDocumentationSection(basePrompt: string): string {
	const trimmed = basePrompt.trim();
	const { readmePath, docsPath, packageReadmes } = resolveMuDocumentation();

	const lines = ["Mu documentation (for mu feature/configuration/setup questions):"];
	if (readmePath) {
		lines.push(`- Main documentation: ${readmePath}`);
	}
	if (docsPath) {
		lines.push(`- Additional docs: ${docsPath}`);
	}
	if (packageReadmes.length > 0) {
		lines.push("- Package READMEs:");
		for (const readme of packageReadmes) {
			lines.push(`  - ${readme.label}: ${readme.path}`);
		}
	} else {
		lines.push("- Package README paths unavailable at runtime.");
	}
	if (!readmePath && !docsPath) {
		lines.push("- Documentation path unavailable at runtime; use `mu --help` and package README files.");
	}
	lines.push("- Read these when users ask about mu capabilities, adapters, or operational setup.");

	return `${trimmed}\n\n${lines.join("\n")}`;
}
