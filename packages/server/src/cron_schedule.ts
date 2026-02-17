export type CronProgramSchedule =
	| {
			kind: "at";
			at_ms: number;
	  }
	| {
			kind: "every";
			every_ms: number;
			anchor_ms: number;
	  }
	| {
			kind: "cron";
			expr: string;
			tz: string | null;
	  };

type ParsedCronField = {
	any: boolean;
	values: Set<number>;
};

type ParsedCronExpression = {
	minute: ParsedCronField;
	hour: ParsedCronField;
	dayOfMonth: ParsedCronField;
	month: ParsedCronField;
	dayOfWeek: ParsedCronField;
};

type NormalizeCronScheduleOpts = {
	nowMs?: number;
	defaultEveryAnchorMs?: number;
};

type CronDateParts = {
	minute: number;
	hour: number;
	dayOfMonth: number;
	month: number;
	dayOfWeek: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

const DEFAULT_CRON_SEARCH_LIMIT_MINUTES = 366 * 24 * 60 * 2;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function defaultNowMs(): number {
	return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

function parseInteger(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			return null;
		}
		if (!/^-?\d+$/.test(trimmed)) {
			return null;
		}
		const parsed = Number.parseInt(trimmed, 10);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function parseAbsoluteTimeMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	if (/^-?\d+$/.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
	}

	const explicitTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
	const normalized = explicitTz ? trimmed : `${trimmed}Z`;
	const parsed = Date.parse(normalized);
	if (!Number.isFinite(parsed)) {
		return null;
	}
	return Math.trunc(parsed);
}

function resolveTimeZone(raw: unknown): string | null {
	if (raw == null) {
		return null;
	}
	if (typeof raw !== "string") {
		return null;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

function normalizeCronValue(value: number, max: number, wrapSunday: boolean): number {
	if (wrapSunday && value === max) {
		return 0;
	}
	return value;
}

function addRangeValues(
	set: Set<number>,
	range: { start: number; end: number; step: number },
	opts: { min: number; max: number; wrapSunday: boolean },
): boolean {
	if (range.step <= 0) {
		return false;
	}
	if (range.start < opts.min || range.start > opts.max) {
		return false;
	}
	if (range.end < opts.min || range.end > opts.max) {
		return false;
	}
	if (range.start > range.end) {
		return false;
	}
	for (let value = range.start; value <= range.end; value += range.step) {
		set.add(normalizeCronValue(value, opts.max, opts.wrapSunday));
	}
	return true;
}

function parseCronField(rawValue: unknown, opts: { min: number; max: number; wrapSunday?: boolean }): ParsedCronField | null {
	if (typeof rawValue !== "string") {
		return null;
	}
	const raw = rawValue.trim();
	if (!raw) {
		return null;
	}

	const wrapSunday = opts.wrapSunday === true;
	const values = new Set<number>();

	const segments = raw.split(",");
	for (const segmentRaw of segments) {
		const segment = segmentRaw.trim();
		if (!segment) {
			return null;
		}

		const slashIndex = segment.indexOf("/");
		const [base, stepRaw] =
			slashIndex >= 0
				? [segment.slice(0, slashIndex).trim(), segment.slice(slashIndex + 1).trim()]
				: [segment, ""];
		const parsedStep = slashIndex >= 0 ? parseInteger(stepRaw) : 1;
		if (parsedStep == null || parsedStep <= 0) {
			return null;
		}

		if (base === "*" || base.length === 0) {
			if (
				!addRangeValues(
					values,
					{ start: opts.min, end: opts.max, step: parsedStep },
					{ min: opts.min, max: opts.max, wrapSunday },
				)
			) {
				return null;
			}
			continue;
		}

		const dashIndex = base.indexOf("-");
		if (dashIndex >= 0) {
			const startRaw = base.slice(0, dashIndex).trim();
			const endRaw = base.slice(dashIndex + 1).trim();
			const start = parseInteger(startRaw);
			const end = parseInteger(endRaw);
			if (start == null || end == null) {
				return null;
			}
			if (
				!addRangeValues(
					values,
					{ start, end, step: parsedStep },
					{ min: opts.min, max: opts.max, wrapSunday },
				)
			) {
				return null;
			}
			continue;
		}

		const value = parseInteger(base);
		if (value == null) {
			return null;
		}

		if (slashIndex >= 0) {
			if (
				!addRangeValues(
					values,
					{ start: value, end: opts.max, step: parsedStep },
					{ min: opts.min, max: opts.max, wrapSunday },
				)
			) {
				return null;
			}
			continue;
		}

		if (value < opts.min || value > opts.max) {
			return null;
		}
		values.add(normalizeCronValue(value, opts.max, wrapSunday));
	}

	const rangeSize = opts.max - opts.min + 1;
	return {
		any: values.size >= rangeSize,
		values,
	};
}

function parseCronExpression(expr: string): ParsedCronExpression | null {
	const trimmed = expr.trim();
	if (!trimmed) {
		return null;
	}
	const parts = trimmed.split(/\s+/);
	if (parts.length !== 5) {
		return null;
	}

	const minute = parseCronField(parts[0], { min: 0, max: 59 });
	const hour = parseCronField(parts[1], { min: 0, max: 23 });
	const dayOfMonth = parseCronField(parts[2], { min: 1, max: 31 });
	const month = parseCronField(parts[3], { min: 1, max: 12 });
	const dayOfWeek = parseCronField(parts[4], { min: 0, max: 7, wrapSunday: true });
	if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
		return null;
	}

	return {
		minute,
		hour,
		dayOfMonth,
		month,
		dayOfWeek,
	};
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = formatterCache.get(timeZone);
	if (cached) {
		return cached;
	}
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		hourCycle: "h23",
		weekday: "short",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	formatterCache.set(timeZone, formatter);
	return formatter;
}

function getCronDateParts(timestampMs: number, timeZone: string): CronDateParts | null {
	const formatter = getFormatter(timeZone);
	let minute = -1;
	let hour = -1;
	let dayOfMonth = -1;
	let month = -1;
	let dayOfWeek = -1;

	for (const part of formatter.formatToParts(new Date(timestampMs))) {
		switch (part.type) {
			case "minute":
				minute = Number.parseInt(part.value, 10);
				break;
			case "hour":
				hour = Number.parseInt(part.value, 10);
				if (hour === 24) {
					hour = 0;
				}
				break;
			case "day":
				dayOfMonth = Number.parseInt(part.value, 10);
				break;
			case "month":
				month = Number.parseInt(part.value, 10);
				break;
			case "weekday":
				dayOfWeek = WEEKDAY_INDEX[part.value] ?? -1;
				break;
			default:
				break;
		}
	}

	if (
		!Number.isInteger(minute) ||
		!Number.isInteger(hour) ||
		!Number.isInteger(dayOfMonth) ||
		!Number.isInteger(month) ||
		!Number.isInteger(dayOfWeek)
	) {
		return null;
	}

	return {
		minute,
		hour,
		dayOfMonth,
		month,
		dayOfWeek,
	};
}

function fieldMatches(field: ParsedCronField, value: number): boolean {
	if (field.any) {
		return true;
	}
	return field.values.has(value);
}

function dayMatches(parsed: ParsedCronExpression, parts: CronDateParts): boolean {
	const domMatches = fieldMatches(parsed.dayOfMonth, parts.dayOfMonth);
	const dowMatches = fieldMatches(parsed.dayOfWeek, parts.dayOfWeek);
	if (parsed.dayOfMonth.any && parsed.dayOfWeek.any) {
		return true;
	}
	if (parsed.dayOfMonth.any) {
		return dowMatches;
	}
	if (parsed.dayOfWeek.any) {
		return domMatches;
	}
	return domMatches || dowMatches;
}

function resolveCronTimeZone(tz: string | null): string {
	if (tz) {
		return tz;
	}
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function computeNextCronRunAtMs(
	parsed: ParsedCronExpression,
	nowMs: number,
	timeZone: string,
	searchLimitMinutes: number = DEFAULT_CRON_SEARCH_LIMIT_MINUTES,
): number | null {
	const startMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
	for (let offset = 0; offset < searchLimitMinutes; offset += 1) {
		const candidate = startMinute + offset * 60_000;
		const parts = getCronDateParts(candidate, timeZone);
		if (!parts) {
			continue;
		}
		if (!fieldMatches(parsed.minute, parts.minute)) {
			continue;
		}
		if (!fieldMatches(parsed.hour, parts.hour)) {
			continue;
		}
		if (!fieldMatches(parsed.month, parts.month)) {
			continue;
		}
		if (!dayMatches(parsed, parts)) {
			continue;
		}
		return candidate;
	}
	return null;
}

export function normalizeCronSchedule(input: unknown, opts: NormalizeCronScheduleOpts = {}): CronProgramSchedule | null {
	if (!isRecord(input)) {
		return null;
	}
	const nowMs = Math.trunc(opts.nowMs ?? defaultNowMs());
	const kindRaw = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
	const inferredKind =
		kindRaw === "at" || kindRaw === "every" || kindRaw === "cron"
			? kindRaw
			: input.at_ms != null || input.at != null
				? "at"
				: input.every_ms != null || input.everyMs != null
					? "every"
					: input.expr != null
						? "cron"
						: "";

	if (inferredKind === "at") {
		const atMs = parseAbsoluteTimeMs(input.at_ms ?? input.at);
		if (atMs == null || atMs <= 0) {
			return null;
		}
		return {
			kind: "at",
			at_ms: atMs,
		};
	}

	if (inferredKind === "every") {
		const everyMs = parseInteger(input.every_ms ?? input.everyMs);
		if (everyMs == null || everyMs <= 0) {
			return null;
		}
		const anchorRaw = parseInteger(input.anchor_ms ?? input.anchorMs);
		const fallbackAnchor = Math.trunc(opts.defaultEveryAnchorMs ?? nowMs);
		const anchorMs = anchorRaw != null && anchorRaw >= 0 ? anchorRaw : Math.max(0, fallbackAnchor);
		return {
			kind: "every",
			every_ms: everyMs,
			anchor_ms: anchorMs,
		};
	}

	if (inferredKind === "cron") {
		const expr = typeof input.expr === "string" ? input.expr.trim() : "";
		if (!expr) {
			return null;
		}
		if (!parseCronExpression(expr)) {
			return null;
		}
		const tzRaw = resolveTimeZone(input.tz);
		if (input.tz != null && tzRaw == null) {
			return null;
		}
		return {
			kind: "cron",
			expr,
			tz: tzRaw,
		};
	}

	return null;
}

export function computeNextScheduleRunAtMs(schedule: CronProgramSchedule, nowMsRaw: number): number | null {
	const nowMs = Math.trunc(nowMsRaw);
	if (schedule.kind === "at") {
		return schedule.at_ms;
	}
	if (schedule.kind === "every") {
		const everyMs = Math.max(1, Math.trunc(schedule.every_ms));
		const anchorMs = Math.max(0, Math.trunc(schedule.anchor_ms));
		if (nowMs < anchorMs) {
			return anchorMs;
		}
		const elapsed = nowMs - anchorMs;
		const steps = Math.floor(elapsed / everyMs) + 1;
		return anchorMs + steps * everyMs;
	}
	const parsed = parseCronExpression(schedule.expr);
	if (!parsed) {
		return null;
	}
	return computeNextCronRunAtMs(parsed, nowMs, resolveCronTimeZone(schedule.tz));
}
