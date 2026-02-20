import {
	CONTEXT_SOURCE_KINDS,
	ContextQueryValidationError,
	runContextIndexRebuild,
	runContextIndexStatus,
	runContextSearch,
	runContextStats,
	runContextTimeline,
} from "../context_runtime.js";

export type MemoryCommandCtx = {
	repoRoot: string;
};

export type MemoryCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type MemoryCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	setSearchParamIfPresent: (search: URLSearchParams, key: string, value: string | null | undefined) => void;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => MemoryCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => MemoryCommandRunResult;
	describeError: (err: unknown) => string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry != null);
}

function recordString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function recordInt(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return Math.trunc(value);
}

function recordBool(record: Record<string, unknown>, key: string): boolean | null {
	const value = record[key];
	if (typeof value !== "boolean") {
		return null;
	}
	return value;
}

function compactId(value: string, width: number = 10): string {
	const normalized = value.trim();
	if (normalized.length <= width) {
		return normalized;
	}
	return normalized.slice(0, width);
}

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

function normalizeEpochMs(ts: number): number | null {
	if (!Number.isFinite(ts) || ts <= 0) {
		return null;
	}
	const normalized = Math.trunc(ts);
	if (normalized < 10_000_000_000) {
		return normalized * 1000;
	}
	return normalized;
}

function formatTsIsoMinute(ts: number): string {
	const tsMs = normalizeEpochMs(ts);
	if (tsMs == null) {
		return "-";
	}
	try {
		return new Date(tsMs).toISOString().slice(0, 16).replace("T", " ");
	} catch {
		return "-";
	}
}

function formatAgeShort(ts: number, nowMs: number = Date.now()): string {
	const tsMs = normalizeEpochMs(ts);
	if (tsMs == null) {
		return "-";
	}
	const diffMs = Math.max(0, nowMs - tsMs);

	if (diffMs < 60_000) {
		return `${Math.max(1, Math.floor(diffMs / 1000))}s`;
	}
	if (diffMs < 3_600_000) {
		return `${Math.floor(diffMs / 60_000)}m`;
	}
	if (diffMs < 86_400_000) {
		return `${Math.floor(diffMs / 3_600_000)}h`;
	}
	if (diffMs < 7 * 86_400_000) {
		return `${Math.floor(diffMs / 86_400_000)}d`;
	}
	if (diffMs < 30 * 86_400_000) {
		return `${Math.floor(diffMs / (7 * 86_400_000))}w`;
	}
	return `${Math.floor(diffMs / (30 * 86_400_000))}mo`;
}

