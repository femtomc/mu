import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { clampInt, fetchMuJson, textResult, toJsonText } from "./shared.js";

function trimOrNull(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function heartbeatsExtension(pi: ExtensionAPI) {
	const Params = Type.Object({
		action: StringEnum(["list", "get", "create", "update", "delete", "trigger", "enable", "disable"] as const),
		program_id: Type.Optional(Type.String({ description: "Heartbeat program ID" })),
		title: Type.Optional(Type.String({ description: "Program title" })),
		target_kind: Type.Optional(Type.String({ description: "Target kind (run|activity)" })),
		run_job_id: Type.Optional(Type.String({ description: "Run job ID target" })),
		run_root_issue_id: Type.Optional(Type.String({ description: "Run root issue ID target" })),
		activity_id: Type.Optional(Type.String({ description: "Activity ID target" })),
		every_ms: Type.Optional(Type.Number({ description: "Heartbeat interval in ms" })),
		reason: Type.Optional(Type.String({ description: "Heartbeat reason" })),
		enabled: Type.Optional(Type.Boolean({ description: "Enabled state" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items for list" })),
	});

	pi.registerTool({
		name: "mu_heartbeats",
		label: "Heartbeats",
		description:
			"Program and manage persistent heartbeat schedules. Actions: list, get, create, update, delete, trigger, enable, disable.",
		parameters: Params,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const query = new URLSearchParams();
					const targetKind = trimOrNull(params.target_kind);
					if (targetKind) {
						query.set("target_kind", targetKind);
					}
					if (typeof params.enabled === "boolean") {
						query.set("enabled", params.enabled ? "true" : "false");
					}
					query.set("limit", String(clampInt(params.limit, 50, 1, 500)));
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/heartbeats?${query.toString()}`);
					return textResult(toJsonText(payload), {
						action: "list",
						targetKind,
						enabled: params.enabled,
					});
				}
				case "get": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("get requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/heartbeats/${encodeURIComponent(programId)}`,
					);
					return textResult(toJsonText(payload), { action: "get", programId });
				}
				case "create": {
					const title = trimOrNull(params.title);
					const targetKind = trimOrNull(params.target_kind);
					if (!title) return textResult("create requires title");
					if (!targetKind) return textResult("create requires target_kind (run|activity)");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/heartbeats/create", {
						method: "POST",
						body: {
							title,
							target_kind: targetKind,
							run_job_id: trimOrNull(params.run_job_id),
							run_root_issue_id: trimOrNull(params.run_root_issue_id),
							activity_id: trimOrNull(params.activity_id),
							every_ms:
								params.every_ms != null && Number.isFinite(params.every_ms)
									? Math.max(0, Math.trunc(params.every_ms))
									: undefined,
							reason: trimOrNull(params.reason),
							enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
						},
					});
					return textResult(toJsonText(payload), { action: "create", title, targetKind });
				}
				case "update": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("update requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/heartbeats/update", {
						method: "POST",
						body: {
							program_id: programId,
							title: trimOrNull(params.title),
							target_kind: trimOrNull(params.target_kind),
							run_job_id: trimOrNull(params.run_job_id),
							run_root_issue_id: trimOrNull(params.run_root_issue_id),
							activity_id: trimOrNull(params.activity_id),
							every_ms:
								params.every_ms != null && Number.isFinite(params.every_ms)
									? Math.max(0, Math.trunc(params.every_ms))
									: undefined,
							reason: trimOrNull(params.reason),
							enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
						},
					});
					return textResult(toJsonText(payload), { action: "update", programId });
				}
				case "delete": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("delete requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/heartbeats/delete", {
						method: "POST",
						body: {
							program_id: programId,
						},
					});
					return textResult(toJsonText(payload), { action: "delete", programId });
				}
				case "trigger": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("trigger requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/heartbeats/trigger", {
						method: "POST",
						body: {
							program_id: programId,
							reason: trimOrNull(params.reason),
						},
					});
					return textResult(toJsonText(payload), { action: "trigger", programId });
				}
				case "enable":
				case "disable": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult(`${params.action} requires program_id`);
					const payload = await fetchMuJson<Record<string, unknown>>("/api/heartbeats/update", {
						method: "POST",
						body: {
							program_id: programId,
							enabled: params.action === "enable",
						},
					});
					return textResult(toJsonText(payload), {
						action: params.action,
						programId,
					});
				}
				default:
					return textResult(`unknown action: ${params.action}`);
			}
		},
	});
}

export default heartbeatsExtension;
