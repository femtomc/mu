export type ForumCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type ForumMessage = {
	topic: string;
	author: string;
	body: string;
	created_at: number;
};

type ForumTopicSummary = {
	topic: string;
	messages: number;
	last_at: number;
};

export type ForumCommandCtx = {
	forum: {
		post: (topic: string, body: string, author: string) => Promise<ForumMessage>;
		read: (topic: string, limit: number) => Promise<ForumMessage[]>;
		topics: (prefix?: string | null) => Promise<ForumTopicSummary[]>;
	};
};

export type ForumCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => ForumCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => ForumCommandRunResult;
	renderForumPostCompact: (msg: ForumMessage) => string;
	renderForumReadCompact: (topic: string, messages: readonly ForumMessage[]) => string;
	renderForumTopicsCompact: (topics: readonly ForumTopicSummary[]) => string;
};

export async function cmdForum<Ctx extends ForumCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: ForumCommandDeps,
): Promise<ForumCommandRunResult> {
	const {
		hasHelpFlag,
		popFlag,
		getFlagValue,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		renderForumPostCompact,
		renderForumReadCompact,
		renderForumTopicsCompact,
	} = deps;

	const { present: pretty, rest: argv0 } = popFlag(argv, "--pretty");

	if (argv0.length === 0 || argv0[0] === "--help" || argv0[0] === "-h") {
		return ok(
			[
				"mu forum - append-only coordination messages (JSON + compact output)",
				"",
				"Usage:",
				"  mu forum <command> [args...] [--pretty]",
				"",
				"Commands:",
				"  post     Add a message to a topic",
				"  read     Read recent messages in one topic",
				"  topics   List topics by recency",
				"",
				"Output mode:",
				"  compact-by-default output for forum post/read/topics; add --json for full records.",
				"",
				"Common topic patterns:",
				"  issue:<id>                 Per-issue execution log",
				"  user:context:<session>     User/session context",
				"  research:<project>:<topic> Research notes",
				"",
				"Daily operator usage:",
				'  mu forum post issue:<id> -m "claimed, starting implementation" --author operator',
				'  mu forum post issue:<id> -m "tests passing, closing" --author operator',
				"  mu forum read issue:<id> --limit 20",
				"",
				"Discover active issue threads:",
				"  mu forum topics --prefix issue: --limit 20",
			].join("\n") + "\n",
		);
	}

	const sub = argv0[0]!;
	const rest = argv0.slice(1);

	switch (sub) {
		case "post":
			return await forumPost(rest);
		case "read":
			return await forumRead(rest);
		case "topics":
			return await forumTopics(rest);
		default:
			return jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu forum --help"] });
	}

	async function forumPost(argv1: string[]): Promise<ForumCommandRunResult> {
		if (argv1.length === 0 || hasHelpFlag(argv1)) {
			return ok(
				[
					"mu forum post - post a message to a topic",
					"",
					"Usage:",
					"  mu forum post <topic> -m <message> [--author NAME] [--json] [--pretty]",
					"",
					"Options:",
					"  -m, --message <TEXT>   Required message body",
					"  --author <NAME>        Author label (default: operator)",
					"  --json                 Emit full JSON row (default is compact ack)",
					"",
					"Examples:",
					'  mu forum post issue:<id> -m "claimed and starting" --author operator',
					'  mu forum post issue:<id> -m "blocked on env setup" --author operator',
					'  mu forum post research:mu:help-audit -m "notes" --author operator --json --pretty',
				].join("\n") + "\n",
			);
		}

		const topic = argv1[0]!;
		const { value: message, rest: argv2 } = getFlagValue(argv1.slice(1), "--message");
		const { value: messageShort, rest: argv3 } = getFlagValue(argv2, "-m");
		const { value: author, rest: argv4 } = getFlagValue(argv3, "--author");
		const { present: jsonMode, rest: argv5 } = popFlag(argv4, "--json");
		const { present: compact, rest: argv6 } = popFlag(argv5, "--compact");

		const msgBody = message ?? messageShort;
		if (!msgBody) {
			return jsonError("missing message (-m/--message)", {
				pretty,
				recovery: [`mu forum post ${topic} -m "..." --author operator`],
			});
		}
		if (argv6.length > 0) {
			return jsonError(`unknown args: ${argv6.join(" ")}`, { pretty, recovery: ["mu forum post --help"] });
		}

		const msg = await ctx.forum.post(topic, msgBody, author ?? "operator");
		if (jsonMode && !compact) {
			return ok(jsonText(msg, pretty));
		}
		return ok(renderForumPostCompact(msg));
	}

	async function forumRead(argv1: string[]): Promise<ForumCommandRunResult> {
		if (argv1.length === 0 || hasHelpFlag(argv1)) {
			return ok(
				[
					"mu forum read - read messages from a topic (chronological)",
					"",
					"Usage:",
					"  mu forum read <topic> [--limit N] [--json] [--pretty]",
					"",
					"Options:",
					"  --limit <N>    Number of messages to return (default: 50)",
					"  --json         Emit full JSON rows (default is compact list)",
					"",
					"Examples:",
					"  mu forum read issue:<id>",
					"  mu forum read issue:<id> --limit 20",
					"  mu forum read issue:<id> --json --pretty",
				].join("\n") + "\n",
			);
		}

		const topic = argv1[0]!;
		const { value: limitRaw, rest: argv2 } = getFlagValue(argv1.slice(1), "--limit");
		const { present: jsonMode, rest: argv3 } = popFlag(argv2, "--json");
		const { present: compact, rest: argv4 } = popFlag(argv3, "--compact");
		if (argv4.length > 0) {
			return jsonError(`unknown args: ${argv4.join(" ")}`, { pretty, recovery: ["mu forum read --help"] });
		}

		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1 }) : 50;
		if (limit == null) {
			return jsonError("limit must be >= 1", { pretty, recovery: [`mu forum read ${topic} --limit 20`] });
		}

		const msgs = await ctx.forum.read(topic, limit);
		if (!jsonMode || compact) {
			return ok(renderForumReadCompact(topic, msgs));
		}
		return ok(jsonText(msgs, pretty));
	}

	async function forumTopics(argv1: string[]): Promise<ForumCommandRunResult> {
		if (hasHelpFlag(argv1)) {
			return ok(
				[
					"mu forum topics - list active topics sorted by most recent message",
					"",
					"Usage:",
					"  mu forum topics [--prefix PREFIX] [--limit N] [--json] [--pretty]",
					"",
					"Options:",
					"  --prefix <PREFIX>   Restrict topics by prefix (e.g. issue:, research:)",
					"  --limit <N>         Max topics returned (default: 100)",
					"  --json              Emit full JSON rows (default is compact table)",
					"",
					"Examples:",
					"  mu forum topics",
					"  mu forum topics --prefix issue:",
					"  mu forum topics --prefix issue: --limit 20 --json --pretty",
				].join("\n") + "\n",
			);
		}

		const { value: prefix, rest: argv2 } = getFlagValue(argv1, "--prefix");
		const { value: limitRaw, rest: argv3 } = getFlagValue(argv2, "--limit");
		const { present: jsonMode, rest: argv4 } = popFlag(argv3, "--json");
		const { present: compact, rest: argv5 } = popFlag(argv4, "--compact");
		if (argv5.length > 0) {
			return jsonError(`unknown args: ${argv5.join(" ")}`, { pretty, recovery: ["mu forum topics --help"] });
		}

		const limit = limitRaw ? ensureInt(limitRaw, { name: "--limit", min: 1 }) : 100;
		if (limit == null) {
			return jsonError("limit must be >= 1", { pretty, recovery: ["mu forum topics --limit 20"] });
		}

		let topics = await ctx.forum.topics(prefix ?? null);
		if (limit > 0) {
			topics = topics.slice(0, limit);
		}
		if (!jsonMode || compact) {
			return ok(renderForumTopicsCompact(topics));
		}
		return ok(jsonText(topics, pretty));
	}
}
