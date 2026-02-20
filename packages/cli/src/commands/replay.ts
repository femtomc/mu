import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ReplayCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type ReplayCommandCtx = {
	cwd: string;
	paths: {
		logsDir: string;
	};
};

export type ReplayCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => ReplayCommandRunResult;
	ok: (stdout?: string, exitCode?: number) => ReplayCommandRunResult;
	fileExists: (path: string) => Promise<boolean>;
};

export async function cmdReplay(
	argv: string[],
	ctx: ReplayCommandCtx,
	deps: ReplayCommandDeps,
): Promise<ReplayCommandRunResult> {
	const { hasHelpFlag, getFlagValue, jsonError, ok, fileExists } = deps;
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu replay - print a persisted run log",
				"",
				"Usage:",
				"  mu replay <issue-id|path> [--backend pi]",
				"",
				"Target resolution:",
				"  - explicit path (absolute/relative)",
				"  - <root-id>/<issue-id-or-log-file>",
				"  - unique issue-id prefix across <store>/logs/<root-id>/*.jsonl",
				"",
				"Examples:",
				"  mu replay mu-abc123",
				"  mu replay mu-root123/mu-worker456",
				"  mu replay ~/.mu/workspaces/<workspace-id>/logs/<root-id>/<issue-id>.jsonl",
				"",
				"See also: `mu resume`, `mu store paths`, `mu guide`",
			].join("\n") + "\n",
		);
	}

	const target = argv[0]!;
	const { value: backend, rest } = getFlagValue(argv.slice(1), "--backend");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu replay --help"] });
	}
	if (backend && backend !== "pi") {
		return jsonError(`unsupported backend: ${backend} (only pi is supported)`, {
			recovery: ["mu replay --backend pi <id>"],
		});
	}

	const logsDir = ctx.paths.logsDir;
	let path = resolve(ctx.cwd, target);
	if (!(await fileExists(path))) {
		const allMatches: { rootId: string; filename: string; fullPath: string }[] = [];

		try {
			const parts = target.split("/");
			if (parts.length === 2) {
				const [rootId, filename] = parts;
				const candidate = join(logsDir, rootId, filename.endsWith(".jsonl") ? filename : `${filename}.jsonl`);
				if (await fileExists(candidate)) {
					path = candidate;
				}
			}

			if (!path || !(await fileExists(path))) {
				const rootDirs = await readdir(logsDir);

				for (const rootId of rootDirs) {
					const rootPath = join(logsDir, rootId);
					const stat = await Bun.file(rootPath).stat();
					if (!stat.isDirectory()) continue;

					const files = await readdir(rootPath);
					if (files.includes(`${target}.jsonl`)) {
						allMatches.push({ rootId, filename: `${target}.jsonl`, fullPath: join(rootPath, `${target}.jsonl`) });
					}
					const prefixMatches = files.filter((f) => f.startsWith(target) && f.endsWith(".jsonl"));
					for (const match of prefixMatches) {
						allMatches.push({ rootId, filename: match, fullPath: join(rootPath, match) });
					}
				}
			}
		} catch {
			// Ignore errors reading directories
		}

		if (allMatches.length === 1) {
			path = allMatches[0]!.fullPath;
		} else if (allMatches.length > 1) {
			return jsonError(`ambiguous prefix '${target}'`, {
				recovery: allMatches
					.slice(0, 10)
					.map((m) => `mu replay ${m.rootId}/${m.filename.replace(/\\.jsonl$/, "")}`),
			});
		} else if (!path || !(await fileExists(path))) {
			return jsonError(`log not found: ${target}`, { recovery: ["mu status", "mu store paths"] });
		}
	}

	const text = await Bun.file(path).text();
	return ok(text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text);
}
