/**
 * mu-server-tools — Serve-mode tools for querying mu server state.
 *
 * This is the core extension the operator relies on for repo introspection.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerMuSubcommand } from "./mu-command-dispatcher.js";
import {
	asArray,
	asNumber,
	asRecord,
	asString,
	clampInt,
	fetchMuJson,
	fetchMuStatus,
	type MuControlPlaneRoute,
	type MuGenerationObservabilityCounters,
	type MuGenerationSupervisorSnapshot,
	muServerUrl,
	parseFieldPaths,
	previewText,
	selectFields,
	textResult,
	toJsonText,
} from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseCommaList(value: string | undefined): string[] | null {
	const text = trimOrNull(value);
	if (!text) return null;
	const items = text
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : null;
}

function stringArray(value: unknown, max: number = 20): string[] {
	return asArray(value)
		.map((item) => asString(item))
		.filter((item): item is string => item != null)
		.slice(0, max);
}

function summarizeIssue(
	issue: Record<string, unknown>,
	opts: { includeBodyPreview?: boolean } = {},
): Record<string, unknown> {
	const title = asString(issue.title) ?? "";
	const body = asString(issue.body) ?? "";
	const summary: Record<string, unknown> = {
		id: asString(issue.id),
		title: previewText(title, 140),
		status: asString(issue.status),
		priority: asNumber(issue.priority),
		outcome: issue.outcome ?? null,
		tags: stringArray(issue.tags, 12),
		deps: asArray(issue.deps).length,
		updated_at: asNumber(issue.updated_at),
	};
	if (opts.includeBodyPreview) {
		summary.body_chars = body.length;
		summary.body_preview = previewText(body, 220);
	}
	return summary;
}

function summarizeForumMessage(message: Record<string, unknown>): Record<string, unknown> {
	const body = asString(message.body) ?? "";
	return {
		author: asString(message.author) ?? "unknown",
		created_at: asNumber(message.created_at),
		body_chars: body.length,
		body_preview: previewText(body, 240),
	};
}

function summarizeEvent(event: Record<string, unknown>): Record<string, unknown> {
	const payload = asRecord(event.payload);
	const payloadKeys = payload ? Object.keys(payload).slice(0, 8) : [];
	return {
		ts_ms: asNumber(event.ts_ms),
		type: asString(event.type),
		source: asString(event.source),
		issue_id: asString(event.issue_id),
		run_id: asString(event.run_id),
		payload_keys: payloadKeys,
		payload_preview: previewText(event.payload, 140),
	};
}

function deriveBindingRoleFromScopes(scopes: string[]): "operator" | "contributor" | "viewer" | null {
	const scopeSet = new Set(scopes);
	if (scopeSet.has("cp.ops.admin") || scopeSet.has("cp.identity.admin")) {
		return "operator";
	}
	if (scopeSet.has("cp.issue.write") || scopeSet.has("cp.forum.write") || scopeSet.has("cp.run.execute")) {
		return "contributor";
	}
	if (scopeSet.has("cp.read")) {
		return "viewer";
	}
	return null;
}

function summarizeBinding(binding: Record<string, unknown>): Record<string, unknown> {
	const scopes = stringArray(binding.scopes, 20);
	const derivedRole = deriveBindingRoleFromScopes(scopes);
	const status = asString(binding.status);
	const active = binding.active ?? (status ? status === "active" : null);
	return {
		binding_id: asString(binding.binding_id),
		channel: asString(binding.channel),
		actor_id: asString(binding.actor_id) ?? asString(binding.channel_actor_id),
		tenant_id: asString(binding.tenant_id) ?? asString(binding.channel_tenant_id),
		role: asString(binding.role) ?? derivedRole,
		status,
		active,
		scopes,
		created_at_ms: asNumber(binding.created_at_ms) ?? asNumber(binding.linked_at_ms),
		updated_at_ms: asNumber(binding.updated_at_ms),
	};
}

function includeByContains(contains: string | null, ...fragments: unknown[]): boolean {
	if (!contains) {
		return true;
	}
	const haystack = fragments.map((fragment) => previewText(fragment, 4_000).toLowerCase()).join("\n");
	return haystack.includes(contains.toLowerCase());
}

function cpRoutesFromStatus(routes: MuControlPlaneRoute[] | undefined, adapters: string[]): MuControlPlaneRoute[] {
	if (routes && routes.length > 0) {
		return routes;
	}
	return adapters.map((name) => ({
		name,
		route: `/webhooks/${name}`,
	}));
}

function generationSummary(generation: MuGenerationSupervisorSnapshot): string {
	const active = generation.active_generation?.generation_id ?? "(none)";
	const pending = generation.pending_reload
		? `${generation.pending_reload.attempt_id}:${generation.pending_reload.state}`
		: "(none)";
	const last = generation.last_reload
		? `${generation.last_reload.attempt_id}:${generation.last_reload.state}`
		: "(none)";
	return `generation: active=${active} pending=${pending} last=${last}`;
}

function observabilitySummary(counters: MuGenerationObservabilityCounters): string {
	return `observability: reload_success=${counters.reload_success_total} reload_failure=${counters.reload_failure_total} duplicate=${counters.duplicate_signal_total} drop=${counters.drop_signal_total}`;
}

function summarizeStatus(status: Awaited<ReturnType<typeof fetchMuStatus>>): string {
	const cp = status.control_plane;
	const routes = cpRoutesFromStatus(cp.routes, cp.adapters);
	const routeText = routes.length > 0 ? routes.map((entry) => `${entry.name}:${entry.route}`).join(", ") : "(none)";
	const lines = [
		`repo: ${status.repo_root}`,
		`issues: open=${status.open_count} ready=${status.ready_count}`,
		`control_plane: ${cp.active ? "active" : "inactive"}`,
		`adapters: ${cp.adapters.length > 0 ? cp.adapters.join(", ") : "(none)"}`,
		`routes: ${routeText}`,
		generationSummary(cp.generation),
		observabilitySummary(cp.observability.counters),
	];
	return lines.join("\n");
}

function sliceWithLimit<T>(
	items: T[],
	limitRaw: number | undefined,
	fallback: number = 50,
): {
	items: T[];
	limit: number;
	total: number;
	returned: number;
	truncated: boolean;
} {
	const limit = clampInt(limitRaw, fallback, 1, 200);
	const total = items.length;
	const sliced = items.slice(0, limit);
	return {
		items: sliced,
		limit,
		total,
		returned: sliced.length,
		truncated: sliced.length < total,
	};
}

export type ServerToolsExtensionOpts = {
	allowForumPost?: boolean;
	allowIssueMutations?: boolean;
	allowIdentityMutations?: boolean;
	includeStatusTool?: boolean;
	includeControlPlaneTool?: boolean;
	includeIssuesTool?: boolean;
	includeForumTool?: boolean;
	includeEventsTool?: boolean;
	includeIdentityTool?: boolean;
	toolIntroLine?: string;
	usageLine?: string;
	extraSystemPromptLines?: string[];
};

function registerServerTools(pi: ExtensionAPI, opts: Required<ServerToolsExtensionOpts>) {
	pi.on("before_agent_start", async (event) => {
		const url = muServerUrl();
		if (!url) return {};
		const extra = [
			"",
			`[MU SERVER] Connected at ${url}.`,
			opts.toolIntroLine,
			opts.usageLine,
			...opts.extraSystemPromptLines,
		].join("\n");
		return {
			systemPrompt: `${event.systemPrompt}${extra}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const url = muServerUrl();
		if (!ctx.hasUI || !url) return;
		ctx.ui.setStatus("mu-server", ctx.ui.theme.fg("dim", `μ server ${url}`));
		try {
			const status = await fetchMuStatus(4_000);
			ctx.ui.setStatus(
				"mu-status",
				ctx.ui.theme.fg(
					"dim",
					`open ${status.open_count} · ready ${status.ready_count} · cp ${status.control_plane.active ? "on" : "off"}`,
				),
			);
		} catch {
			ctx.ui.setStatus("mu-status", ctx.ui.theme.fg("warning", "μ status unavailable"));
		}
	});

	if (opts.includeStatusTool) {
		pi.registerTool({
			name: "mu_status",
			label: "mu Status",
			description: "Get high-level mu server status (repo root, issue counts, control-plane activity).",
			parameters: Type.Object({}),
			async execute() {
				const status = await fetchMuStatus();
				return textResult(summarizeStatus(status), {
					status,
				});
			},
		});
	}

	const ControlPlaneParams = Type.Object({
		action: StringEnum(["status", "adapters", "routes"] as const),
	});

	if (opts.includeControlPlaneTool) {
		pi.registerTool({
			name: "mu_control_plane",
			label: "Control Plane",
			description: "Inspect control-plane runtime state: active flag, mounted adapters, and webhook routes.",
			parameters: ControlPlaneParams,
			async execute(_toolCallId, params) {
				const status = await fetchMuStatus();
				const cp = status.control_plane;
				const routes = cpRoutesFromStatus(cp.routes, cp.adapters);
				const generation = cp.generation;
				const observability = cp.observability.counters;
				switch (params.action) {
					case "status":
						return textResult(
							toJsonText({
								active: cp.active,
								adapters: cp.adapters,
								routes,
								generation,
								observability,
							}),
							{ control_plane: cp, routes, generation, observability },
						);
					case "adapters":
						return textResult(toJsonText(cp.adapters), { adapters: cp.adapters });
					case "routes":
						return textResult(toJsonText(routes), { routes });
					default:
						return textResult(`Unknown action: ${params.action}`);
				}
			},
		});
	}

	const issueActions = opts.allowIssueMutations
		? (["list", "get", "ready", "create", "update", "claim", "close"] as const)
		: (["list", "get", "ready"] as const);
	const IssuesParams = Type.Object({
		action: StringEnum(issueActions),
		id: Type.Optional(Type.String({ description: "Issue ID (for get/update/claim/close)" })),
		title: Type.Optional(Type.String({ description: "Issue title (for create/update)" })),
		body: Type.Optional(Type.String({ description: "Issue body (for create/update)" })),
		status: Type.Optional(Type.String({ description: "Filter by status (list) or status to set (update)" })),
		tag: Type.Optional(Type.String({ description: "Filter by tag (for list)" })),
		tags: Type.Optional(Type.String({ description: "Comma-separated tags (for create/update)" })),
		priority: Type.Optional(Type.Number({ description: "Priority (for create/update)" })),
		outcome: Type.Optional(Type.String({ description: "Outcome (for close/update)" })),
		root: Type.Optional(Type.String({ description: "Root issue ID (for ready)" })),
		contains: Type.Optional(Type.String({ description: "Case-insensitive search text over issue title/body" })),
		fields: Type.Optional(
			Type.String({ description: "Comma-separated fields for get (e.g. title,status,tags,body)" }),
		),
		limit: Type.Optional(Type.Number({ description: "Max returned items (default 20, max 200)" })),
	});

	if (opts.includeIssuesTool) {
		pi.registerTool({
			name: "mu_issues",
			label: "Issues",
			description: opts.allowIssueMutations
				? "Read and update mu issues. Actions: list, get, ready, create, update, claim, close. Returns concise summaries by default; use fields for precise retrieval."
				: "Query mu issues. Actions: list, get, ready. Returns concise summaries by default. Use id + fields for precise retrieval.",
			parameters: IssuesParams,
			async execute(_toolCallId, params) {
				switch (params.action) {
					case "list": {
						const query = new URLSearchParams();
						const status = trimOrNull(params.status) ?? "open";
						const tag = trimOrNull(params.tag);
						const contains = trimOrNull(params.contains);
						const limit = clampInt(params.limit, 20, 1, 200);
						query.set("status", status);
						query.set("limit", String(limit));
						if (tag) query.set("tag", tag);
						if (contains) query.set("contains", contains);
						const issues = await fetchMuJson<any[]>(`/api/issues?${query.toString()}`);
						const records = issues
							.map((issue) => asRecord(issue))
							.filter((issue): issue is Record<string, unknown> => issue != null);
						const sliced = sliceWithLimit(records, params.limit, 20);
						const summaries = sliced.items.map((issue) => summarizeIssue(issue));
						return textResult(
							toJsonText({
								total: sliced.total,
								returned: sliced.returned,
								truncated: sliced.truncated,
								issues: summaries,
								next: sliced.truncated
									? "Refine filters or increase limit. Use mu_issues(action='get', id='...') for precise inspection."
									: null,
							}),
							{ query: { status, tag, contains, limit }, ...sliced, issues: sliced.items },
						);
					}
					case "get": {
						const id = trimOrNull(params.id);
						if (!id) return textResult("Error: id required for get");
						const issue = await fetchMuJson<Record<string, unknown>>(`/api/issues/${encodeURIComponent(id)}`);
						const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
						const content =
							fields.length > 0
								? { id, selected: selectFields(issue, fields) }
								: { issue: summarizeIssue(issue, { includeBodyPreview: true }) };
						return textResult(toJsonText(content), { id, fields, issue });
					}
					case "ready": {
						const root = trimOrNull(params.root);
						const contains = trimOrNull(params.contains);
						const limit = clampInt(params.limit, 20, 1, 200);
						const query = new URLSearchParams({ limit: String(limit) });
						if (root) query.set("root", root);
						if (contains) query.set("contains", contains);
						const issues = await fetchMuJson<any[]>(`/api/issues/ready?${query.toString()}`);
						const records = issues
							.map((issue) => asRecord(issue))
							.filter((issue): issue is Record<string, unknown> => issue != null);
						const sliced = sliceWithLimit(records, params.limit, 20);
						const summaries = sliced.items.map((issue) => summarizeIssue(issue));
						return textResult(
							toJsonText({
								total: sliced.total,
								returned: sliced.returned,
								truncated: sliced.truncated,
								issues: summaries,
								next: sliced.truncated ? "Narrow by root/contains or increase limit." : null,
							}),
							{ query: { root, contains, limit }, ...sliced, issues: sliced.items },
						);
					}
					case "create": {
						if (!opts.allowIssueMutations) {
							return textResult("issue mutations are disabled in query-only mode.", {
								blocked: true,
								reason: "issue_query_only_mode",
							});
						}
						const title = trimOrNull(params.title);
						if (!title) return textResult("Error: title required for create");
						const bodyText = trimOrNull(params.body);
						const tags = parseCommaList(params.tags);
						const priority =
							typeof params.priority === "number" && Number.isFinite(params.priority)
								? Math.trunc(params.priority)
								: undefined;
						const issue = await fetchMuJson<Record<string, unknown>>("/api/issues", {
							method: "POST",
							body: {
								title,
								body: bodyText ?? undefined,
								tags: tags ?? undefined,
								priority,
							},
						});
						return textResult(toJsonText({ issue: summarizeIssue(issue, { includeBodyPreview: true }) }), {
							action: "create",
							issue,
						});
					}
					case "update": {
						if (!opts.allowIssueMutations) {
							return textResult("issue mutations are disabled in query-only mode.", {
								blocked: true,
								reason: "issue_query_only_mode",
							});
						}
						const id = trimOrNull(params.id);
						if (!id) return textResult("Error: id required for update");
						const patch: Record<string, unknown> = {};
						const title = trimOrNull(params.title);
						if (title != null) patch.title = title;
						const bodyText = trimOrNull(params.body);
						if (bodyText != null) patch.body = bodyText;
						const status = trimOrNull(params.status);
						if (status != null) patch.status = status;
						const outcome = trimOrNull(params.outcome);
						if (outcome != null) patch.outcome = outcome;
						const tags = parseCommaList(params.tags);
						if (tags != null) patch.tags = tags;
						if (typeof params.priority === "number" && Number.isFinite(params.priority)) {
							patch.priority = Math.trunc(params.priority);
						}
						if (Object.keys(patch).length === 0) {
							return textResult(
								"Error: update requires at least one field (title/body/status/outcome/tags/priority)",
							);
						}
						const issue = await fetchMuJson<Record<string, unknown>>(`/api/issues/${encodeURIComponent(id)}`, {
							method: "PATCH",
							body: patch,
						});
						return textResult(toJsonText({ issue: summarizeIssue(issue, { includeBodyPreview: true }) }), {
							action: "update",
							id,
							patch,
							issue,
						});
					}
					case "claim": {
						if (!opts.allowIssueMutations) {
							return textResult("issue mutations are disabled in query-only mode.", {
								blocked: true,
								reason: "issue_query_only_mode",
							});
						}
						const id = trimOrNull(params.id);
						if (!id) return textResult("Error: id required for claim");
						const issue = await fetchMuJson<Record<string, unknown>>(
							`/api/issues/${encodeURIComponent(id)}/claim`,
							{
								method: "POST",
								body: {},
							},
						);
						return textResult(toJsonText({ issue: summarizeIssue(issue, { includeBodyPreview: true }) }), {
							action: "claim",
							id,
							issue,
						});
					}
					case "close": {
						if (!opts.allowIssueMutations) {
							return textResult("issue mutations are disabled in query-only mode.", {
								blocked: true,
								reason: "issue_query_only_mode",
							});
						}
						const id = trimOrNull(params.id);
						if (!id) return textResult("Error: id required for close");
						const outcome = trimOrNull(params.outcome) ?? "success";
						const issue = await fetchMuJson<Record<string, unknown>>(
							`/api/issues/${encodeURIComponent(id)}/close`,
							{
								method: "POST",
								body: { outcome },
							},
						);
						return textResult(toJsonText({ issue: summarizeIssue(issue, { includeBodyPreview: true }) }), {
							action: "close",
							id,
							outcome,
							issue,
						});
					}
					default:
						return textResult(`Unknown action: ${params.action}`);
				}
			},
		});
	}

	const forumActions = opts.allowForumPost ? (["read", "post", "topics"] as const) : (["read", "topics"] as const);
	const ForumParams = Type.Object({
		action: StringEnum(forumActions),
		topic: Type.Optional(Type.String({ description: "Topic name (for read/post)" })),
		body: Type.Optional(Type.String({ description: "Message body (for post)" })),
		prefix: Type.Optional(Type.String({ description: "Topic prefix filter (for topics)" })),
		contains: Type.Optional(Type.String({ description: "Case-insensitive search within message body for read" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items (default 20, max 200)" })),
	});

	if (opts.includeForumTool) {
		pi.registerTool({
			name: "mu_forum",
			label: "Forum",
			description: opts.allowForumPost
				? "Interact with mu forum. Actions: read, post, topics. Read/topics return concise summaries for context safety."
				: "Read forum context. Actions: read, topics. Query-only mode excludes post.",
			parameters: ForumParams,
			async execute(_toolCallId, params) {
				switch (params.action) {
					case "read": {
						const topic = trimOrNull(params.topic);
						if (!topic) return textResult("Error: topic required for read");
						const contains = trimOrNull(params.contains);
						const limit = clampInt(params.limit, 20, 1, 200);
						const query = new URLSearchParams({ topic, limit: String(Math.max(limit, 50)) });
						const messages = await fetchMuJson<any[]>(`/api/forum/read?${query.toString()}`);
						const records = messages
							.map((message) => asRecord(message))
							.filter((message): message is Record<string, unknown> => message != null)
							.filter((message) => includeByContains(contains, message.body, message.author));
						const sliced = sliceWithLimit(records, params.limit, 20);
						const summaries = sliced.items.map((message) => summarizeForumMessage(message));
						return textResult(
							toJsonText({
								topic,
								total: sliced.total,
								returned: sliced.returned,
								truncated: sliced.truncated,
								messages: summaries,
								next: sliced.truncated ? "Use contains/topic filters or lower noise with smaller limit." : null,
							}),
							{ topic, contains, ...sliced, messages: sliced.items },
						);
					}
					case "post": {
						if (!opts.allowForumPost) {
							return textResult(
								"forum post is disabled in operator read-only mode; use approved /mu command flow for mutations.",
								{ blocked: true, reason: "operator_read_only_tools" },
							);
						}
						const topic = trimOrNull(params.topic);
						const body = trimOrNull(params.body);
						if (!topic) return textResult("Error: topic required for post");
						if (!body) return textResult("Error: body required for post");
						const message = await fetchMuJson<Record<string, unknown>>("/api/forum/post", {
							method: "POST",
							body: {
								topic,
								body,
								author: "mu-agent",
							},
						});
						return textResult(toJsonText(message), { topic, posted: true });
					}
					case "topics": {
						const query = new URLSearchParams();
						const prefix = trimOrNull(params.prefix);
						if (prefix) query.set("prefix", prefix);
						const topics = await fetchMuJson<unknown[]>(
							`/api/forum/topics${query.size > 0 ? `?${query.toString()}` : ""}`,
						);
						const records = topics
							.map((topic) => asRecord(topic))
							.filter((topic): topic is Record<string, unknown> => topic != null)
							.map((topic) => ({
								topic: asString(topic.topic) ?? previewText(topic, 120),
								messages: asNumber(topic.messages) ?? null,
								last_at: asNumber(topic.last_at) ?? null,
							}));
						const fallback = topics
							.filter((topic) => typeof topic === "string")
							.map((topic) => ({ topic: topic as string, messages: null, last_at: null }));
						const merged = records.length > 0 ? records : fallback;
						const sliced = sliceWithLimit(merged, params.limit, 20);
						return textResult(
							toJsonText({
								total: sliced.total,
								returned: sliced.returned,
								truncated: sliced.truncated,
								topics: sliced.items,
							}),
							{ prefix, ...sliced },
						);
					}
					default:
						return textResult(`Unknown action: ${params.action}`);
				}
			},
		});
	}

	const EventsParams = Type.Object({
		action: StringEnum(["tail", "query"] as const),
		type: Type.Optional(Type.String({ description: "Filter by event type" })),
		source: Type.Optional(Type.String({ description: "Filter by event source" })),
		issue_id: Type.Optional(Type.String({ description: "Filter by correlated issue_id" })),
		run_id: Type.Optional(Type.String({ description: "Filter by correlated run_id" })),
		since: Type.Optional(Type.Number({ description: "Only events >= ts_ms" })),
		contains: Type.Optional(Type.String({ description: "Case-insensitive search over event payload preview" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items (default 20, max 200)" })),
	});

	if (opts.includeEventsTool) {
		pi.registerTool({
			name: "mu_events",
			label: "Events",
			description: "Query mu event log. Actions: tail, query. Returns compact event previews by default.",
			parameters: EventsParams,
			async execute(_toolCallId, params) {
				switch (params.action) {
					case "tail": {
						const type = trimOrNull(params.type);
						const source = trimOrNull(params.source);
						const issueId = trimOrNull(params.issue_id);
						const runId = trimOrNull(params.run_id);
						const contains = trimOrNull(params.contains);
						const limit = clampInt(params.limit, 20, 1, 200);
						const tailFetch = Math.max(limit * 3, 50);
						const events = await fetchMuJson<any[]>(`/api/events/tail?n=${tailFetch}`);
						const records = events
							.map((event) => asRecord(event))
							.filter((event): event is Record<string, unknown> => event != null)
							.filter((event) => (type ? asString(event.type) === type : true))
							.filter((event) => (source ? asString(event.source) === source : true))
							.filter((event) => (issueId ? asString(event.issue_id) === issueId : true))
							.filter((event) => (runId ? asString(event.run_id) === runId : true))
							.filter((event) =>
								includeByContains(
									contains,
									event.type,
									event.source,
									event.issue_id,
									event.run_id,
									event.payload,
								),
							);
						const sliced = sliceWithLimit(records, params.limit, 20);
						const summaries = sliced.items.map((event) => summarizeEvent(event));
						return textResult(
							toJsonText({
								filters: { type, source, issue_id: issueId, run_id: runId, contains },
								total: sliced.total,
								returned: sliced.returned,
								truncated: sliced.truncated,
								events: summaries,
							}),
							{ action: "tail", type, source, issueId, runId, contains, ...sliced, events: sliced.items },
						);
					}
					case "query": {
						const query = new URLSearchParams();
						const type = trimOrNull(params.type);
						const source = trimOrNull(params.source);
						const issueId = trimOrNull(params.issue_id);
						const runId = trimOrNull(params.run_id);
						const contains = trimOrNull(params.contains);
						const limit = clampInt(params.limit, 20, 1, 200);
						if (type) query.set("type", type);
						if (source) query.set("source", source);
						if (issueId) query.set("issue_id", issueId);
						if (runId) query.set("run_id", runId);
						if (params.since != null) query.set("since", String(Math.trunc(params.since)));
						query.set("limit", String(Math.max(limit, 50)));
						const events = await fetchMuJson<any[]>(`/api/events?${query.toString()}`);
						const records = events
							.map((event) => asRecord(event))
							.filter((event): event is Record<string, unknown> => event != null)
							.filter((event) => (issueId ? asString(event.issue_id) === issueId : true))
							.filter((event) => (runId ? asString(event.run_id) === runId : true))
							.filter((event) =>
								includeByContains(
									contains,
									event.type,
									event.source,
									event.issue_id,
									event.run_id,
									event.payload,
								),
							);
						const sliced = sliceWithLimit(records, params.limit, 20);
						const summaries = sliced.items.map((event) => summarizeEvent(event));
						return textResult(
							toJsonText({
								filters: {
									type,
									source,
									issue_id: issueId,
									run_id: runId,
									since: params.since ?? null,
									contains,
								},
								total: sliced.total,
								returned: sliced.returned,
								truncated: sliced.truncated,
								events: summaries,
							}),
							{
								type,
								source,
								issueId,
								runId,
								since: params.since ?? null,
								contains,
								...sliced,
								events: sliced.items,
							},
						);
					}
					default:
						return textResult(`Unknown action: ${params.action}`);
				}
			},
		});
	}

	const identityActions = opts.allowIdentityMutations ? (["list", "link", "unlink"] as const) : (["list"] as const);
	const IdentityParams = Type.Object({
		action: StringEnum(identityActions),
		channel: Type.Optional(Type.String({ description: "Channel: slack, discord, telegram (for link)" })),
		actor_id: Type.Optional(Type.String({ description: "Channel actor ID (for link)" })),
		tenant_id: Type.Optional(Type.String({ description: "Channel tenant ID (for link)" })),
		role: Type.Optional(
			Type.String({ description: "Role: operator, contributor, viewer (for link, default operator)" }),
		),
		binding_id: Type.Optional(Type.String({ description: "Binding ID (for link/unlink)" })),
		actor_binding_id: Type.Optional(
			Type.String({ description: "Actor binding ID (for unlink, usually same as binding_id)" }),
		),
		reason: Type.Optional(Type.String({ description: "Unlink reason (for unlink)" })),
		include_inactive: Type.Optional(Type.Boolean({ description: "Include inactive bindings (for list)" })),
	});

	if (opts.includeIdentityTool) {
		pi.registerTool({
			name: "mu_identity",
			label: "Identity",
			description: opts.allowIdentityMutations
				? "Manage identity bindings. Actions: list (enumerate bindings), link (create binding), unlink (self-unlink)."
				: "Read identity bindings. Action: list.",
			parameters: IdentityParams,
			async execute(_toolCallId, params) {
				switch (params.action) {
					case "list": {
						const query = new URLSearchParams();
						if (params.include_inactive) query.set("include_inactive", "true");
						const data = await fetchMuJson<{ count: number; bindings: unknown[] }>(
							`/api/identities${query.size > 0 ? `?${query.toString()}` : ""}`,
						);
						const bindings = asArray(data.bindings)
							.map((binding) => asRecord(binding))
							.filter((binding): binding is Record<string, unknown> => binding != null)
							.map((binding) => summarizeBinding(binding));
						return textResult(toJsonText({ count: bindings.length, bindings }), {
							count: data.count,
							bindings: data.bindings,
						});
					}
					case "link": {
						if (!opts.allowIdentityMutations) {
							return textResult(
								"identity mutations are disabled in query-only mode; use list/get workflows or approved operator mutation flow.",
								{ blocked: true, reason: "identity_query_only_mode" },
							);
						}
						const channel = trimOrNull(params.channel);
						const actorId = trimOrNull(params.actor_id);
						const tenantId = trimOrNull(params.tenant_id);
						if (!channel) return textResult("Error: channel required for link");
						if (!actorId) return textResult("Error: actor_id required for link");
						if (!tenantId) return textResult("Error: tenant_id required for link");
						const body: Record<string, unknown> = {
							channel,
							actor_id: actorId,
							tenant_id: tenantId,
						};
						const role = trimOrNull(params.role);
						if (role) body.role = role;
						const bindingId = trimOrNull(params.binding_id);
						if (bindingId) body.binding_id = bindingId;
						const result = await fetchMuJson<Record<string, unknown>>("/api/identities/link", {
							method: "POST",
							body,
						});
						return textResult(toJsonText(result), result);
					}
					case "unlink": {
						if (!opts.allowIdentityMutations) {
							return textResult(
								"identity mutations are disabled in query-only mode; use list/get workflows or approved operator mutation flow.",
								{ blocked: true, reason: "identity_query_only_mode" },
							);
						}
						const bindingId = trimOrNull(params.binding_id);
						const actorBindingId = trimOrNull(params.actor_binding_id);
						if (!bindingId) return textResult("Error: binding_id required for unlink");
						if (!actorBindingId) return textResult("Error: actor_binding_id required for unlink");
						const body: Record<string, unknown> = {
							binding_id: bindingId,
							actor_binding_id: actorBindingId,
						};
						const reason = trimOrNull(params.reason);
						if (reason) body.reason = reason;
						const result = await fetchMuJson<Record<string, unknown>>("/api/identities/unlink", {
							method: "POST",
							body,
						});
						return textResult(toJsonText(result), result);
					}
					default:
						return textResult(`Unknown action: ${params.action}`);
				}
			},
		});
	}

	if (opts.includeStatusTool) {
		registerMuSubcommand(pi, {
			subcommand: "status",
			summary: "Show concise mu server status",
			usage: "/mu status",
			handler: async (_args, ctx) => {
				try {
					const status = await fetchMuStatus();
					ctx.ui.notify(summarizeStatus(status), "info");
				} catch (err) {
					ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	}

	if (opts.includeControlPlaneTool) {
		registerMuSubcommand(pi, {
			subcommand: "control",
			summary: "Show control-plane adapter/runtime status",
			usage: "/mu control",
			handler: async (_args, ctx) => {
				try {
					const status = await fetchMuStatus();
					const cp = status.control_plane;
					const routes = cpRoutesFromStatus(cp.routes, cp.adapters);
					const lines = [
						`control_plane: ${cp.active ? "active" : "inactive"}`,
						`adapters: ${cp.adapters.length > 0 ? cp.adapters.join(", ") : "(none)"}`,
						`routes: ${routes.length > 0 ? routes.map((entry) => `${entry.name}:${entry.route}`).join(", ") : "(none)"}`,
						generationSummary(cp.generation),
						observabilitySummary(cp.observability.counters),
					];
					ctx.ui.notify(lines.join("\n"), "info");
				} catch (err) {
					ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	}
}

export function serverToolsExtension(pi: ExtensionAPI, opts: ServerToolsExtensionOpts = {}) {
	registerServerTools(pi, {
		allowForumPost: opts.allowForumPost ?? true,
		allowIssueMutations: opts.allowIssueMutations ?? true,
		allowIdentityMutations: opts.allowIdentityMutations ?? true,
		includeStatusTool: opts.includeStatusTool ?? true,
		includeControlPlaneTool: opts.includeControlPlaneTool ?? true,
		includeIssuesTool: opts.includeIssuesTool ?? true,
		includeForumTool: opts.includeForumTool ?? true,
		includeEventsTool: opts.includeEventsTool ?? true,
		includeIdentityTool: opts.includeIdentityTool ?? true,
		toolIntroLine:
			opts.toolIntroLine ??
			"Tools: mu_status, mu_control_plane, mu_issues, mu_forum, mu_events, mu_runs, mu_activities, mu_heartbeats, mu_cron, mu_identity.",
		usageLine:
			opts.usageLine ??
			"Use these tools to inspect repository state and control-plane runtime before advising users.",
		extraSystemPromptLines: opts.extraSystemPromptLines ?? [],
	});
}

export function serverToolsReadOnlyExtension(pi: ExtensionAPI) {
	registerServerTools(pi, {
		allowForumPost: false,
		allowIssueMutations: false,
		allowIdentityMutations: false,
		includeStatusTool: true,
		includeControlPlaneTool: true,
		includeIssuesTool: true,
		includeForumTool: true,
		includeEventsTool: true,
		includeIdentityTool: true,
		toolIntroLine:
			"Tools: mu_status, mu_control_plane, mu_issues, mu_forum(read/topics), mu_events, mu_runs(read), mu_messaging_setup(read), mu_identity(list).",
		usageLine: "Use these tools to inspect repository state and control-plane runtime before advising users.",
		extraSystemPromptLines: [
			"You have Bash, Read, Write, and Edit tools. Use them to run mu CLI commands, edit config files, and complete tasks directly.",
		],
	});
}

export function serverToolsIssueForumExtension(pi: ExtensionAPI) {
	registerServerTools(pi, {
		allowForumPost: true,
		allowIssueMutations: true,
		allowIdentityMutations: false,
		includeStatusTool: false,
		includeControlPlaneTool: false,
		includeIssuesTool: true,
		includeForumTool: true,
		includeEventsTool: false,
		includeIdentityTool: false,
		toolIntroLine: "Tools: mu_issues, mu_forum.",
		usageLine: "Use these tools to coordinate issue status and forum updates for your assigned work.",
		extraSystemPromptLines: [],
	});
}

export default serverToolsExtension;
