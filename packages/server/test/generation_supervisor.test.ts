import { describe, expect, test } from "bun:test";
import { ControlPlaneGenerationSupervisor } from "../src/generation_supervisor.js";

describe("ControlPlaneGenerationSupervisor", () => {
	test("tracks planned -> swapped -> rollback -> failed lifecycle", () => {
		let nowMs = 10_000;
		const supervisor = new ControlPlaneGenerationSupervisor({
			supervisorId: "control-plane",
			nowMs: () => nowMs,
			initialGeneration: {
				generation_id: "control-plane-gen-0",
				generation_seq: 0,
			},
		});

		const begin = supervisor.beginReload("api_control_plane_reload");
		expect(begin.coalesced).toBe(false);
		expect(begin.attempt.from_generation?.generation_id).toBe("control-plane-gen-0");
		expect(begin.attempt.to_generation.generation_id).toBe("control-plane-gen-1");
		expect(begin.attempt.state).toBe("planned");

		nowMs += 5;
		expect(supervisor.markSwapInstalled(begin.attempt.attempt_id)).toBe(true);
		expect(supervisor.activeGeneration()?.generation_id).toBe("control-plane-gen-1");

		nowMs += 5;
		expect(supervisor.rollbackSwapInstalled(begin.attempt.attempt_id)).toBe(true);
		expect(supervisor.activeGeneration()?.generation_id).toBe("control-plane-gen-0");

		nowMs += 5;
		expect(supervisor.finishReload(begin.attempt.attempt_id, "failure")).toBe(true);
		const snapshot = supervisor.snapshot();
		expect(snapshot.pending_reload).toBeNull();
		expect(snapshot.last_reload?.state).toBe("failed");
		expect(snapshot.last_reload?.swapped_at_ms).toBe(10_005);
		expect(snapshot.active_generation?.generation_id).toBe("control-plane-gen-0");
	});

	test("coalesces overlapping begin requests and advances sequence after completion", () => {
		const supervisor = new ControlPlaneGenerationSupervisor({
			supervisorId: "control-plane",
		});

		const first = supervisor.beginReload("startup");
		expect(first.coalesced).toBe(false);
		expect(first.attempt.to_generation.generation_seq).toBe(0);

		const coalesced = supervisor.beginReload("api_control_plane_reload");
		expect(coalesced.coalesced).toBe(true);
		expect(coalesced.attempt.attempt_id).toBe(first.attempt.attempt_id);

		supervisor.markSwapInstalled(first.attempt.attempt_id);
		supervisor.finishReload(first.attempt.attempt_id, "success");

		const second = supervisor.beginReload("api_control_plane_reload");
		expect(second.coalesced).toBe(false);
		expect(second.attempt.to_generation.generation_seq).toBe(1);
	});
});
