import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CmdResult = { code: number; stdout: string; stderr: string };

function repoRootFromHere(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function runCmd(cmd: string, args: string[], opts: { cwd: string }): Promise<CmdResult> {
	return await new Promise((resolvePromise, reject) => {
		const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (d) => {
			stdout += String(d);
		});
		proc.stderr?.on("data", (d) => {
			stderr += String(d);
		});
		proc.once("error", (err) => reject(err));
		proc.once("close", (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
	});
}

function invariant(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

async function npmPack(pkgDir: string, packDest: string): Promise<string> {
	const r = await runCmd("npm", ["pack", "--json", "--pack-destination", packDest], { cwd: pkgDir });
	if (r.code !== 0) {
		throw new Error(`npm pack failed in ${pkgDir} (code=${r.code})\n${r.stderr || r.stdout}`);
	}

	let parsed: any;
	try {
		parsed = JSON.parse(r.stdout);
	} catch (err) {
		throw new Error(`npm pack did not return JSON in ${pkgDir}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
	}

	invariant(Array.isArray(parsed) && parsed.length > 0, `npm pack JSON missing entries in ${pkgDir}`);
	const filename = parsed[0]?.filename;
	invariant(typeof filename === "string" && filename.length > 0, `npm pack JSON missing filename in ${pkgDir}`);
	return join(packDest, filename);
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
		join(repoRoot, "packages/forum/dist/index.js"),
		join(repoRoot, "packages/issue/dist/index.js"),
		join(repoRoot, "packages/orchestrator/dist/index.js"),
		join(repoRoot, "packages/cli/dist/index.js"),
		join(repoRoot, "packages/cli/dist/cli.js"),
	];
	for (const p of distChecks) {
		invariant(existsSync(p), `missing build artifact: ${p} (run: bun run build)`);
	}

	const tmp = await mkdtemp(join(tmpdir(), "mu-pack-smoke-"));
	const keep = process.env.MU_PACK_SMOKE_KEEP === "1";

	try {
		const packDir = join(tmp, "packs");
		const projDir = join(tmp, "proj");
		await mkdir(packDir, { recursive: true });
		await mkdir(projDir, { recursive: true });

		const pkgs = [
			{ name: "@femtomc/mu-core", dir: join(repoRoot, "packages/core") },
			{ name: "@femtomc/mu-forum", dir: join(repoRoot, "packages/forum") },
			{ name: "@femtomc/mu-issue", dir: join(repoRoot, "packages/issue") },
			{ name: "@femtomc/mu-orchestrator", dir: join(repoRoot, "packages/orchestrator") },
			{ name: "@femtomc/mu", dir: join(repoRoot, "packages/cli") },
		] as const;

		const tarballs: string[] = [];
		for (const p of pkgs) {
			const tgz = await npmPack(p.dir, packDir);
			tarballs.push(tgz);
		}

		await writeFile(
			join(projDir, "package.json"),
			JSON.stringify({ name: "mu-pack-smoke", private: true, type: "module" }, null, 2) + "\n",
			"utf8",
		);

		const install = await runCmd("npm", ["install", "--no-audit", "--no-fund", ...tarballs], { cwd: projDir });
		if (install.code !== 0) {
			throw new Error(`npm install failed (code=${install.code})\n${install.stderr || install.stdout}`);
		}

		const smokeMjs = `import { newRunId } from "@femtomc/mu-core";
import { readJsonl } from "@femtomc/mu-core/node";
import { LocalStorageJsonlStore } from "@femtomc/mu-core/browser";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { orchestratorHello } from "@femtomc/mu-orchestrator";
import { run } from "@femtomc/mu";

if (typeof newRunId !== "function") throw new Error("@femtomc/mu-core missing newRunId");
if (typeof readJsonl !== "function") throw new Error("@femtomc/mu-core/node missing readJsonl");
if (typeof LocalStorageJsonlStore !== "function") throw new Error("@femtomc/mu-core/browser missing LocalStorageJsonlStore");
if (typeof ForumStore !== "function") throw new Error("@femtomc/mu-forum missing ForumStore");
if (typeof IssueStore !== "function") throw new Error("@femtomc/mu-issue missing IssueStore");
if (orchestratorHello() !== "orchestrator(forum,issue)") throw new Error("@femtomc/mu-orchestrator returned unexpected value");

const help = await run(["--help"]);
if (help.exitCode !== 0) throw new Error("@femtomc/mu run(--help) failed");
if (!help.stdout.includes("Usage:")) throw new Error("@femtomc/mu help missing Usage");

console.log("ok");
`;
		await writeFile(join(projDir, "smoke.mjs"), smokeMjs, "utf8");

		const smoke = await runCmd("node", ["smoke.mjs"], { cwd: projDir });
		if (smoke.code !== 0) {
			throw new Error(`node smoke.mjs failed (code=${smoke.code})\n${smoke.stderr || smoke.stdout}`);
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

