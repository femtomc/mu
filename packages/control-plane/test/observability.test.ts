import { describe, expect, test } from "bun:test";
import { GenerationTelemetryRecorder } from "@femtomc/mu-control-plane";

describe("GenerationTelemetryRecorder", () => {
	test("captures generation-tagged logs/metrics/traces and counter totals", () => {
		let nowMs = 1_000;
		const telemetry = new GenerationTelemetryRecorder({
			nowMs: () => nowMs,
			maxRecords: 200,
		});
		const tags = {
			generation_id: "control-plane-gen-2",
			generation_seq: 2,
			supervisor: "control_plane",
			component: "test.reload",
		} as const;

		telemetry.recordReloadSuccess(tags, { reason: "api_control_plane_reload" });
		nowMs += 10;
		telemetry.recordReloadFailure(tags, {
			reason: "api_control_plane_reload",
			error: "boom",
		});
		nowMs += 10;
		telemetry.recordDrainDuration(tags, {
			durationMs: 135,
			timedOut: false,
			metadata: {
				reason: "api_control_plane_reload",
			},
		});
		nowMs += 10;
		telemetry.recordDuplicateSignal(tags, {
			source: "outbox",
			signal: "dedupe_hit",
			dedupe_key: "dupe-key-1",
			record_id: "out-1",
		});
		nowMs += 10;
		telemetry.recordDropSignal(tags, {
			source: "outbox",
			signal: "dead_letter",
			record_id: "out-1",
			reason: "retry_budget_exhausted",
			attempt_count: 3,
		});
		nowMs += 10;
		telemetry.trace({
			name: "control_plane.reload",
			status: "ok",
			durationMs: 42,
			fields: {
				...tags,
				reason: "api_control_plane_reload",
			},
		});

		const counters = telemetry.counters();
		expect(counters.reload_success_total).toBe(1);
		expect(counters.reload_failure_total).toBe(1);
		expect(counters.reload_drain_duration_ms_total).toBe(135);
		expect(counters.reload_drain_duration_samples_total).toBe(1);
		expect(counters.duplicate_signal_total).toBe(1);
		expect(counters.drop_signal_total).toBe(1);

		const records = telemetry.records({ limit: 200 });
		expect(records.some((record) => record.kind === "log")).toBe(true);
		expect(records.some((record) => record.kind === "metric")).toBe(true);
		expect(records.some((record) => record.kind === "trace")).toBe(true);
		for (const record of records) {
			expect(record.fields.generation_id).toBe("control-plane-gen-2");
			expect(record.fields.generation_seq).toBe(2);
			expect(record.fields.supervisor).toBe("control_plane");
		}
	});

	test("gate evaluation is non-blocking and reports exceeded thresholds", () => {
		const telemetry = new GenerationTelemetryRecorder();
		const tags = {
			generation_id: "control-plane-gen-4",
			generation_seq: 4,
			supervisor: "control_plane",
			component: "test.gate",
		} as const;

		telemetry.recordDropSignal(tags, {
			source: "telegram_ingress",
			signal: "dead_letter",
			record_id: "tg-ing-1",
			reason: "retry_budget_exhausted",
			attempt_count: 5,
		});

		const gate = telemetry.evaluateGates({
			max_reload_failures: 0,
			max_drop_signals: 0,
		});
		expect(gate.healthy).toBe(false);
		expect(gate.reasons).toContain("drop_signals_exceeded");
		expect(gate.counters.drop_signal_total).toBe(1);
	});
});
