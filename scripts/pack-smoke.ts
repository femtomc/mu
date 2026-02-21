import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CmdResult = { code: number; stdout: string; stderr: string };

function repoRootFromHere(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function runCmd(cmd: string, args: string[], opts: { cwd: string }): Promise<CmdResult> {
	const proc = Bun.spawn({
		cmd: [cmd, ...args],
		cwd: opts.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
}

function invariant(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

async function bunPack(pkgDir: string, packDest: string): Promise<string> {
	const r = await runCmd("bun", ["pm", "pack", "--destination", packDest, "--quiet"], { cwd: pkgDir });
	if (r.code !== 0) {
		throw new Error(`bun pm pack failed in ${pkgDir} (code=${r.code})\n${r.stderr || r.stdout}`);
	}

	// bun pm pack prints the tarball path to stdout
	const tarball = r.stdout.trim().split("\n").pop()?.trim();
	invariant(typeof tarball === "string" && tarball.length > 0, `bun pm pack missing output in ${pkgDir}`);

	// bun pm pack output may be an absolute path or just a filename
	const tgzPath = tarball.startsWith("/") ? tarball : join(packDest, tarball);
	invariant(await Bun.file(tgzPath).exists(), `bun pm pack tarball not found: ${tgzPath}`);
	return tgzPath;
}

async function main(): Promise<void> {
	const repoRoot = repoRootFromHere();

	// Ensure dist exists (pack should never ship src/*.ts entrypoints).
	const distChecks = [
		join(repoRoot, "packages/core/dist/index.js"),
		join(repoRoot, "packages/core/dist/index.d.ts"),
		join(repoRoot, "packages/core/dist/node/index.js"),
		join(repoRoot, "packages/core/dist/node/index.d.ts"),
		join(repoRoot, "packages/core/dist/browser/index.js"),
		join(repoRoot, "packages/core/dist/browser/index.d.ts"),
		join(repoRoot, "packages/agent/dist/index.js"),
		join(repoRoot, "packages/agent/dist/index.d.ts"),
		join(repoRoot, "packages/forum/dist/index.js"),
		join(repoRoot, "packages/issue/dist/index.js"),
		join(repoRoot, "packages/cli/dist/index.js"),
		join(repoRoot, "packages/cli/dist/cli.js"),
	];
	for (const p of distChecks) {
		invariant(await Bun.file(p).exists(), `missing build artifact: ${p} (run: bun run build)`);
	}

	const tmp = await mkdtemp(join(tmpdir(), "mu-pack-smoke-"));
	const keep = Bun.env.MU_PACK_SMOKE_KEEP === "1";

	try {
		const packDir = join(tmp, "packs");
		const projDir = join(tmp, "proj");
		await mkdir(packDir, { recursive: true });
		await mkdir(projDir, { recursive: true });

		const pkgs = [
			{ name: "@femtomc/mu-core", dir: join(repoRoot, "packages/core") },
			{ name: "@femtomc/mu-agent", dir: join(repoRoot, "packages/agent") },
			{ name: "@femtomc/mu-forum", dir: join(repoRoot, "packages/forum") },
			{ name: "@femtomc/mu-issue", dir: join(repoRoot, "packages/issue") },
			{ name: "@femtomc/mu", dir: join(repoRoot, "packages/cli") },
		] as const;

		const tarballs: string[] = [];
		for (const p of pkgs) {
			const tgz = await bunPack(p.dir, packDir);
			tarballs.push(tgz);
		}

		await writeFile(
			join(projDir, "package.json"),
			JSON.stringify({ name: "mu-pack-smoke", private: true, type: "module" }, null, 2) + "\n",
			"utf8",
		);

		const install = await runCmd("bun", ["install", ...tarballs], { cwd: projDir });
		if (install.code !== 0) {
			throw new Error(`bun install failed (code=${install.code})\n${install.stderr || install.stdout}`);
		}

		const smokeMjs = `import { newRunId } from "@femtomc/mu-core";
import { roleFromTags } from "@femtomc/mu-agent";
import { readJsonl } from "@femtomc/mu-core/node";
import { LocalStorageJsonlStore } from "@femtomc/mu-core/browser";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { run } from "@femtomc/mu";

if (typeof newRunId !== "function") throw new Error("@femtomc/mu-core missing newRunId");
if (typeof roleFromTags !== "function") throw new Error("@femtomc/mu-agent missing roleFromTags");
if (typeof readJsonl !== "function") throw new Error("@femtomc/mu-core/node missing readJsonl");
if (typeof LocalStorageJsonlStore !== "function") throw new Error("@femtomc/mu-core/browser missing LocalStorageJsonlStore");
if (typeof ForumStore !== "function") throw new Error("@femtomc/mu-forum missing ForumStore");
if (typeof IssueStore !== "function") throw new Error("@femtomc/mu-issue missing IssueStore");

const help = await run(["--help"]);
if (help.exitCode !== 0) throw new Error("@femtomc/mu --help failed");
if (!help.stdout.includes("Usage:")) throw new Error("@femtomc/mu help missing Usage");

console.log("ok");
`;
		await writeFile(join(projDir, "smoke.mjs"), smokeMjs, "utf8");

		const smoke = await runCmd("bun", ["smoke.mjs"], { cwd: projDir });
		if (smoke.code !== 0) {
			throw new Error(`bun smoke.mjs failed (code=${smoke.code})\n${smoke.stderr || smoke.stdout}`);
		}

		const binPath = join(projDir, "node_modules", ".bin", "mu");
		const muHelp = await runCmd(binPath, ["--help"], { cwd: projDir });
		if (muHelp.code !== 0) {
			throw new Error(`mu --help failed (code=${muHelp.code})\n${muHelp.stderr || muHelp.stdout}`);
		}
		if (!muHelp.stdout.includes("mu <command>")) {
			throw new Error("mu --help output missing expected text");
		}
	} finally {
		if (!keep) {
			await rm(tmp, { recursive: true, force: true });
		}
	}
}

await main();
