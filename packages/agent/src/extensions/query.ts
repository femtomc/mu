import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	clampInt,
	fetchMuJson,
	fetchMuStatus,
	parseFieldPaths,
	selectFields,
	textResult,
	toJsonText,
} from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function appendIf(search: URLSearchParams, key: string, value: string | number | null | undefined): void {
	if (value == null) return;
	const text = typeof value === "number" ? String(Math.trunc(value)) : value.trim();
	if (text.length === 0) return;
	search.set(key, text);
}

const QUERY_ACTIONS = ["describe", "get", "list", "search", "timeline", "stats", "trace"] as const;
const QUERY_RESOURCES = [
	"status",
	"control_plane",
	"issues",
	"issues_ready",
	"forum_topics",
	"forum_messages",
	"events",
	"runs",
	"activities",
	"heartbeats",
	"cron",
	"identities",
	"context",
	"session_flash",
] as const;

const QUERY_DESCRIPTOR = {
	version: 1,
	tool: "query",
	actions: [...QUERY_ACTIONS],
	resources: {
		status: { actions: ["get"], note: "Repo/control-plane status snapshot." },
		control_plane: { actions: ["get"], note: "Extracted control_plane view from status." },
		issues: { actions: ["list", "get"], note: "Issue listing + targeted issue retrieval." },
		issues_ready: { actions: ["list"], note: "Ready leaf issue discovery." },
		forum_topics: { actions: ["list"], note: "Forum topic discovery." },
		forum_messages: { actions: ["list"], note: "Topic message reads." },
		events: { actions: ["list", "trace"], note: "Event queries + tail inspection." },
		runs: { actions: ["list", "get", "trace"], note: "Run list/status/trace." },
		activities: { actions: ["list", "get", "trace"], note: "Activity list/get/events." },
		heartbeats: { actions: ["list", "get"], note: "Heartbeat program inspection." },
		cron: { actions: ["stats", "list", "get"], note: "Cron status/list/get." },
		identities: { actions: ["list"], note: "Identity binding list." },
		context: { actions: ["search", "timeline", "stats"], note: "Cross-store historical context." },
		session_flash: { actions: ["list", "get"], note: "Session-targeted flash message inbox state." },
	},
	defaults: {
		list_limit: 20,
		trace_limit: 40,
		max_limit: 500,
	},
	mutation_pathway: {
		tool: "command",
		kinds: [
			"run_start",
			"run_resume",
			"run_interrupt",
			"reload",
			"update",
			"issue_create",
			"issue_update",
			"issue_claim",
			"issue_open",
			"issue_close",
			"issue_dep",
			"issue_undep",
			"forum_post",
			"heartbeat_create",
			"heartbeat_update",
			"heartbeat_delete",
			"heartbeat_trigger",
			"heartbeat_enable",
			"heartbeat_disable",
			"cron_create",
			"cron_update",
			"cron_delete",
			"cron_trigger",
			"cron_enable",
			"cron_disable",
			"session_flash_create",
			"session_flash_ack",
			"session_turn",
		],
		note: "All mutations are routed through command -> /api/commands/submit.",
	},
	hints: [
		"Narrow first: pass limit + filters before broad scans.",
		"Use fields for targeted projection and context hygiene.",
	],
	examples: [
		{ action: "get", resource: "status" },
		{ action: "list", resource: "issues", status: "open", limit: 20 },
		{ action: "get", resource: "issues", id: "mu-abc123", fields: "id,title,status,tags" },
		{ action: "search", resource: "context", query: "reload failure", limit: 30 },
		{ action: "timeline", resource: "context", conversation_key: "telegram:bot:chat-1:binding-1", limit: 80 },
		{ action: "list", resource: "session_flash", session_id: "operator-abc", status: "pending" },
	],
};

