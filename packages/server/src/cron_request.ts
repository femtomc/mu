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
