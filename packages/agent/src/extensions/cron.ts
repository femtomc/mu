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

function normalizedNumber(value: number | undefined): number | undefined {
	if (value == null || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.trunc(value);
}

function summarizeCronProgram(program: Record<string, unknown>): Record<string, unknown> {
	const target = asRecord(program.target);
	const schedule = asRecord(program.schedule);
	return {
		program_id: asString(program.program_id),
		title: previewText(program.title, 120),
		enabled: program.enabled ?? null,
		target_kind: target ? asString(target.kind) : asString(program.target_kind),
		target_job_id: target ? asString(target.job_id) : asString(program.run_job_id),
		target_root_issue_id: target ? asString(target.root_issue_id) : asString(program.run_root_issue_id),
		target_activity_id: target ? asString(target.activity_id) : asString(program.activity_id),
		schedule_kind: schedule ? asString(schedule.kind) : asString(program.schedule_kind),
		schedule_preview: previewText(schedule ?? program, 180),
		reason: asString(program.reason),
		wake_mode: asString(program.wake_mode),
		last_result: asString(program.last_result),
		updated_at_ms: asNumber(program.updated_at_ms),
	};
}

function summarizeCronMutation(payload: Record<string, unknown>): Record<string, unknown> {
	const program = asRecord(payload.program);
	return {
		ok: payload.ok ?? null,
		reason: asString(payload.reason),
		program: program ? summarizeCronProgram(program) : null,
	};
}

export function cronExtension(pi: ExtensionAPI) {
	const Params = Type.Object({
		action: StringEnum(["status", "list", "get", "create", "update", "delete", "trigger", "enable", "disable"] as const),
		program_id: Type.Optional(Type.String({ description: "Cron program ID" })),
		title: Type.Optional(Type.String({ description: "Program title" })),
		target_kind: Type.Optional(Type.String({ description: "Target kind (run|activity)" })),
		run_job_id: Type.Optional(Type.String({ description: "Run job ID target" })),
		run_root_issue_id: Type.Optional(Type.String({ description: "Run root issue ID target" })),
		activity_id: Type.Optional(Type.String({ description: "Activity ID target" })),
		schedule_kind: Type.Optional(Type.String({ description: "Schedule kind (at|every|cron)" })),
		at_ms: Type.Optional(Type.Number({ description: "One-shot timestamp in epoch ms" })),
		at: Type.Optional(Type.String({ description: "One-shot timestamp (ISO-8601)" })),
		every_ms: Type.Optional(Type.Number({ description: "Fixed interval in ms" })),
		anchor_ms: Type.Optional(Type.Number({ description: "Anchor timestamp for every schedules" })),
		expr: Type.Optional(Type.String({ description: "Cron expression (5-field)" })),
		tz: Type.Optional(Type.String({ description: "Optional IANA timezone for cron expressions" })),
		reason: Type.Optional(Type.String({ description: "Execution reason" })),
		enabled: Type.Optional(Type.Boolean({ description: "Enabled state" })),
		schedule_filter: Type.Optional(Type.String({ description: "Filter list by schedule kind" })),
		fields: Type.Optional(Type.String({ description: "Comma-separated fields for get selection" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items for list (default: 20)" })),
	});

	pi.registerTool({
		name: "mu_cron",
		label: "Cron",
		description:
			"Manage persistent cron programs. Actions: status, list, get, create, update, delete, trigger, enable, disable. Summary-first output; use fields for precise retrieval.",
		parameters: Params,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "status": {
					const payload = await fetchMuJson<Record<string, unknown>>("/api/cron/status");
					const runningCount = asNumber(payload.running_count) ?? asNumber(payload.count_running) ?? null;
					const totalCount = asNumber(payload.count) ?? null;
					return textResult(
						toJsonText({ running_count: runningCount, count: totalCount, status: previewText(payload, 240) }),
						{ action: "status", payload },
					);
				}
				case "list": {
					const query = new URLSearchParams();
					const targetKind = trimOrNull(params.target_kind);
					if (targetKind) {
						query.set("target_kind", targetKind);
					}
					if (typeof params.enabled === "boolean") {
						query.set("enabled", params.enabled ? "true" : "false");
					}
					const scheduleFilter = trimOrNull(params.schedule_filter) ?? trimOrNull(params.schedule_kind);
					if (scheduleFilter) {
						query.set("schedule_kind", scheduleFilter);
					}
					const limit = clampInt(params.limit, 20, 1, 500);
					query.set("limit", String(limit));
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/cron?${query.toString()}`);
					const programs = asArray(payload.programs)
						.map((program) => asRecord(program))
						.filter((program): program is Record<string, unknown> => program != null)
						.map((program) => summarizeCronProgram(program));
					return textResult(
						toJsonText({ count: programs.length, programs }),
						{ action: "list", targetKind, enabled: params.enabled, scheduleFilter, limit, payload },
					);
				}
				case "get": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("get requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/cron/${encodeURIComponent(programId)}`);
					const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
					const content =
						fields.length > 0
							? { program_id: programId, selected: selectFields(payload, fields) }
							: { program: summarizeCronProgram(payload) };
					return textResult(toJsonText(content), { action: "get", programId, fields, payload });
				}
				case "create": {
					const title = trimOrNull(params.title);
					const targetKind = trimOrNull(params.target_kind);
					const scheduleKind = trimOrNull(params.schedule_kind);
					if (!title) return textResult("create requires title");
					if (!targetKind) return textResult("create requires target_kind (run|activity)");
					if (!scheduleKind) return textResult("create requires schedule_kind (at|every|cron)");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/cron/create", {
						method: "POST",
						body: {
							title,
							target_kind: targetKind,
							run_job_id: trimOrNull(params.run_job_id),
							run_root_issue_id: trimOrNull(params.run_root_issue_id),
							activity_id: trimOrNull(params.activity_id),
							schedule_kind: scheduleKind,
							at_ms: normalizedNumber(params.at_ms),
							at: trimOrNull(params.at),
							every_ms: normalizedNumber(params.every_ms),
							anchor_ms: normalizedNumber(params.anchor_ms),
							expr: trimOrNull(params.expr),
							tz: trimOrNull(params.tz),
							reason: trimOrNull(params.reason),
							enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
						},
					});
					return textResult(toJsonText(summarizeCronMutation(payload)), {
						action: "create",
						title,
						targetKind,
						scheduleKind,
						payload,
					});
				}
				case "update": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("update requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/cron/update", {
						method: "POST",
						body: {
							program_id: programId,
							title: trimOrNull(params.title),
							target_kind: trimOrNull(params.target_kind),
							run_job_id: trimOrNull(params.run_job_id),
							run_root_issue_id: trimOrNull(params.run_root_issue_id),
							activity_id: trimOrNull(params.activity_id),
							schedule_kind: trimOrNull(params.schedule_kind),
							at_ms: normalizedNumber(params.at_ms),
							at: trimOrNull(params.at),
							every_ms: normalizedNumber(params.every_ms),
							anchor_ms: normalizedNumber(params.anchor_ms),
							expr: trimOrNull(params.expr),
							tz: trimOrNull(params.tz),
							reason: trimOrNull(params.reason),
							enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
						},
					});
					return textResult(toJsonText(summarizeCronMutation(payload)), { action: "update", programId, payload });
				}
				case "delete": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("delete requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/cron/delete", {
						method: "POST",
						body: {
							program_id: programId,
						},
					});
					return textResult(toJsonText(summarizeCronMutation(payload)), { action: "delete", programId, payload });
				}
				case "trigger": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("trigger requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>("/api/cron/trigger", {
						method: "POST",
						body: {
							program_id: programId,
							reason: trimOrNull(params.reason),
						},
					});
					return textResult(toJsonText(summarizeCronMutation(payload)), { action: "trigger", programId, payload });
				}
				case "enable":
				case "disable": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult(`${params.action} requires program_id`);
					const payload = await fetchMuJson<Record<string, unknown>>("/api/cron/update", {
						method: "POST",
						body: {
							program_id: programId,
							enabled: params.action === "enable",
						},
					});
					return textResult(toJsonText(summarizeCronMutation(payload)), {
						action: params.action,
						programId,
						payload,
					});
				}
				default:
					return textResult(`unknown action: ${params.action}`);
			}
		},
	});
}

export default cronExtension;
