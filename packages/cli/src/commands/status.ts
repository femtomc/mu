import chalk from "chalk";

export type StatusCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type StatusCommandCtx = {
	repoRoot: string;
	store: {
		list: (opts?: Record<string, unknown>) => Promise<any[]>;
		ready: (rootId: string | null, opts?: Record<string, unknown>) => Promise<any[]>;
	};
	forum: {
		topics: (prefix?: string | null) => Promise<Array<{ topic: string; messages: number; last_at: number }>>;
	};
};

export type StatusCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	jsonError: (msg: string, opts?: { pretty?: boolean; recovery?: readonly string[] }) => StatusCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => StatusCommandRunResult;
};

function issueJson(issue: any): Record<string, unknown> {
	return {
		id: issue?.id,
		title: issue?.title,
		body: issue?.body ?? "",
		status: issue?.status,
		outcome: issue?.outcome ?? null,
		tags: issue?.tags ?? [],
		deps: issue?.deps ?? [],
		priority: issue?.priority ?? 3,
		created_at: issue?.created_at ?? 0,
		updated_at: issue?.updated_at ?? 0,
	};
}

export async function cmdStatus(
	argv: string[],
	ctx: StatusCommandCtx,
	deps: StatusCommandDeps,
): Promise<StatusCommandRunResult> {
	const { hasHelpFlag, popFlag, jsonError, jsonText, ok } = deps;
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu status - show repo + DAG status",
				"",
				"Usage:",
				"  mu status [--json] [--pretty] [--verbose|--debug]",
				"",
				"Options:",
				"  --json      Emit machine-readable status payload",
				"  --pretty    Pretty-print JSON output (when combined with --json)",
				"  --verbose   Expand text output with full ready/topic sections",
				"  --debug     Alias of --verbose",
				"",
				"Includes:",
				"  repo root, root issue count, open issue count, ready issue sample, recent issue topics",
				"",
				"Examples:",
				"  mu status",
				"  mu status --json --pretty",
				"  mu issues ready --root <root-id>",
				"",
				"If counts look wrong, run `mu issues list --limit 20` and `mu forum topics --prefix issue:`.",
			].join("\n") + "\n",
		);
	}

	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");
	const { present: jsonMode, rest: argv1 } = popFlag(argv0, "--json");
	const { present: verbose, rest: argv2 } = popFlag(argv1, "--verbose");
	const { present: debug, rest } = popFlag(argv2, "--debug");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu status --help"] });
	}

	const roots = (await ctx.store.list({ tag: "node:root" })).map(issueJson);
	const openIssues = await ctx.store.list({ status: "open" });
	const ready = await ctx.store.ready(null, { tags: ["node:agent"] });
	const topics = await ctx.forum.topics("issue:");

	const payload = {
		repo_root: ctx.repoRoot,
		roots,
		open_count: openIssues.length,
		ready_count: ready.length,
		ready: ready.slice(0, 10).map(issueJson),
		recent_topics: topics.slice(0, 10),
	};

	if (jsonMode) {
		return ok(jsonText(payload, pretty));
	}

	const label = (s: string) => chalk.bold(s);
	const val = (s: string | number) => chalk.cyan(String(s));
	const dim = (s: string) => chalk.dim(s);
	const showDetails = verbose || debug;

	let out = `${label("Repo:")} ${val(ctx.repoRoot)}\n`;
	out += `${label("Root issues:")} ${val(roots.length)}  ${label("Open:")} ${val(openIssues.length)}  ${label("Ready:")} ${val(ready.length)}\n`;

	if (showDetails) {
		if (ready.length > 0) {
			out += `\n${label("Ready:")}\n`;
			for (const issue of ready.slice(0, 10)) {
				out += `  ${chalk.yellow(issue.id)} ${dim(`[p=${issue.priority ?? 3}]`)} ${String(issue.title ?? "").slice(0, 80)}\n`;
			}
		}

		if (topics.length > 0) {
			out += `\n${label("Recent issue topics:")}\n`;
			for (const topic of topics.slice(0, 10)) {
				out += `  ${chalk.yellow(topic.topic)} ${dim(`(${topic.messages})`)} ${dim(`last_at=${topic.last_at}`)}\n`;
			}
		}
		return ok(out);
	}

	const readySample = ready
		.slice(0, 3)
		.map((issue) => `${issue.id}[p=${issue.priority ?? 3}]`)
		.join(", ");
	if (readySample.length > 0) {
		out += `${label("Ready sample:")} ${readySample}\n`;
	}

	const topicSample = topics
		.slice(0, 3)
		.map((topic) => `${topic.topic}(${topic.messages})`)
		.join(", ");
	if (topicSample.length > 0) {
		out += `${label("Topic sample:")} ${topicSample}\n`;
	}

	if (ready.length > 3 || topics.length > 3) {
		out += `${dim("Use `mu status --verbose` for expanded ready/topic detail.")}\n`;
	}

	return ok(out);
}
