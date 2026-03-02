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
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => ReplayCommandRunResult;
	ok: (stdout?: string, exitCode?: number) => ReplayCommandRunResult;
	fileExists: (path: string) => Promise<boolean>;
};

function truncateInline(value: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= width) {
		return normalized;
	}
	if (width === 1) {
		return "…";
	}
	return `${normalized.slice(0, width - 1)}…`;
}

function renderReplayPreview(opts: {
	target: string;
	resolvedPath: string;
	total: number;
	startLine: number;
	lines: string[];
}): string {
	const rows = [
		`Replay ${opts.target}: ${opts.lines.length} shown (total=${opts.total})`,
		`Path: ${opts.resolvedPath}`,
		`${"LINE".padStart(6)} PREVIEW`,
	];
	if (opts.lines.length === 0) {
		rows.push("(no rows)");
		return `${rows.join("\n")}\n`;
	}
	for (let idx = 0; idx < opts.lines.length; idx += 1) {
		const lineNo = String(opts.startLine + idx).padStart(6);
		rows.push(`${lineNo} ${truncateInline(opts.lines[idx] ?? "", 220)}`);
	}
	return `${rows.join("\n")}\n`;
}

export async function cmdReplay(
	argv: string[],
	ctx: ReplayCommandCtx,
	deps: ReplayCommandDeps,
): Promise<ReplayCommandRunResult> {
	const { hasHelpFlag, popFlag, getFlagValue, ensureInt, jsonError, ok, fileExists } = deps;
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu replay - inspect a persisted run log with bounded output by default",
				"",
				"Usage:",
				"  mu replay <issue-id|path> [--backend pi] [--limit N] [--raw]",
				"  mu replay <issue-id|path> --all --raw [--backend pi]",
				"",
				"Target resolution:",
				"  - explicit path (absolute/relative)",
				"  - <root-id>/<issue-id-or-log-file>",
				"  - unique issue-id prefix across <store>/logs/<root-id>/*.jsonl",
				"",
				"Output modes:",
				"  default: compact tail preview (truncated lines, default --limit 80)",
				"  --raw: exact tail lines",
				"  --all --raw: full file dump (explicit, potentially huge)",
				"",
				"Examples:",
				"  mu replay mu-abc123",
				"  mu replay mu-root123/mu-issue456 --limit 120",
				"  mu replay ~/.mu/workspaces/<workspace-id>/logs/<root-id>/<issue-id>.jsonl --raw",
				"",
				"See also: `mu store paths`, `mu guide`",
			].join("\n") + "\n",
		);
	}

	const target = argv[0]!;
	const { value: backend, rest: argv0 } = getFlagValue(argv.slice(1), "--backend");
	const { value: limitRaw, rest: argv1 } = getFlagValue(argv0, "--limit");
	const { present: allRows, rest: argv2 } = popFlag(argv1, "--all");
	const { present: rawMode, rest } = popFlag(argv2, "--raw");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu replay --help"] });
	}
	if (backend && backend !== "pi") {
		return jsonError(`unsupported backend: ${backend} (only pi is supported)`, {
			recovery: ["mu replay --backend pi <id>"],
		});
	}
	if (allRows && limitRaw != null) {
		return jsonError("cannot combine --all with --limit", {
			recovery: ["mu replay <id> --all --raw", "mu replay <id> --limit 80"],
		});
	}
	if (allRows && !rawMode) {
		return jsonError("--all requires --raw to prevent accidental massive output", {
			recovery: ["mu replay <id> --all --raw", "mu replay <id> --limit 80"],
		});
	}

	const limit = allRows ? null : limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 80;
	if (!allRows && limit == null) {
		return jsonError("--limit must be an integer between 1 and 500", {
			recovery: ["mu replay <id> --limit 80"],
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
					const st = await Bun.file(rootPath).stat();
					if (!st.isDirectory()) continue;

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
	if (allRows) {
		return ok(text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text);
	}

	const lines = text.split(/\r?\n/);
	const normalized = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
	const tailLines = normalized.slice(-(limit ?? 80));
	if (rawMode) {
		const raw = tailLines.join("\n");
		return ok(raw.length > 0 ? `${raw}\n` : "");
	}

	const startLine = normalized.length - tailLines.length + 1;
	let out = renderReplayPreview({
		target,
		resolvedPath: path,
		total: normalized.length,
		startLine,
		lines: tailLines,
	});
	out += "Use --raw for exact lines or --all --raw for the full file.\n";
	return ok(out);
}
