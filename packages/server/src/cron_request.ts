import type { CronProgramTarget } from "./cron_programs.js";

export type ParsedCronTarget = {
	target: CronProgramTarget | null;
	error: string | null;
};

export function parseCronTarget(body: Record<string, unknown>): ParsedCronTarget {
	const targetKind = typeof body.target_kind === "string" ? body.target_kind.trim().toLowerCase() : "";
	if (targetKind === "run") {
		const jobId = typeof body.run_job_id === "string" ? body.run_job_id.trim() : "";
		const rootIssueId = typeof body.run_root_issue_id === "string" ? body.run_root_issue_id.trim() : "";
		if (!jobId && !rootIssueId) {
			return {
				target: null,
				error: "run target requires run_job_id or run_root_issue_id",
			};
		}
		return {
			target: {
				kind: "run",
				job_id: jobId || null,
				root_issue_id: rootIssueId || null,
			},
			error: null,
		};
	}
	if (targetKind === "activity") {
		const activityId = typeof body.activity_id === "string" ? body.activity_id.trim() : "";
		if (!activityId) {
			return {
				target: null,
				error: "activity target requires activity_id",
			};
		}
		return {
			target: {
				kind: "activity",
				activity_id: activityId,
			},
			error: null,
		};
	}
	return {
		target: null,
		error: "target_kind must be run or activity",
	};
}

export function hasCronScheduleInput(body: Record<string, unknown>): boolean {
	return (
		body.schedule != null ||
		body.schedule_kind != null ||
		body.at_ms != null ||
		body.at != null ||
		body.every_ms != null ||
		body.anchor_ms != null ||
		body.expr != null ||
		body.tz != null
	);
}

export function cronScheduleInputFromBody(body: Record<string, unknown>): Record<string, unknown> {
	if (body.schedule && typeof body.schedule === "object" && !Array.isArray(body.schedule)) {
		return { ...(body.schedule as Record<string, unknown>) };
	}
	return {
		kind: typeof body.schedule_kind === "string" ? body.schedule_kind : undefined,
		at_ms: body.at_ms,
		at: body.at,
		every_ms: body.every_ms,
		anchor_ms: body.anchor_ms,
		expr: body.expr,
		tz: body.tz,
	};
}
