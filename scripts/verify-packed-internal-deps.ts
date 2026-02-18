import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type PackageManifest = {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
};

const PUBLISH_PACKAGE_DIRS = [
	"packages/core",
	"packages/agent",
	"packages/control-plane",
	"packages/forum",
	"packages/issue",
	"packages/orchestrator",
	"packages/server",
	"packages/cli",
] as const;

async function readManifest(path: string): Promise<PackageManifest> {
	return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

function parsePackedPath(stdout: string): string {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const packedPath = lines[lines.length - 1];
	if (!packedPath) {
		throw new Error("unable to determine packed tarball path from `bun pm pack --quiet` output");
	}
	return packedPath;
}

async function readPackedManifest(packageDir: string): Promise<PackageManifest> {
	const dest = await mkdtemp(join(tmpdir(), "mu-pack-check-"));
	try {
		const packed = Bun.spawnSync({
			cmd: ["bun", "pm", "pack", "--destination", dest, "--quiet"],
			cwd: packageDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (packed.exitCode !== 0) {
			throw new Error(
				`bun pm pack failed for ${packageDir}: ${new TextDecoder().decode(packed.stderr).trim() || `exit ${packed.exitCode}`}`,
			);
		}
		const stdout = new TextDecoder().decode(packed.stdout);
		const tarballPath = parsePackedPath(stdout);

		const unpacked = Bun.spawnSync({
			cmd: ["tar", "-xOf", tarballPath, "package/package.json"],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (unpacked.exitCode !== 0) {
			throw new Error(
				`failed to read packed package.json for ${packageDir}: ${new TextDecoder().decode(unpacked.stderr).trim() || `exit ${unpacked.exitCode}`}`,
			);
		}
		return JSON.parse(new TextDecoder().decode(unpacked.stdout)) as PackageManifest;
	} finally {
		await rm(dest, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const repoRoot = resolve(import.meta.dir, "..");
	const expectedVersions = new Map<string, string>();

	for (const relDir of PUBLISH_PACKAGE_DIRS) {
		const manifestPath = join(repoRoot, relDir, "package.json");
		const manifest = await readManifest(manifestPath);
		expectedVersions.set(manifest.name, manifest.version);
	}

	const failures: string[] = [];

	for (const relDir of PUBLISH_PACKAGE_DIRS) {
		const packageDir = join(repoRoot, relDir);
		const packedManifest = await readPackedManifest(packageDir);
		const deps = packedManifest.dependencies ?? {};

		for (const [name, expectedVersion] of expectedVersions.entries()) {
			const actual = deps[name];
			if (!actual) {
				continue;
			}
			if (actual !== expectedVersion) {
				failures.push(
					`${packedManifest.name}: dependency ${name} expected ${expectedVersion} but packed as ${actual}`,
				);
			}
		}
	}

	if (failures.length > 0) {
		console.error("Packed dependency version check failed:\n");
		for (const line of failures) {
			console.error(`- ${line}`);
		}
		console.error(
			"\nHint: refresh bun.lock workspace versions before publish (e.g. `bun run lock:refresh`), then re-run this check.",
		);
		process.exit(1);
	}

	console.log("Packed dependency version check passed.");
}

await main();
