import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type PackageManifest = {
	version: string;
};

const VERSION_TEXT_PATTERN = /(<text\b[^>]*id="mu-version"[^>]*>\s*)([^<]*?)(\s*<\/text>)/m;

function repoRootFromHere(): string {
	return resolve(import.meta.dir, "..");
}

function parseArgs(argv: string[]): { checkOnly: boolean } {
	const checkOnly = argv.includes("--check");
	return { checkOnly };
}

function assertString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

async function readVersion(packageJsonPath: string): Promise<string> {
	const raw = await readFile(packageJsonPath, "utf8");
	const parsed = JSON.parse(raw) as PackageManifest;
	return assertString(parsed.version, "package.json version");
}

async function main(): Promise<void> {
	const { checkOnly } = parseArgs(Bun.argv.slice(2));
	const repoRoot = repoRootFromHere();
	const packageJsonPath = join(repoRoot, "package.json");
	const logoPath = join(repoRoot, "assets", "mu-periodic-logo.svg");

	const [expectedVersion, logoSvg] = await Promise.all([
		readVersion(packageJsonPath),
		readFile(logoPath, "utf8"),
	]);

	const match = logoSvg.match(VERSION_TEXT_PATTERN);
	if (!match) {
		throw new Error(`unable to find version label (id=\"mu-version\") in ${logoPath}`);
	}
	const currentVersion = match[2]?.trim() ?? "";
	const normalizedCurrentVersion = assertString(currentVersion, "logo version text");

	if (normalizedCurrentVersion === expectedVersion) {
		console.log(`Logo version is up to date (${expectedVersion}).`);
		return;
	}

	if (checkOnly) {
		console.error(
			`Logo version mismatch: expected ${expectedVersion}, found ${normalizedCurrentVersion}. Run: bun run logo:sync-version`,
		);
		process.exit(1);
	}

	const updatedSvg = logoSvg.replace(VERSION_TEXT_PATTERN, `$1${expectedVersion}$3`);
	if (updatedSvg === logoSvg) {
		throw new Error("logo version replacement made no changes");
	}

	await writeFile(logoPath, updatedSvg, "utf8");
	console.log(`Updated logo version: ${normalizedCurrentVersion} -> ${expectedVersion}`);
}

await main();
