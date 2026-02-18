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

function summarizeHeartbeatProgram(program: Record<string, unknown>): Record<string, unknown> {
	const target = asRecord(program.target);
	return {
		program_id: asString(program.program_id),
		title: previewText(program.title, 120),
		enabled: program.enabled ?? null,
		every_ms: asNumber(program.every_ms),
		reason: asString(program.reason),
		wake_mode: asString(program.wake_mode),
		target_kind: target ? asString(target.kind) : asString(program.target_kind),
		target_job_id: target ? asString(target.job_id) : asString(program.run_job_id),
		target_root_issue_id: target ? asString(target.root_issue_id) : asString(program.run_root_issue_id),
		target_activity_id: target ? asString(target.activity_id) : asString(program.activity_id),
		last_result: asString(program.last_result),
		updated_at_ms: asNumber(program.updated_at_ms),
	};
}

function summarizeHeartbeatMutation(payload: Record<string, unknown>): Record<string, unknown> {
	const program = asRecord(payload.program);
	return {
		ok: payload.ok ?? null,
		reason: asString(payload.reason),
		program: program ? summarizeHeartbeatProgram(program) : null,
	};
}

export type HeartbeatsExtensionOpts = {
	allowMutations?: boolean;
};

export function heartbeatsExtension(pi: ExtensionAPI, opts: HeartbeatsExtensionOpts = {}) {
	const allowMutations = opts.allowMutations ?? true;
	const heartbeatActions = allowMutations
		? (["list", "get", "create", "update", "delete", "trigger", "enable", "disable"] as const)
		: (["list", "get"] as const);
	const Params = Type.Object({
		action: StringEnum(heartbeatActions),
		program_id: Type.Optional(Type.String({ description: "Heartbeat program ID" })),
		title: Type.Optional(Type.String({ description: "Program title" })),
		target_kind: Type.Optional(Type.String({ description: "Target kind (run|activity)" })),
		run_job_id: Type.Optional(Type.String({ description: "Run job ID target" })),
		run_root_issue_id: Type.Optional(Type.String({ description: "Run root issue ID target" })),
		activity_id: Type.Optional(Type.String({ description: "Activity ID target" })),
		every_ms: Type.Optional(Type.Number({ description: "Heartbeat interval in ms" })),
		reason: Type.Optional(Type.String({ description: "Heartbeat reason" })),
		enabled: Type.Optional(Type.Boolean({ description: "Enabled state" })),
		fields: Type.Optional(Type.String({ description: "Comma-separated fields for get selection" })),
		limit: Type.Optional(Type.Number({ description: "Max returned items for list (default: 20)" })),
	});

	pi.registerTool({
		name: "mu_heartbeats",
		label: "Heartbeats",
		description: allowMutations
			? "Program and manage persistent heartbeat schedules. Actions: list, get, create, update, delete, trigger, enable, disable. Summary-first output; use fields for precise retrieval."
			: "Read heartbeat programs. Actions: list, get. Query-only mode excludes mutations.",
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
					const limit = clampInt(params.limit, 20, 1, 500);
					query.set("limit", String(limit));
					const payload = await fetchMuJson<Record<string, unknown>>(`/api/heartbeats?${query.toString()}`);
					const programs = asArray(payload.programs)
						.map((program) => asRecord(program))
						.filter((program): program is Record<string, unknown> => program != null)
						.map((program) => summarizeHeartbeatProgram(program));
					return textResult(
						toJsonText({ count: programs.length, programs }),
						{ action: "list", targetKind, enabled: params.enabled, limit, payload },
					);
				}
				case "get": {
					const programId = trimOrNull(params.program_id);
					if (!programId) return textResult("get requires program_id");
					const payload = await fetchMuJson<Record<string, unknown>>(
						`/api/heartbeats/${encodeURIComponent(programId)}`,
					);
					const fields = parseFieldPaths(trimOrNull(params.fields) ?? undefined);
					const content =
						fields.length > 0
							? { program_id: programId, selected: selectFields(payload, fields) }
							: { program: summarizeHeartbeatProgram(payload) };
					return textResult(toJsonText(content), { action: "get", programId, fields, payload });
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
					return textResult(toJsonText(summarizeHeartbeatMutation(payload)), {
						action: "create",
						title,
						targetKind,
						payload,
					});
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
					return textResult(toJsonText(summarizeHeartbeatMutation(payload)), { action: "update", programId, payload });
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
					return textResult(toJsonText(summarizeHeartbeatMutation(payload)), { action: "delete", programId, payload });
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
					return textResult(toJsonText(summarizeHeartbeatMutation(payload)), { action: "trigger", programId, payload });
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
					return textResult(toJsonText(summarizeHeartbeatMutation(payload)), {
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

export default heartbeatsExtension;