export function queryExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const lines = [
			"",
			"[MU QUERY]",
			"Tool: query(action=describe|get|list|search|timeline|stats|trace, resource=...)",
			"Use query(action=describe) first when you need machine-readable capability discovery.",
		];
		return {
			systemPrompt: `${event.systemPrompt}${lines.join("\n")}`,
		};
	});

	const QueryParams = Type.Object({
		action: StringEnum(QUERY_ACTIONS),
		resource: Type.Optional(StringEnum(QUERY_RESOURCES)),
		id: Type.Optional(Type.String({ description: "Primary identifier for get/trace actions" })),
		query: Type.Optional(Type.String({ description: "Search query text" })),
		q: Type.Optional(Type.String({ description: "Alias for query" })),
		status: Type.Optional(Type.String({ description: "Status filter" })),
		tag: Type.Optional(Type.String({ description: "Issue tag filter" })),
		contains: Type.Optional(Type.String({ description: "Case-insensitive contains filter" })),
		type: Type.Optional(Type.String({ description: "Event type filter" })),
		source: Type.Optional(Type.String({ description: "Event/context source filter" })),
		sources: Type.Optional(Type.String({ description: "Comma-separated source kinds (context)" })),
		root_issue_id: Type.Optional(Type.String({ description: "Run root issue id for lookup" })),
		issue_id: Type.Optional(Type.String({ description: "Issue filter" })),
		run_id: Type.Optional(Type.String({ description: "Run filter" })),
		session_id: Type.Optional(Type.String({ description: "Session filter" })),
		session_kind: Type.Optional(Type.String({ description: "Session kind filter" })),
		conversation_key: Type.Optional(Type.String({ description: "Conversation key filter" })),
		channel: Type.Optional(Type.String({ description: "Channel filter" })),
		channel_tenant_id: Type.Optional(Type.String({ description: "Channel tenant filter" })),
		channel_conversation_id: Type.Optional(Type.String({ description: "Channel conversation filter" })),
		actor_binding_id: Type.Optional(Type.String({ description: "Actor binding filter" })),
		topic: Type.Optional(Type.String({ description: "Forum topic" })),
		prefix: Type.Optional(Type.String({ description: "Forum topic prefix" })),
		author: Type.Optional(Type.String({ description: "Author filter" })),
		role: Type.Optional(Type.String({ description: "Role filter" })),
		kind: Type.Optional(Type.String({ description: "Kind filter (activities)" })),
		schedule_kind: Type.Optional(Type.String({ description: "Cron schedule kind filter" })),
		target_kind: Type.Optional(Type.String({ description: "Program target kind filter" })),
		enabled: Type.Optional(Type.Boolean({ description: "Enabled state filter" })),
		include_inactive: Type.Optional(Type.Boolean({ description: "Include inactive identity bindings" })),
		since: Type.Optional(Type.Number({ description: "Only rows >= epoch ms" })),
		until: Type.Optional(Type.Number({ description: "Only rows <= epoch ms" })),
		order: Type.Optional(Type.String({ description: "Order for timeline: asc|desc" })),
		limit: Type.Optional(Type.Number({ description: "Max rows (default 20, max 500)" })),
		fields: Type.Optional(
			Type.String({
				description: "Comma-separated projection fields (e.g. items.0.source_kind,total)",
			}),
		),
	});

	pi.registerTool({
		name: "query",
		label: "Query",
		description:
			"Read-only query tool for mu state. Supports self-discovery (action=describe), targeted retrieval, and cross-store context search/timeline/stats.",
		parameters: QueryParams,
		async execute(_toolCallId, params) {
			if (params.action === "describe") {
				const resource = trimOrNull(params.resource);
				if (resource && resource in QUERY_DESCRIPTOR.resources) {
					const selected = {
						...QUERY_DESCRIPTOR,
						resources: {
							[resource]: QUERY_DESCRIPTOR.resources[resource as keyof typeof QUERY_DESCRIPTOR.resources],
						},
					};
					return textResult(toJsonText(selected), selected as unknown as Record<string, unknown>);
				}
				return textResult(toJsonText(QUERY_DESCRIPTOR), QUERY_DESCRIPTOR as unknown as Record<string, unknown>);
			}

			const resource = trimOrNull(params.resource);
			if (!resource) {
				return textResult("resource is required for non-describe actions");
			}
			const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
			const render = (payload: unknown) => {
				const output = fields.length > 0 ? selectFields(payload, fields) : payload;
				return textResult(toJsonText(output), {
					action: params.action,
					resource,
					fields,
					payload,
				});
			};
			const limit = clampInt(params.limit, params.action === "trace" ? 40 : 20, 1, 500);

			switch (resource) {
				case "status": {
					if (params.action !== "get") return textResult("status only supports action=get");
					const status = await fetchMuStatus();
					return render(status);
				}
				case "control_plane": {
					if (params.action !== "get") return textResult("control_plane only supports action=get");
					const status = await fetchMuStatus();
					return render(status.control_plane);
				}
				case "issues": {
					if (params.action === "get") {
						const id = trimOrNull(params.id) ?? trimOrNull(params.issue_id);
						if (!id) return textResult("issues get requires id");
						const payload = await fetchMuJson<Record<string, unknown>>(`/api/issues/${encodeURIComponent(id)}`);
						return render(payload);
					}
					if (params.action !== "list") return textResult("issues supports action=list|get");
					const search = new URLSearchParams();
					appendIf(search, "status", trimOrNull(params.status) ?? "open");
					appendIf(search, "tag", trimOrNull(params.tag));
					appendIf(search, "contains", trimOrNull(params.contains));
					appendIf(search, "limit", limit);
					const payload = await fetchMuJson<unknown[]>(`/api/issues?${search.toString()}`);
					return render({ count: payload.length, issues: payload });
				}
				case "issues_ready": {
					if (params.action !== "list") return textResult("issues_ready only supports action=list");
					const search = new URLSearchParams();
					appendIf(search, "root", trimOrNull(params.root_issue_id));
					appendIf(search, "contains", trimOrNull(params.contains));
					appendIf(search, "limit", limit);
					const payload = await fetchMuJson<unknown[]>(`/api/issues/ready?${search.toString()}`);
					return render({ count: payload.length, issues: payload });
				}
				case "forum_topics": {
					if (params.action !== "list") return textResult("forum_topics only supports action=list");
					const search = new URLSearchParams();
					appendIf(search, "prefix", trimOrNull(params.prefix));
					appendIf(search, "limit", limit);
					const payload = await fetchMuJson<unknown[]>(`/api/forum/topics?${search.toString()}`);
					return render({ count: payload.length, topics: payload });
				}
				case "forum_messages": {
					if (params.action !== "list") return textResult("forum_messages only supports action=list");
					const topic = trimOrNull(params.topic);
					if (!topic) return textResult("forum_messages list requires topic");
					const search = new URLSearchParams();
					appendIf(search, "topic", topic);
					appendIf(search, "limit", limit);
					const payload = await fetchMuJson<unknown[]>(`/api/forum/read?${search.toString()}`);
					return render({ count: payload.length, topic, messages: payload });
				}
				case "events": {
					if (params.action === "trace") {
						const payload = await fetchMuJson<unknown[]>(`/api/events/tail?n=${limit}`);
						return render({ count: payload.length, events: payload });
					}
					if (params.action !== "list") return textResult("events supports action=list|trace");
					const search = new URLSearchParams();
					appendIf(search, "type", trimOrNull(params.type));
					appendIf(search, "source", trimOrNull(params.source));
					appendIf(search, "issue_id", trimOrNull(params.issue_id));
					appendIf(search, "run_id", trimOrNull(params.run_id));
					appendIf(search, "contains", trimOrNull(params.contains));
					appendIf(search, "since", params.since ?? null);
					appendIf(search, "limit", limit);
					const payload = await fetchMuJson<unknown[]>(`/api/events?${search.toString()}`);
					return render({ count: payload.length, events: payload });
				}
				case "runs": {
					if (params.action === "list") {
						const search = new URLSearchParams();
						appendIf(search, "status", trimOrNull(params.status));
						appendIf(search, "limit", limit);
						const payload = await fetchMuJson<Record<string, unknown>>(`/api/runs?${search.toString()}`);
						return render(payload);
					}
					if (params.action === "get") {
						const id = trimOrNull(params.id) ?? trimOrNull(params.root_issue_id);
						if (!id) return textResult("runs get requires id or root_issue_id");
						const payload = await fetchMuJson<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}`);
						return render(payload);
					}
					if (params.action === "trace") {
						const id = trimOrNull(params.id) ?? trimOrNull(params.root_issue_id);
						if (!id) return textResult("runs trace requires id or root_issue_id");
						const payload = await fetchMuJson<Record<string, unknown>>(
							`/api/runs/${encodeURIComponent(id)}/trace?limit=${limit}`,
						);
						return render(payload);
					}
					return textResult("runs supports action=list|get|trace");
				}
				case "activities": {
					if (params.action === "list") {
						const search = new URLSearchParams();
						appendIf(search, "status", trimOrNull(params.status));
						appendIf(search, "kind", trimOrNull(params.kind));
						appendIf(search, "limit", limit);
						const payload = await fetchMuJson<Record<string, unknown>>(`/api/activities?${search.toString()}`);
						return render(payload);
					}
					if (params.action === "get") {
						const id = trimOrNull(params.id);
						if (!id) return textResult("activities get requires id");
						const payload = await fetchMuJson<Record<string, unknown>>(
							`/api/activities/${encodeURIComponent(id)}`,
						);
						return render(payload);
					}
					if (params.action === "trace") {
						const id = trimOrNull(params.id);
						if (!id) return textResult("activities trace requires id");
						const search = new URLSearchParams();
						appendIf(search, "limit", limit);
						const payload = await fetchMuJson<Record<string, unknown>>(
							`/api/activities/${encodeURIComponent(id)}/events?${search.toString()}`,
						);
						return render(payload);
					}
					return textResult("activities supports action=list|get|trace");
				}
				case "heartbeats": {
					if (params.action === "list") {
						const search = new URLSearchParams();
						appendIf(search, "enabled", params.enabled == null ? null : String(params.enabled));
						appendIf(search, "target_kind", trimOrNull(params.target_kind));
						appendIf(search, "limit", limit);
						const payload = await fetchMuJson<Record<string, unknown>>(`/api/heartbeats?${search.toString()}`);
						return render(payload);
					}
					if (params.action === "get") {
						const id = trimOrNull(params.id);
						if (!id) return textResult("heartbeats get requires id");
						const payload = await fetchMuJson<Record<string, unknown>>(
							`/api/heartbeats/${encodeURIComponent(id)}`,
						);
						return render(payload);
					}
					return textResult("heartbeats supports action=list|get");
				}
				case "cron": {
					if (params.action === "stats") {
						const payload = await fetchMuJson<Record<string, unknown>>("/api/cron/status");
						return render(payload);
					}
					if (params.action === "list") {
						const search = new URLSearchParams();
						appendIf(search, "enabled", params.enabled == null ? null : String(params.enabled));
						appendIf(search, "target_kind", trimOrNull(params.target_kind));
						appendIf(search, "schedule_kind", trimOrNull(params.schedule_kind));
						appendIf(search, "limit", limit);
						const payload = await fetchMuJson<Record<string, unknown>>(`/api/cron?${search.toString()}`);
						return render(payload);
					}
					if (params.action === "get") {
						const id = trimOrNull(params.id);
						if (!id) return textResult("cron get requires id");
						const payload = await fetchMuJson<Record<string, unknown>>(`/api/cron/${encodeURIComponent(id)}`);
						return render(payload);
					}
					return textResult("cron supports action=stats|list|get");
				}
				case "identities": {
					if (params.action !== "list") return textResult("identities only supports action=list");
					const search = new URLSearchParams();
					appendIf(search, "include_inactive", params.include_inactive ? "true" : null);
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/identities${search.size > 0 ? `?${search.toString()}` : ""}`,
					);
					return render(payload);
				}
				case "context": {
					if (params.action !== "search" && params.action !== "timeline" && params.action !== "stats") {
						return textResult("context supports action=search|timeline|stats");
					}
					const search = new URLSearchParams();
					appendIf(search, "query", trimOrNull(params.query) ?? trimOrNull(params.q));
					appendIf(search, "sources", trimOrNull(params.sources));
					appendIf(search, "source", trimOrNull(params.source));
					appendIf(search, "issue_id", trimOrNull(params.issue_id));
					appendIf(search, "run_id", trimOrNull(params.run_id));
					appendIf(search, "session_id", trimOrNull(params.session_id));
					appendIf(search, "conversation_key", trimOrNull(params.conversation_key));
					appendIf(search, "channel", trimOrNull(params.channel));
					appendIf(search, "channel_tenant_id", trimOrNull(params.channel_tenant_id));
					appendIf(search, "channel_conversation_id", trimOrNull(params.channel_conversation_id));
					appendIf(search, "actor_binding_id", trimOrNull(params.actor_binding_id));
					appendIf(search, "topic", trimOrNull(params.topic));
					appendIf(search, "author", trimOrNull(params.author));
					appendIf(search, "role", trimOrNull(params.role));
					appendIf(search, "since", params.since ?? null);
					appendIf(search, "until", params.until ?? null);
					appendIf(search, "order", trimOrNull(params.order));
					appendIf(search, "limit", limit);
					const endpoint =
						params.action === "timeline"
							? "/api/context/timeline"
							: params.action === "stats"
								? "/api/context/stats"
								: "/api/context/search";
					const payload = await fetchMuJson<Record<string, unknown>>(
						`${endpoint}${search.size > 0 ? `?${search.toString()}` : ""}`,
					);
					return render(payload);
				}
				case "session_flash": {
					if (params.action === "get") {
						const id = trimOrNull(params.id);
						if (!id) return textResult("session_flash get requires id");
						const payload = await fetchMuJson<Record<string, unknown>>(
							`/api/session-flash/${encodeURIComponent(id)}`,
						);
						return render(payload);
					}
					if (params.action !== "list") {
						return textResult("session_flash supports action=list|get");
					}
					const search = new URLSearchParams();
					appendIf(search, "session_id", trimOrNull(params.session_id));
					appendIf(search, "session_kind", trimOrNull(params.session_kind));
					appendIf(search, "status", trimOrNull(params.status));
					appendIf(search, "contains", trimOrNull(params.contains));
					appendIf(search, "limit", limit);
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/session-flash${search.size > 0 ? `?${search.toString()}` : ""}`,
					);
					return render(payload);
				}
				default:
					return textResult(`unsupported resource: ${resource}`);
			}
		},
	});
}

export default queryExtension;
