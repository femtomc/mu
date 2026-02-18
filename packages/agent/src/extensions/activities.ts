import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	asArray,
	asNumber,
	asRecord,
	asString,
	clampInt,
	fetchMuJson,
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

function summarizeActivity(activity: Record<string, unknown>): Record<string, unknown> {
	return {
		activity_id: asString(activity.activity_id),
		title: previewText(activity.title, 140),
		kind: asString(activity.kind),
		status: asString(activity.status),
		message_preview: previewText(activity.message, 180),
		started_at_ms: asNumber(activity.started_at_ms),
		updated_at_ms: asNumber(activity.updated_at_ms),
		finished_at_ms: asNumber(activity.finished_at_ms),
	};
}

function summarizeActivityEvent(event: Record<string, unknown>): Record<string, unknown> {
	return {
		ts_ms: asNumber(event.ts_ms),
		status: asString(event.status),
		message_preview: previewText(event.message, 220),
		reason: asString(event.reason),
		source: asString(event.source),
	};
}

function summarizeActivityMutation(payload: Record<string, unknown>): Record<string, unknown> {
	const activity = asRecord(payload.activity) ?? asRecord(payload.target_activity) ?? asRecord(payload.result);
	return {
		ok: payload.ok ?? null,
		reason: asString(payload.reason),
		activity: activity ? summarizeActivity(activity) : null,
	};
}

export type ActivitiesExtensionOpts = {
	allowMutations?: boolean;
};

