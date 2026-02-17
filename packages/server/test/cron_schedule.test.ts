import { describe, expect, test } from "bun:test";
import { computeNextScheduleRunAtMs, normalizeCronSchedule } from "../src/cron_schedule.js";

describe("cron schedule normalization and next-run computation", () => {
	test("normalizes one-shot at schedules from ISO timestamps", () => {
		const schedule = normalizeCronSchedule({
			kind: "at",
			at: "2026-02-18T15:00:00Z",
		});
		expect(schedule).not.toBeNull();
		expect(schedule?.kind).toBe("at");
		if (!schedule || schedule.kind !== "at") throw new Error("expected at schedule");
		expect(schedule.at_ms).toBe(Date.parse("2026-02-18T15:00:00Z"));
		expect(computeNextScheduleRunAtMs(schedule, Date.parse("2026-02-18T14:00:00Z"))).toBe(schedule.at_ms);
	});

	test("computes fixed every schedules from anchor", () => {
		const schedule = normalizeCronSchedule(
			{
				kind: "every",
				every_ms: 30_000,
				anchor_ms: 1_000,
			},
			{ nowMs: 1_000 },
		);
		expect(schedule).not.toBeNull();
		if (!schedule || schedule.kind !== "every") throw new Error("expected every schedule");
		expect(computeNextScheduleRunAtMs(schedule, 1_000)).toBe(31_000);
		expect(computeNextScheduleRunAtMs(schedule, 31_100)).toBe(61_000);
	});

	test("computes cron-expression next run in UTC", () => {
		const nowMs = Date.parse("2026-01-01T00:00:30Z");
		const schedule = normalizeCronSchedule({
			kind: "cron",
			expr: "*/5 * * * *",
			tz: "UTC",
		});
		expect(schedule).not.toBeNull();
		if (!schedule || schedule.kind !== "cron") throw new Error("expected cron schedule");

		const nextRunAt = computeNextScheduleRunAtMs(schedule, nowMs);
		expect(nextRunAt).toBe(Date.parse("2026-01-01T00:05:00Z"));
	});

	test("respects explicit cron timezones", () => {
		const nowMs = Date.parse("2026-01-01T04:50:00Z");
		const schedule = normalizeCronSchedule({
			kind: "cron",
			expr: "0 0 * * *",
			tz: "America/New_York",
		});
		expect(schedule).not.toBeNull();
		if (!schedule || schedule.kind !== "cron") throw new Error("expected cron schedule");

		const nextRunAt = computeNextScheduleRunAtMs(schedule, nowMs);
		expect(nextRunAt).toBe(Date.parse("2026-01-01T05:00:00Z"));
	});

	test("rejects invalid cron expressions", () => {
		expect(
			normalizeCronSchedule({
				kind: "cron",
				expr: "not a cron",
			}),
		).toBeNull();
	});
});
