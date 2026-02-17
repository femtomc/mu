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
		expect(ok.plan.argv).toEqual(["mu", "resume", "mu-abcd1234", "--max-steps", "30", "--json"]);

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
		expect(list.plan.argv).toEqual(["mu", "issues", "list", "--tag", "node:root"]);

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
		expect(status.plan.argv).toEqual(["mu", "issues", "get", "mu-abcd1234"]);

		const rejectFlag = surface.build({
			commandKey: "run start",
			args: ["--raw-stream"],
			invocationId: "cli-4",
		});
		expect(rejectFlag).toMatchObject({ kind: "reject", reason: "cli_validation_failed" });

		const rejectInterrupt = surface.build({
			commandKey: "run interrupt",
			args: ["mu-abcd1234"],
			invocationId: "cli-5",
		});
		expect(rejectInterrupt).toMatchObject({ kind: "reject", reason: "operator_action_disallowed" });

		const unknown = surface.build({
			commandKey: "shell exec",
			args: ["rm", "-rf", "/"],
			invocationId: "cli-6",
		});
		expect(unknown).toEqual({ kind: "skip" });
	});
});