export function activitiesExtension(pi: ExtensionAPI, opts: ActivitiesExtensionOpts = {}) {
	const allowMutations = opts.allowMutations ?? true;
	const activityActions = allowMutations
		? (["list", "get", "start", "progress", "heartbeat", "complete", "fail", "cancel", "events"] as const)
		: (["list", "get", "events"] as const);
	const ActivitiesParams = Type.Object({
		action: StringEnum(activityActions),
		activity_id: Type.Optional(Type.String({ description: "Activity ID" })),
		title: Type.Optional(Type.String({ description: "Title for start" })),
		kind: Type.Optional(Type.String({ description: "Activity kind for start/list filtering" })),
		heartbeat_every_ms: Type.Optional(Type.Number({ description: "Heartbeat interval in ms for start" })),
		status: Type.Optional(Type.String({ description: "Status filter for list" })),
		contains: Type.Optional(Type.String({ description: "Case-insensitive search text for list/event messages" })),
		message: Type.Optional(Type.String({ description: "Progress/final message" })),
		reason: Type.Optional(Type.String({ description: "Heartbeat reason" })),
		fields: Type.Optional(Type.String({ description: "Comma-separated fields for get/events selection" })),
		limit: Type.Optional(Type.Number({ description: "Optional limit for list/events (default: 20)" })),
	});

	pi.registerTool({
		name: "mu_activities",
		label: "Activities",
		description: allowMutations
			? "Manage generic long-running activities. Actions: list, get, start, progress, heartbeat, complete, fail, cancel, events. List/events are summary-first; use fields for precise retrieval."
			: "Read-only activity inspection. Actions: list, get, events. Mutation actions are disabled in query-only mode.",
		parameters: ActivitiesParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const query = new URLSearchParams();
					const status = trimOrNull(params.status);
					const kind = trimOrNull(params.kind);
					const contains = trimOrNull(params.contains);
					const limit = clampInt(params.limit, 20, 1, 500);
					if (status) query.set("status", status);
					if (kind) query.set("kind", kind);
					query.set("limit", String(Math.max(limit, 100)));
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/activities?${query.toString()}`);
					const activities = asArray(payload.activities)
						.map((activity) => asRecord(activity))
						.filter((activity): activity is Record<string, unknown> => activity != null)
						.filter((activity) => {
							if (!contains) return true;
							const haystack = `${previewText(activity.title, 500)}\n${previewText(activity.message, 500)}`.toLowerCase();
							return haystack.includes(contains.toLowerCase());
						});
					const sliced = activities.slice(0, limit);
					return textResult(
						toJsonText({
							total: activities.length,
							returned: sliced.length,
							truncated: sliced.length < activities.length,
							activities: sliced.map((activity) => summarizeActivity(activity)),
						}),
						{ action: "list", status, kind, contains, limit, payload },
					);
				}
				case "get": {
					const activityId = trimOrNull(params.activity_id);
					if (!activityId) return textResult("get requires activity_id");
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/activities/${encodeURIComponent(activityId)}`,
					);
					const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
					const content =
						fields.length > 0
							? { activity_id: activityId, selected: selectFields(payload, fields) }
							: { activity: summarizeActivity(payload) };
					return textResult(toJsonText(content), { action: "get", activityId, fields, payload });
				}
				case "events": {
					const activityId = trimOrNull(params.activity_id);
					if (!activityId) return textResult("events requires activity_id");
					const contains = trimOrNull(params.contains);
					const limit = clampInt(params.limit, 20, 1, 500);
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/activities/${encodeURIComponent(activityId)}/events?limit=${Math.max(limit, 100)}`,
					);
					const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
					const records = asArray(payload.events)
						.map((event) => asRecord(event))
						.filter((event): event is Record<string, unknown> => event != null)
						.filter((event) => {
							if (!contains) return true;
							const haystack = `${previewText(event.message, 500)}\n${previewText(event.reason, 500)}\n${previewText(event.status, 500)}`.toLowerCase();
							return haystack.includes(contains.toLowerCase());
						});
					const sliced = records.slice(-limit);
					const content =
						fields.length > 0
							? { activity_id: activityId, selected: sliced.map((event) => selectFields(event, fields)) }
							: { activity_id: activityId, events: sliced.map((event) => summarizeActivityEvent(event)) };
					return textResult(toJsonText(content), { action: "events", activityId, contains, limit, fields, payload });
				}
				case "start": {
					if (!allowMutations) {
						return textResult("activity mutations are disabled in query-only mode.", {
							blocked: true,
							reason: "activities_query_only_mode",
						});
					}
					const title = trimOrNull(params.title);
					if (!title) return textResult("start requires title");
					const kind = trimOrNull(params.kind);
					const heartbeatEveryMs =
						params.heartbeat_every_ms != null && Number.isFinite(params.heartbeat_every_ms)
							? Math.max(0, Math.trunc(params.heartbeat_every_ms))
							: undefined;
					const payload = await fetchMuJson<Record<string, unknown>>("/api/activities/start", {
						method: "POST",
						body: {
							title,
							kind,
							heartbeat_every_ms: heartbeatEveryMs,
						},
					});
					return textResult(toJsonText(summarizeActivityMutation(payload)), {
						action: "start",
						title,
						kind,
						heartbeatEveryMs,
						payload,
					});
				}
				case "progress": {
					if (!allowMutations) {
						return textResult("activity mutations are disabled in query-only mode.", {
							blocked: true,
							reason: "activities_query_only_mode",
						});
					}
					const activityId = trimOrNull(params.activity_id);
					if (!activityId) return textResult("progress requires activity_id");
					const message = trimOrNull(params.message) ?? "progress updated";
					const payload = await fetchMuJson<Record<string, unknown>>("/api/activities/progress", {
						method: "POST",
						body: {
							activity_id: activityId,
							message,
						},
					});
					return textResult(toJsonText(summarizeActivityMutation(payload)), {
						action: "progress",
						activityId,
						message,
						payload,
					});
				}
				case "heartbeat": {
					if (!allowMutations) {
						return textResult("activity mutations are disabled in query-only mode.", {
							blocked: true,
							reason: "activities_query_only_mode",
						});
					}
					const activityId = trimOrNull(params.activity_id);
					if (!activityId) return textResult("heartbeat requires activity_id");
					const reason = trimOrNull(params.reason) ?? "manual";
					const payload = await fetchMuJson<Record<string, unknown>>("/api/activities/heartbeat", {
						method: "POST",
						body: {
							activity_id: activityId,
							reason,
						},
					});
					return textResult(toJsonText(summarizeActivityMutation(payload)), {
						action: "heartbeat",
						activityId,
						reason,
						payload,
					});
				}
				case "complete":
				case "fail":
				case "cancel": {
					const activityId = trimOrNull(params.activity_id);
					if (!activityId) return textResult(`${params.action} requires activity_id`);
					const message = trimOrNull(params.message);
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/activities/${params.action}`, {
						method: "POST",
						body: {
							activity_id: activityId,
							message,
						},
					});
					return textResult(toJsonText(summarizeActivityMutation(payload)), {
						action: params.action,
						activityId,
						message,
						payload,
					});
				}
				default:
					return textResult(`unknown action: ${params.action}`);
			}
		},
	});
}

export default activitiesExtension;
