/**
 * mu-server-tools — Serve-mode tools for querying mu server state.
 *
 * This is the core extension the operator relies on for repo introspection.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	clampInt,
	fetchMuJson,
	fetchMuStatus,
	type MuControlPlaneRoute,
	muServerUrl,
	textResult,
	toJsonText,
} from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
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

function summarizeStatus(status: Awaited<ReturnType<typeof fetchMuStatus>>): string {
	const cp = status.control_plane ?? { active: false, adapters: [] as string[], routes: [] as MuControlPlaneRoute[] };
	const routes = cpRoutesFromStatus(cp.routes, cp.adapters);
	const routeText = routes.length > 0 ? routes.map((entry) => `${entry.name}:${entry.route}`).join(", ") : "(none)";
	return [
		`repo: ${status.repo_root}`,
		`issues: open=${status.open_count} ready=${status.ready_count}`,
		`control_plane: ${cp.active ? "active" : "inactive"}`,
		`adapters: ${cp.adapters.length > 0 ? cp.adapters.join(", ") : "(none)"}`,
		`routes: ${routeText}`,
	].join("\n");
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

export function serverToolsExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const url = muServerUrl();
		if (!url) return {};
		const extra = [
			"",
			`[MU SERVER] Connected at ${url}.`,
			"Tools: mu_status, mu_control_plane, mu_issues, mu_forum, mu_events.",
			"Use these tools to inspect repository state and control-plane runtime before advising users.",
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
					`open ${status.open_count} · ready ${status.ready_count} · cp ${status.control_plane?.active ? "on" : "off"}`,
				),
			);
		} catch {
			ctx.ui.setStatus("mu-status", ctx.ui.theme.fg("warning", "μ status unavailable"));
		}
	});

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

	const ControlPlaneParams = Type.Object({
		action: StringEnum(["status", "adapters", "routes"] as const),
	});

	pi.registerTool({
		name: "mu_control_plane",
		label: "Control Plane",
		description: "Inspect control-plane runtime state: active flag, mounted adapters, and webhook routes.",
		parameters: ControlPlaneParams,
		async execute(_toolCallId, params) {
			const status = await fetchMuStatus();
			const cp = status.control_plane ?? {
				active: false,
				adapters: [] as string[],
				routes: [] as MuControlPlaneRoute[],
			};
			const routes = cpRoutesFromStatus(cp.routes, cp.adapters);
			switch (params.action) {
				case "status":
					return textResult(
						toJsonText({
							active: cp.active,
							adapters: cp.adapters,
							routes,
						}),
						{ control_plane: cp, routes },
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

	const IssuesParams = Type.Object({
		action: StringEnum(["list", "get", "ready"] as const),
		id: Type.Optional(Type.String({ description: "Issue ID (for get)" })),
		status: Type.Optional(Type.String({ description: "Filter by status (for list)" })),
		tag: Type.Optional(Type.String({ description: "Filter by tag (for list)" })),
		root: Type.Optional(Type.String({ description: "Root issue ID (for ready)" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items (default 50, max 200)" })),
	});

	pi.registerTool({
		name: "mu_issues",
		label: "Issues",
		description: "Query mu issues. Actions: list, get, ready.",
		parameters: IssuesParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const query = new URLSearchParams();
					const status = trimOrNull(params.status);
					const tag = trimOrNull(params.tag);
					if (status) query.set("status", status);
					if (tag) query.set("tag", tag);
					const issues = await fetchMuJson<any[]>(`/api/issues${query.size > 0 ? `?${query.toString()}` : ""}`);
					const sliced = sliceWithLimit(issues, params.limit);
					return textResult(
						toJsonText({
							total: sliced.total,
							returned: sliced.returned,
							truncated: sliced.truncated,
							issues: sliced.items,
						}),
						{ query: { status, tag }, ...sliced },
					);
				}
				case "get": {
					const id = trimOrNull(params.id);
					if (!id) return textResult("Error: id required for get");
					const issue = await fetchMuJson<Record<string, unknown>>(`/api/issues/${encodeURIComponent(id)}`);
					return textResult(toJsonText(issue), { id, issue });
				}
				case "ready": {
					const root = trimOrNull(params.root);
					const query = root ? `?root=${encodeURIComponent(root)}` : "";
					const issues = await fetchMuJson<any[]>(`/api/issues/ready${query}`);
					const sliced = sliceWithLimit(issues, params.limit);
					return textResult(
						toJsonText({
							total: sliced.total,
							returned: sliced.returned,
							truncated: sliced.truncated,
							issues: sliced.items,
						}),
						{ query: { root }, ...sliced },
					);
				}
				default:
					return textResult(`Unknown action: ${params.action}`);
			}
		},
	});

	const ForumParams = Type.Object({
		action: StringEnum(["read", "post", "topics"] as const),
		topic: Type.Optional(Type.String({ description: "Topic name (for read/post)" })),
		body: Type.Optional(Type.String({ description: "Message body (for post)" })),
		prefix: Type.Optional(Type.String({ description: "Topic prefix filter (for topics)" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items (default 50, max 200)" })),
	});

	pi.registerTool({
		name: "mu_forum",
		label: "Forum",
		description: "Interact with mu forum. Actions: read, post, topics.",
		parameters: ForumParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "read": {
					const topic = trimOrNull(params.topic);
					if (!topic) return textResult("Error: topic required for read");
					const limit = clampInt(params.limit, 50, 1, 200);
					const query = new URLSearchParams({ topic, limit: String(limit) });
					const messages = await fetchMuJson<any[]>(`/api/forum/read?${query.toString()}`);
					return textResult(toJsonText({ topic, count: messages.length, messages }), {
						topic,
						limit,
						count: messages.length,
					});
				}
				case "post": {
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
					const topics = await fetchMuJson<string[]>(
						`/api/forum/topics${query.size > 0 ? `?${query.toString()}` : ""}`,
					);
					const sliced = sliceWithLimit(topics, params.limit);
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

	const EventsParams = Type.Object({
		action: StringEnum(["tail", "query"] as const),
		type: Type.Optional(Type.String({ description: "Filter by event type" })),
		source: Type.Optional(Type.String({ description: "Filter by event source" })),
		since: Type.Optional(Type.Number({ description: "Only events >= ts_ms" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items (default 50, max 200)" })),
	});

	pi.registerTool({
		name: "mu_events",
		label: "Events",
		description: "Query mu event log. Actions: tail, query.",
		parameters: EventsParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "tail": {
					const limit = clampInt(params.limit, 50, 1, 200);
					const events = await fetchMuJson<any[]>(`/api/events/tail?n=${limit}`);
					return textResult(toJsonText({ count: events.length, events }), { limit, count: events.length });
				}
				case "query": {
					const query = new URLSearchParams();
					const type = trimOrNull(params.type);
					const source = trimOrNull(params.source);
					const limit = clampInt(params.limit, 50, 1, 200);
					if (type) query.set("type", type);
					if (source) query.set("source", source);
					if (params.since != null) query.set("since", String(Math.trunc(params.since)));
					query.set("limit", String(limit));
					const events = await fetchMuJson<any[]>(`/api/events?${query.toString()}`);
					return textResult(
						toJsonText({
							filters: { type, source, since: params.since ?? null },
							count: events.length,
							events,
						}),
						{ type, source, since: params.since ?? null, limit, count: events.length },
					);
				}
				default:
					return textResult(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerCommand("mu-status", {
		description: "Show concise mu server status",
		handler: async (_args, ctx) => {
			try {
				const status = await fetchMuStatus();
				ctx.ui.notify(summarizeStatus(status), "info");
			} catch (err) {
				ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("mu-control", {
		description: "Show control-plane adapter/runtime status",
		handler: async (_args, ctx) => {
			try {
				const status = await fetchMuStatus();
				const cp = status.control_plane ?? {
					active: false,
					adapters: [] as string[],
					routes: [] as MuControlPlaneRoute[],
				};
				const routes = cpRoutesFromStatus(cp.routes, cp.adapters);
				const lines = [
					`control_plane: ${cp.active ? "active" : "inactive"}`,
					`adapters: ${cp.adapters.length > 0 ? cp.adapters.join(", ") : "(none)"}`,
					`routes: ${routes.length > 0 ? routes.map((entry) => `${entry.name}:${entry.route}`).join(", ") : "(none)"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

export default serverToolsExtension;
