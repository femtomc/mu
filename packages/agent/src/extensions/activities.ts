import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { clampInt, fetchMuJson, textResult, toJsonText } from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function activitiesExtension(pi: ExtensionAPI) {
	const ActivitiesParams = Type.Object({
		action: StringEnum(
			["list", "get", "start", "progress", "heartbeat", "complete", "fail", "cancel", "events"] as const,
		),
		activity_id: Type.Optional(Type.String({ description: "Activity ID" })),
		title: Type.Optional(Type.String({ description: "Title for start" })),
		kind: Type.Optional(Type.String({ description: "Activity kind for start/list filtering" })),
		heartbeat_every_ms: Type.Optional(Type.Number({ description: "Heartbeat interval in ms for start" })),
		status: Type.Optional(Type.String({ description: "Status filter for list" })),
		message: Type.Optional(Type.String({ description: "Progress/final message" })),
		reason: Type.Optional(Type.String({ description: "Heartbeat reason" })),
		limit: Type.Optional(Type.Number({ description: "Optional limit for list/events" })),
	});

	pi.registerTool({
		name: "mu_activities",
		label: "Activities",
		description:
			"Manage generic long-running activities. Actions: list, get, start, progress, heartbeat, complete, fail, cancel, events.",
		parameters: ActivitiesParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const query = new URLSearchParams();
					const status = trimOrNull(params.status);
					const kind = trimOrNull(params.kind);
					const limit = clampInt(params.limit, 50, 1, 500);
					if (status) query.set("status", status);
					if (kind) query.set("kind", kind);
					query.set("limit", String(limit));
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/activities?${query.toString()}`);
					return textResult(toJsonText(payload), { action: "list", status, kind, limit });
				}
				case "get": {
					const activityId = trimOrNull(params.activity_id);
					if (!activityId) return textResult("get requires activity_id");
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/activities/${encodeURIComponent(activityId)}`,
					);
					return textResult(toJsonText(payload), { action: "get", activityId });
				}
				case "events": {
					const activityId = trimOrNull(params.activity_id);
					if (!activityId) return textResult("events requires activity_id");
					const limit = clampInt(params.limit, 200, 1, 2_000);
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/activities/${encodeURIComponent(activityId)}/events?limit=${limit}`,
					);
					return textResult(toJsonText(payload), { action: "events", activityId, limit });
				}
				case "start": {
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
					return textResult(toJsonText(payload), { action: "start", title, kind, heartbeatEveryMs });
				}
				case "progress": {
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
					return textResult(toJsonText(payload), { action: "progress", activityId, message });
				}
				case "heartbeat": {
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
					return textResult(toJsonText(payload), { action: "heartbeat", activityId, reason });
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
					return textResult(toJsonText(payload), { action: params.action, activityId, message });
				}
				default:
					return textResult(`unknown action: ${params.action}`);
			}
		},
	});
}

export default activitiesExtension;
