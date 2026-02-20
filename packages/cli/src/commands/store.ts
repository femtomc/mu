import { join, relative, resolve } from "node:path";

export type StoreCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type StoreCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => StoreCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => StoreCommandRunResult;
	fileExists: (path: string) => Promise<boolean>;
};

export type StoreCommandCtx = {
	cwd: string;
	repoRoot: string;
	paths: {
		storeDir: string;
		issuesPath: string;
		forumPath: string;
		eventsPath: string;
		logsDir: string;
	};
};

function buildStoreHandlers<Ctx extends StoreCommandCtx>(deps: StoreCommandDeps): {
	cmdStore: (argv: string[], ctx: Ctx) => Promise<StoreCommandRunResult>;
} {
	const { hasHelpFlag, popFlag, getFlagValue, ensureInt, jsonError, jsonText, ok, fileExists } = deps;

	type StoreTargetInfo = {
		key: string;
		path: string;
		description: string;
	};

	async function listStoreTargets(ctx: Ctx): Promise<StoreTargetInfo[]> {
		const { getControlPlanePaths } = await import("@femtomc/mu-control-plane");
		const cp = getControlPlanePaths(ctx.repoRoot);
		return [
			{ key: "store", path: ctx.paths.storeDir, description: "Store root directory" },
			{ key: "issues", path: ctx.paths.issuesPath, description: "Issue DAG nodes (JSONL)" },
			{ key: "forum", path: ctx.paths.forumPath, description: "Forum messages (JSONL)" },
			{ key: "events", path: ctx.paths.eventsPath, description: "Event log (JSONL)" },
			{ key: "logs", path: ctx.paths.logsDir, description: "Run logs directory" },
			{ key: "config", path: join(ctx.paths.storeDir, "config.json"), description: "CLI/server config" },
			{ key: "heartbeats", path: join(ctx.paths.storeDir, "heartbeats.jsonl"), description: "Heartbeat programs" },
			{ key: "cp", path: cp.controlPlaneDir, description: "Control-plane state directory" },
			{ key: "cp_identities", path: cp.identitiesPath, description: "Linked identities" },
			{ key: "cp_commands", path: cp.commandsPath, description: "Command lifecycle journal" },
			{ key: "cp_outbox", path: cp.outboxPath, description: "Outbound delivery queue" },
			{ key: "cp_policy", path: cp.policyPath, description: "Control-plane policy" },
			{ key: "cp_adapter_audit", path: cp.adapterAuditPath, description: "Adapter ingress audit" },
			{
				key: "cp_operator_turns",
				path: join(cp.controlPlaneDir, "operator_turns.jsonl"),
				description: "Operator turn audit",
			},
			{
				key: "cp_operator_conversations",
				path: join(cp.controlPlaneDir, "operator_conversations.json"),
				description: "Operator conversation/session bindings",
			},
			{
				key: "cp_operator_sessions",
				path: join(cp.controlPlaneDir, "operator-sessions"),
				description: "Messaging operator session transcripts",
			},
			{
				key: "operator_sessions",
				path: join(ctx.paths.storeDir, "operator", "sessions"),
				description: "Terminal operator session transcripts",
			},
			{
				key: "cp_telegram_ingress",
				path: join(cp.controlPlaneDir, "telegram_ingress.jsonl"),
				description: "Deferred Telegram ingress queue",
			},
		];
	}

	async function inspectPath(path: string): Promise<{
		exists: boolean;
		type: "file" | "directory" | "other" | "missing";
		size_bytes: number | null;
	}> {
		const file = Bun.file(path);
		const exists = await file.exists();
		if (!exists) {
			return { exists: false, type: "missing", size_bytes: null };
		}
		try {
			const st = await file.stat();
			if (st.isDirectory()) {
				return { exists: true, type: "directory", size_bytes: st.size };
			}
			if (st.isFile()) {
				return { exists: true, type: "file", size_bytes: st.size };
			}
			return { exists: true, type: "other", size_bytes: st.size };
		} catch {
			return { exists: true, type: "other", size_bytes: null };
		}
	}

	async function cmdStore(argv: string[], ctx: Ctx): Promise<StoreCommandRunResult> {
		const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
		if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
			return ok(
				[
					"mu store - inspect workspace store files and logs",
					"",
					"Usage:",
					"  mu store <command> [args...] [--pretty]",
					"",
					"Commands:",
					"  paths                         Show canonical workspace-store paths and existence",
					"  ls                            Summarize known workspace-store files",
					"  tail <target> [--limit N]     Show recent entries from a workspace-store file",
					"",
					"Examples:",
					"  mu store paths",
					"  mu store ls --pretty",
					"  mu store tail events --limit 20",
					"  mu store tail cp_operator_turns --limit 30 --json --pretty",
					"",
					"Targets (for tail): issues, forum, events, cp_commands, cp_outbox, cp_identities,",
					"cp_operator_turns, cp_operator_conversations, cp_telegram_ingress, or explicit paths under the store dir",
				].join("\n") + "\n",
			);
		}

		const sub = argv0[0]!;
		const rest = argv0.slice(1);
		switch (sub) {
			case "paths":
				return await storePaths(rest, ctx, pretty);
			case "ls":
				return await storeLs(rest, ctx, pretty);
			case "tail":
				return await storeTail(rest, ctx, pretty);
			default:
				return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu store --help"] });
		}
	}

	async function storePaths(argv: string[], ctx: Ctx, pretty: boolean): Promise<StoreCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu store paths - list canonical workspace-store paths",
					"",
					"Usage:",
					"  mu store paths [--json] [--pretty]",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest } = popFlag(argv, "--json");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu store paths --help"] });
		}

		const targets = await listStoreTargets(ctx);
		const rows = [] as Array<Record<string, unknown>>;
		for (const t of targets) {
			const stat = await inspectPath(t.path);
			rows.push({
				key: t.key,
				path: t.path,
				rel_path: relative(ctx.paths.storeDir, t.path).replaceAll("\\", "/"),
				description: t.description,
				exists: stat.exists,
				type: stat.type,
				size_bytes: stat.size_bytes,
			});
		}

		const payload = {
			repo_root: ctx.repoRoot,
			store_dir: ctx.paths.storeDir,
			targets: rows,
		};
		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}

		let out = `Workspace store paths for ${ctx.repoRoot}\n`;
		for (const row of rows) {
			const key = String(row.key).padEnd(20);
			const status = row.exists ? String(row.type) : "missing";
			const relPath = String(row.rel_path);
			out += `  ${key} ${status.padEnd(10)} ${relPath}\n`;
		}
		return ok(out);
	}

	async function storeLs(argv: string[], ctx: Ctx, pretty: boolean): Promise<StoreCommandRunResult> {
		if (hasHelpFlag(argv)) {
			return ok(
				[
					"mu store ls - summarize known workspace-store files",
					"",
					"Usage:",
					"  mu store ls [--all] [--json] [--pretty]",
					"",
					"By default only existing paths are shown. Use --all to include missing.",
				].join("\n") + "\n",
			);
		}

		const { present: jsonMode, rest: argv0 } = popFlag(argv, "--json");
		const { present: includeAll, rest } = popFlag(argv0, "--all");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu store ls --help"] });
		}

		const { readJsonl } = await import("@femtomc/mu-core/node");
		const targets = await listStoreTargets(ctx);
		const rows: Array<Record<string, unknown>> = [];
		for (const t of targets) {
			const stat = await inspectPath(t.path);
			if (!includeAll && !stat.exists) {
				continue;
			}
			let entries: number | null = null;
			if (stat.exists && stat.type === "file" && t.path.endsWith(".jsonl")) {
				try {
					entries = (await readJsonl(t.path)).length;
				} catch {
					entries = null;
				}
			}
			rows.push({
				key: t.key,
				rel_path: relative(ctx.paths.storeDir, t.path).replaceAll("\\", "/"),
				exists: stat.exists,
				type: stat.type,
				size_bytes: stat.size_bytes,
				entries,
				description: t.description,
			});
		}

		const payload = {
			repo_root: ctx.repoRoot,
			count: rows.length,
			files: rows,
		};
		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}

		let out = `Workspace store summary (${rows.length} item${rows.length === 1 ? "" : "s"})\n`;
		for (const row of rows) {
			const key = String(row.key).padEnd(20);
			const kind = String(row.type).padEnd(10);
			const size = row.size_bytes == null ? "-" : `${row.size_bytes}b`;
			const entries = row.entries == null ? "" : ` entries=${row.entries}`;
			out += `  ${key} ${kind} ${String(row.rel_path)} size=${size}${entries}\n`;
		}
		return ok(out);
	}

	async function storeTail(argv: string[], ctx: Ctx, pretty: boolean): Promise<StoreCommandRunResult> {
		if (argv.length === 0 || hasHelpFlag(argv)) {
			return ok(
				[
					"mu store tail - show recent entries from a workspace-store file",
					"",
					"Usage:",
					"  mu store tail <target> [--limit N] [--json] [--pretty]",
					"",
					"Examples:",
					"  mu store tail events --limit 20",
					"  mu store tail cp_commands --limit 50 --json --pretty",
				].join("\n") + "\n",
			);
		}

		const targetRaw = argv[0]!;
		const { value: limitRaw, rest: argv0 } = getFlagValue(argv.slice(1), "--limit");
		const { present: jsonMode, rest } = popFlag(argv0, "--json");
		if (rest.length > 0) {
			return jsonError(`unknown args: ${rest.join(" ")}`, { pretty, recovery: ["mu store tail --help"] });
		}

		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1, max: 2000 }) : 20;
		if (limit == null) {
			return jsonError("limit must be an integer between 1 and 2000", {
				pretty,
				recovery: ["mu store tail events --limit 20"],
			});
		}

		const targets = await listStoreTargets(ctx);
		const byKey = new Map(targets.map((t) => [t.key, t.path] as const));
		const targetPath = byKey.get(targetRaw) ?? resolve(ctx.cwd, targetRaw);
		const storeDirAbs = resolve(ctx.paths.storeDir);
		const targetAbs = resolve(targetPath);
		if (targetAbs !== storeDirAbs && !targetAbs.startsWith(`${storeDirAbs}/`)) {
			return jsonError(`target must be inside the workspace store: ${targetRaw}`, {
				pretty,
				recovery: ["mu store paths", "mu store tail events --limit 20"],
			});
		}

		if (!(await fileExists(targetAbs))) {
			return jsonError(`target not found: ${targetRaw}`, { pretty, recovery: ["mu store ls --all --pretty"] });
		}

		const stat = await inspectPath(targetAbs);
		if (stat.type === "directory") {
			return jsonError(`target is a directory: ${targetRaw}`, {
				pretty,
				recovery: ["mu store ls --pretty", "mu store tail events --limit 20"],
			});
		}

		if (targetAbs.endsWith(".jsonl")) {
			const { readJsonl } = await import("@femtomc/mu-core/node");
			const rows = await readJsonl(targetAbs);
			const tailRows = rows.slice(-limit);
			const payload = {
				target: targetRaw,
				path: targetAbs,
				total: rows.length,
				returned: tailRows.length,
				entries: tailRows,
			};
			if (jsonMode) {
				return ok(jsonText(payload, pretty));
			}
			const rendered = tailRows.map((row) => JSON.stringify(row)).join("\n");
			return ok(rendered.length > 0 ? `${rendered}\n` : "");
		}

		const text = await Bun.file(targetAbs).text();
		const lines = text.split(/\r?\n/);
		const normalized = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
		const tailLines = normalized.slice(-limit);
		const payload = {
			target: targetRaw,
			path: targetAbs,
			total: normalized.length,
			returned: tailLines.length,
			lines: tailLines,
		};
		if (jsonMode) {
			return ok(jsonText(payload, pretty));
		}
		return ok(tailLines.length > 0 ? `${tailLines.join("\n")}\n` : "");
	}


	return { cmdStore };
}

export async function cmdStore<Ctx extends StoreCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: StoreCommandDeps,
): Promise<StoreCommandRunResult> {
	return await buildStoreHandlers<Ctx>(deps).cmdStore(argv, ctx);
}
