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

export type MuDocumentation = {
	readmePath?: string;
	docsPath?: string;
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

	return {
		readmePath: firstExistingPath(readmeCandidates),
		docsPath: firstExistingPath(docsCandidates),
	};
}

export function appendMuDocumentationSection(basePrompt: string): string {
	const trimmed = basePrompt.trim();
	const { readmePath, docsPath } = resolveMuDocumentation();

	const lines = ["Mu documentation (for mu feature/configuration/setup questions):"];
	if (readmePath) {
		lines.push(`- Main documentation: ${readmePath}`);
	}
	if (docsPath) {
		lines.push(`- Additional docs: ${docsPath}`);
	}
	if (!readmePath && !docsPath) {
		lines.push("- Documentation path unavailable at runtime; use `mu --help` and package README files.");
	}
	lines.push("- Read these when users ask about mu capabilities, adapters, or operational setup.");

	return `${trimmed}\n\n${lines.join("\n")}`;
}
