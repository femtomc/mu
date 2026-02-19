import { describe, expect, test } from "bun:test";
import { MuCliCommandSurface } from "@femtomc/mu-control-plane";

describe("MuCliCommandSurface", () => {
	test("allowlists supported commands and sanitizes arguments", () => {
		const surface = new MuCliCommandSurface();

		const ok = surface.build({
			commandKey: "run resume",
			args: ["mu-abcd1234", "30"],
			invocationId: "cli-1",
		});
		expect(ok.kind).toBe("ok");
		if (ok.kind !== "ok") {
			throw new Error(`expected ok, got ${ok.kind}`);
		}
		expect(ok.plan.commandKind).toBe("run_resume");
		expect(ok.plan.argv).toEqual(["mu", "runs", "resume", "mu-abcd1234", "--max-steps", "30"]);

		const list = surface.build({
			commandKey: "run list",
			args: [],
			invocationId: "cli-2",
		});
		expect(list.kind).toBe("ok");
		if (list.kind !== "ok") {
			throw new Error(`expected ok, got ${list.kind}`);
		}
		expect(list.plan.commandKind).toBe("run_list");
		expect(list.plan.argv).toEqual(["mu", "runs", "list", "--limit", "100"]);

		const status = surface.build({
			commandKey: "run status",
			args: ["mu-abcd1234"],
			invocationId: "cli-3",
		});
		expect(status.kind).toBe("ok");
		if (status.kind !== "ok") {
			throw new Error(`expected ok, got ${status.kind}`);
		}
		expect(status.plan.commandKind).toBe("run_status");
		expect(status.plan.argv).toEqual(["mu", "runs", "get", "mu-abcd1234"]);

		const rejectFlag = surface.build({
			commandKey: "run start",
			args: ["--raw-stream"],
			invocationId: "cli-4",
		});
		expect(rejectFlag).toMatchObject({ kind: "reject", reason: "cli_validation_failed" });

		const interrupt = surface.build({
			commandKey: "run interrupt",
			args: ["mu-abcd1234"],
			invocationId: "cli-5",
		});
		expect(interrupt.kind).toBe("ok");
		if (interrupt.kind !== "ok") {
			throw new Error(`expected ok, got ${interrupt.kind}`);
		}
		expect(interrupt.plan.commandKind).toBe("run_interrupt");
		expect(interrupt.plan.argv).toEqual(["mu", "runs", "interrupt", "mu-abcd1234"]);

		const unknown = surface.build({
			commandKey: "shell exec",
			args: ["rm", "-rf", "/"],
			invocationId: "cli-6",
		});
		expect(unknown).toEqual({ kind: "skip" });
	});
});
