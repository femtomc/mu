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

		const rejectFlag = surface.build({
			commandKey: "run resume",
			args: ["mu-abcd1234", "--raw-stream"],
			invocationId: "cli-2",
		});
		expect(rejectFlag).toMatchObject({ kind: "reject", reason: "cli_validation_failed" });

		const unknown = surface.build({
			commandKey: "shell exec",
			args: ["rm", "-rf", "/"],
			invocationId: "cli-3",
		});
		expect(unknown).toEqual({ kind: "skip" });
	});
});