function renderContextItemsCompact(items: Array<Record<string, unknown>>, title: string): string {
	const lines = [title, `${"TS (UTC)".padEnd(16)} ${"SRC".padEnd(16)} ${"ISSUE".padEnd(10)} ${"RUN".padEnd(10)} PREVIEW`];
	if (items.length === 0) {
		lines.push("(no context rows)");
		return `${lines.join("\n")}\n`;
	}
	for (const item of items) {
		const ts = recordInt(item, "ts_ms") ?? 0;
		const source = recordString(item, "source_kind") ?? "-";
		const issue = recordString(item, "issue_id") ?? "-";
		const run = recordString(item, "run_id") ?? "-";
		const preview = recordString(item, "preview") ?? recordString(item, "text") ?? "";
		lines.push(
			`${formatTsIsoMinute(ts).padEnd(16)} ${truncateInline(source, 16).padEnd(16)} ${compactId(issue, 10).padEnd(10)} ${compactId(run, 10).padEnd(10)} ${truncateInline(preview, 84)}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function renderContextPayloadCompact(payload: Record<string, unknown>): string {
	const mode = recordString(payload, "mode") ?? "context";
	if (mode === "search" || mode === "timeline") {
		const items = asRecordArray(payload.items);
		const count = recordInt(payload, "count") ?? items.length;
		const total = recordInt(payload, "total") ?? count;
		const q = recordString(payload, "query");
		const title = `${mode}: ${count} shown (total=${total})${q ? ` query=${JSON.stringify(truncateInline(q, 40))}` : ""}`;
		return renderContextItemsCompact(items, title);
	}
	if (mode === "stats" || mode === "index_status" || mode === "index_rebuild") {
		const sources = asRecordArray(payload.sources);
		const heading =
			mode === "stats"
				? `memory stats: total_count=${recordInt(payload, "total_count") ?? 0} total_text_bytes=${recordInt(payload, "total_text_bytes") ?? 0}`
				: `memory index: ${recordBool(payload, "exists") ? "ready" : "missing"} total_count=${recordInt(payload, "total_count") ?? 0} stale_sources=${recordInt(payload, "stale_source_count") ?? 0}`;
		const lines = [heading];
		if (mode !== "stats") {
			const indexPath = recordString(payload, "index_path") ?? "-";
			const builtAt = recordInt(payload, "built_at_ms") ?? 0;
			lines.push(`index_path=${truncateInline(indexPath, 120)}`);
			lines.push(`built=${builtAt > 0 ? `${formatTsIsoMinute(builtAt)} (${formatAgeShort(builtAt)})` : "never"}`);
			if (mode === "index_rebuild") {
				lines.push(
					`rebuild: indexed_count=${recordInt(payload, "indexed_count") ?? 0} duration_ms=${recordInt(payload, "duration_ms") ?? 0}`,
				);
			}
		}
		lines.push(`${"SOURCE".padEnd(22)} ${"COUNT".padStart(6)} ${"BYTES".padStart(10)} LAST`);
		if (sources.length === 0) {
			lines.push("(no source stats)");
			return `${lines.join("\n")}\n`;
		}
		for (const source of sources) {
			const kind = recordString(source, "source_kind") ?? "-";
			const count = recordInt(source, "count") ?? 0;
			const bytes = recordInt(source, "text_bytes") ?? 0;
			const last = recordInt(source, "last_ts_ms") ?? 0;
			lines.push(`${truncateInline(kind, 22).padEnd(22)} ${String(count).padStart(6)} ${String(bytes).padStart(10)} ${formatTsIsoMinute(last)} (${formatAgeShort(last)})`);
		}
		return `${lines.join("\n")}\n`;
	}
	return `${truncateInline(JSON.stringify(payload), 240)}\n`;
}

function memoryHelpText(): string {
	const sourceKinds = CONTEXT_SOURCE_KINDS.join(", ");
	return (
		[
			"mu memory - cross-store memory retrieval + index management",
			"",
			"Usage:",
			"  mu memory search [filters...] [--json] [--pretty]",
			"  mu memory timeline [filters...] [--order asc|desc] [--json] [--pretty]",
			"  mu memory stats [filters...] [--json] [--pretty]",
			"  mu memory index <status|rebuild> [opts] [--json] [--pretty]",
			"",
			"Common filters:",
			"  --query/-q <text>                    Full-text query",
			`  --source <kind> | --sources <csv>    Source filter (${sourceKinds})`,
			"  --issue-id <id> --run-id <id>        Execution anchors",
			"  --session-id <id>                     Operator/session anchor",
			"  --conversation-key <key>              Conversation scope anchor",
			"  --channel <name> --topic <topic>      Channel/forum anchors",
			"  --author <name> --role <role>         Message-role filters",
			"  --since <epoch-ms> --until <epoch-ms> Time window",
			"  --limit <N>                           Result size (1..500, default 20)",
			"",
			"Timeline note:",
			"  mu memory timeline requires at least one anchor:",
			"  --conversation-key | --issue-id | --run-id | --session-id | --topic | --channel",
			"",
			"Output mode:",
			"  compact-by-default memory summaries; add --json for full result payloads.",
			"",
			"Maintenance:",
			"  memory search/timeline/stats auto-heal missing indexes on demand.",
			"  when mu serve is running, server-side scheduled maintenance repairs stale indexes.",
			"",
			"Examples:",
			"  mu memory search --query reload --limit 20",
			"  mu memory timeline --issue-id mu-abc123 --order desc --limit 40",
			"  mu memory stats --source events --json --pretty",
			"  mu memory index status",
			"  mu memory index rebuild --sources issues,forum,events",
			"",
			"Compatibility:",
			"  `mu context ...` remains available as an alias to `mu memory ...`.",
		].join("\n") + "\n"
	);
}

async function cmdMemoryIndex(
	argv: string[],
	ctx: MemoryCommandCtx,
	pretty: boolean,
	deps: MemoryCommandDeps,
): Promise<MemoryCommandRunResult> {
	if (argv.length === 0 || deps.hasHelpFlag(argv)) {
		const sourceKinds = CONTEXT_SOURCE_KINDS.join(", ");
		return deps.ok(
			[
				"mu memory index - manage local memory index",
				"",
				"Usage:",
				"  mu memory index status [--json] [--pretty]",
				"  mu memory index rebuild [--source <kind> | --sources <csv>] [--json] [--pretty]",
				"",
				"Rebuild filters:",
				`  --source <kind>   Single source kind (${sourceKinds})`,
				"  --sources <csv>   Comma-separated source kinds",
				"",
				"Notes:",
				"  search/timeline/stats are index-first when this index exists,",
				"  with automatic fallback to direct JSONL scans when index data is unavailable.",
				"",
				"Examples:",
				"  mu memory index status",
				"  mu memory index rebuild",
				"  mu memory index rebuild --sources issues,forum,events",
			].join("\n") + "\n",
		);
	}
	const sub = argv[0]!;
	const rest0 = argv.slice(1);
	if (sub !== "status" && sub !== "rebuild") {
		return deps.jsonError(`unknown subcommand: ${sub}`, {
			pretty,
			recovery: ["mu memory index --help"],
		});
	}
	const { value: sources, rest: argv1 } = deps.getFlagValue(rest0, "--sources");
	const { value: source, rest: argv2 } = deps.getFlagValue(argv1, "--source");
	const { present: jsonMode, rest: argv3 } = deps.popFlag(argv2, "--json");
	const { present: compact, rest: unknown } = deps.popFlag(argv3, "--compact");
	if (unknown.length > 0) {
		return deps.jsonError(`unknown args: ${unknown.join(" ")}`, {
			pretty,
			recovery: ["mu memory index --help"],
		});
	}
	if (sub === "status" && (sources || source)) {
		return deps.jsonError("--source/--sources are only supported for `mu memory index rebuild`", {
			pretty,
			recovery: ["mu memory index status", "mu memory index rebuild --sources events,forum"],
		});
	}
	const search = new URLSearchParams();
	deps.setSearchParamIfPresent(search, "sources", sources ?? null);
	deps.setSearchParamIfPresent(search, "source", source ?? null);
	try {
		if (sub === "status") {
			const result = await runContextIndexStatus({ repoRoot: ctx.repoRoot });
			if (!jsonMode || compact) {
				return deps.ok(renderContextPayloadCompact(result as unknown as Record<string, unknown>));
			}
			return deps.ok(deps.jsonText(result, pretty));
		}
		const result = await runContextIndexRebuild({ repoRoot: ctx.repoRoot, search });
		if (!jsonMode || compact) {
			return deps.ok(renderContextPayloadCompact(result as unknown as Record<string, unknown>));
		}
		return deps.ok(deps.jsonText(result, pretty));
	} catch (err) {
		if (err instanceof ContextQueryValidationError) {
			return deps.jsonError(err.message, {
				pretty,
				recovery: ["mu memory index rebuild --sources issues,forum,events"],
			});
		}
		return deps.jsonError(`memory index ${sub} failed: ${deps.describeError(err)}`, {
			pretty,
			recovery: ["mu memory index --help"],
		});
	}
}

export async function cmdMemory(
	argv: string[],
	ctx: MemoryCommandCtx,
	deps: MemoryCommandDeps,
): Promise<MemoryCommandRunResult> {
	const { present: pretty, rest: argv0 } = deps.popFlag(argv, "--pretty");
	if (argv0.length === 0) {
		return deps.ok(memoryHelpText());
	}
	const sub = argv0[0]!;
	const rest = argv0.slice(1);
	if (sub === "index") {
		return await cmdMemoryIndex(rest, ctx, pretty, deps);
	}
	if (deps.hasHelpFlag(argv0)) {
		return deps.ok(memoryHelpText());
	}
	if (sub !== "search" && sub !== "timeline" && sub !== "stats") {
		return deps.jsonError(`unknown subcommand: ${sub}`, { pretty, recovery: ["mu memory --help"] });
	}

	const { value: query, rest: argv1 } = deps.getFlagValue(rest, "--query");
	const { value: queryAlias, rest: argv2 } = deps.getFlagValue(argv1, "-q");
	const { value: sources, rest: argv3 } = deps.getFlagValue(argv2, "--sources");
	const { value: source, rest: argv4 } = deps.getFlagValue(argv3, "--source");
	const { value: issueId, rest: argv5 } = deps.getFlagValue(argv4, "--issue-id");
	const { value: runId, rest: argv6 } = deps.getFlagValue(argv5, "--run-id");
	const { value: sessionId, rest: argv7 } = deps.getFlagValue(argv6, "--session-id");
	const { value: conversationKey, rest: argv8 } = deps.getFlagValue(argv7, "--conversation-key");
	const { value: channel, rest: argv9 } = deps.getFlagValue(argv8, "--channel");
	const { value: channelTenantId, rest: argv10 } = deps.getFlagValue(argv9, "--channel-tenant-id");
	const { value: channelConversationId, rest: argv11 } = deps.getFlagValue(argv10, "--channel-conversation-id");
	const { value: actorBindingId, rest: argv12 } = deps.getFlagValue(argv11, "--actor-binding-id");
	const { value: topic, rest: argv13 } = deps.getFlagValue(argv12, "--topic");
	const { value: author, rest: argv14 } = deps.getFlagValue(argv13, "--author");
	const { value: role, rest: argv15 } = deps.getFlagValue(argv14, "--role");
	const { value: sinceRaw, rest: argv16 } = deps.getFlagValue(argv15, "--since");
	const { value: untilRaw, rest: argv17 } = deps.getFlagValue(argv16, "--until");
	const { value: order, rest: argv18 } = deps.getFlagValue(argv17, "--order");
	const { value: limitRaw, rest: argv19 } = deps.getFlagValue(argv18, "--limit");
	const { present: jsonMode, rest: argv20 } = deps.popFlag(argv19, "--json");
	const { present: compact, rest: unknown } = deps.popFlag(argv20, "--compact");
	if (unknown.length > 0) {
		return deps.jsonError(`unknown args: ${unknown.join(" ")}`, { pretty, recovery: ["mu memory --help"] });
	}
	const since = sinceRaw ? deps.ensureInt(sinceRaw, { name: "--since", min: 0 }) : null;
	if (sinceRaw && since == null) {
		return deps.jsonError("--since must be an integer >= 0", { pretty, recovery: ["mu memory search --since 0"] });
	}
	const until = untilRaw ? deps.ensureInt(untilRaw, { name: "--until", min: 0 }) : null;
	if (untilRaw && until == null) {
		return deps.jsonError("--until must be an integer >= 0", { pretty, recovery: ["mu memory search --until 0"] });
	}
	const limit = limitRaw ? deps.ensureInt(limitRaw, { name: "--limit", min: 1, max: 500 }) : 20;
	if (limit == null) {
		return deps.jsonError("--limit must be an integer between 1 and 500", {
			pretty,
			recovery: ["mu memory search --limit 20"],
		});
	}

	const search = new URLSearchParams();
	deps.setSearchParamIfPresent(search, "query", query ?? queryAlias ?? null);
	deps.setSearchParamIfPresent(search, "sources", sources ?? null);
	deps.setSearchParamIfPresent(search, "source", source ?? null);
	deps.setSearchParamIfPresent(search, "issue_id", issueId ?? null);
	deps.setSearchParamIfPresent(search, "run_id", runId ?? null);
	deps.setSearchParamIfPresent(search, "session_id", sessionId ?? null);
	deps.setSearchParamIfPresent(search, "conversation_key", conversationKey ?? null);
	deps.setSearchParamIfPresent(search, "channel", channel ?? null);
	deps.setSearchParamIfPresent(search, "channel_tenant_id", channelTenantId ?? null);
	deps.setSearchParamIfPresent(search, "channel_conversation_id", channelConversationId ?? null);
	deps.setSearchParamIfPresent(search, "actor_binding_id", actorBindingId ?? null);
	deps.setSearchParamIfPresent(search, "topic", topic ?? null);
	deps.setSearchParamIfPresent(search, "author", author ?? null);
	deps.setSearchParamIfPresent(search, "role", role ?? null);
	if (since != null) search.set("since", String(since));
	if (until != null) search.set("until", String(until));
	deps.setSearchParamIfPresent(search, "order", order ?? null);
	search.set("limit", String(limit));

	try {
		if (sub === "search") {
			const result = await runContextSearch({
				repoRoot: ctx.repoRoot,
				search,
				indexAutoRebuild: "missing",
			});
			if (!jsonMode || compact) {
				return deps.ok(renderContextPayloadCompact(result as unknown as Record<string, unknown>));
			}
			return deps.ok(deps.jsonText(result, pretty));
		}
		if (sub === "timeline") {
			const result = await runContextTimeline({
				repoRoot: ctx.repoRoot,
				search,
				indexAutoRebuild: "missing",
			});
			if (!jsonMode || compact) {
				return deps.ok(renderContextPayloadCompact(result as unknown as Record<string, unknown>));
			}
			return deps.ok(deps.jsonText(result, pretty));
		}
		const result = await runContextStats({
			repoRoot: ctx.repoRoot,
			search,
			indexAutoRebuild: "missing",
		});
		if (!jsonMode || compact) {
			return deps.ok(renderContextPayloadCompact(result as unknown as Record<string, unknown>));
		}
		return deps.ok(deps.jsonText(result, pretty));
	} catch (err) {
		if (err instanceof ContextQueryValidationError) {
			return deps.jsonError(err.message, { pretty, recovery: [`mu memory ${sub}`] });
		}
		return deps.jsonError(`memory query failed: ${deps.describeError(err)}`, {
			pretty,
			recovery: [`mu memory ${sub}`],
		});
	}
}
