import { describe, expect, test } from "bun:test";
import { MuCliCommandSurface } from "@femtomc/mu-control-plane";

describe("MuCliCommandSurface", () => {
	test("allowlists supported commands and sanitizes arguments", () => {
		const surface = new MuCliCommandSurface();

		const status = surface.build({
			commandKey: "status",
			args: [],
			invocationId: "cli-1",
		});
		expect(status.kind).toBe("ok");
		if (status.kind !== "ok") {
			throw new Error(`expected ok, got ${status.kind}`);
		}
		expect(status.plan.commandKind).toBe("status");
		expect(status.plan.argv).toEqual(["mu", "status", "--json"]);

		const issueGet = surface.build({
			commandKey: "issue get",
			args: ["mu-abcd1234"],
			invocationId: "cli-2",
		});
		expect(issueGet.kind).toBe("ok");
		if (issueGet.kind !== "ok") {
			throw new Error(`expected ok, got ${issueGet.kind}`);
		}
		expect(issueGet.plan.commandKind).toBe("issue_get");
		expect(issueGet.plan.argv).toEqual(["mu", "issues", "get", "mu-abcd1234"]);

		const rejectFlag = surface.build({
			commandKey: "issue get",
			args: ["--raw-stream"],
			invocationId: "cli-3",
		});
		expect(rejectFlag).toMatchObject({ kind: "reject", reason: "cli_validation_failed" });

		const operatorSet = surface.build({
			commandKey: "operator model set",
			args: ["openai-codex", "gpt-5.3-codex", "xhigh"],
			invocationId: "cli-op-1",
		});
		expect(operatorSet.kind).toBe("ok");
		if (operatorSet.kind !== "ok") {
			throw new Error(`expected ok, got ${operatorSet.kind}`);
		}
		expect(operatorSet.plan.commandKind).toBe("operator_model_set");
		expect(operatorSet.plan.mutating).toBe(true);
		expect(operatorSet.plan.argv).toEqual([
			"mu",
			"control",
			"operator",
			"set",
			"openai-codex",
			"gpt-5.3-codex",
			"xhigh",
			"--json",
		]);

		const operatorThinking = surface.build({
			commandKey: "operator thinking list",
			args: ["openai-codex", "gpt-5.3-codex"],
			invocationId: "cli-op-2",
		});
		expect(operatorThinking.kind).toBe("ok");
		if (operatorThinking.kind !== "ok") {
			throw new Error(`expected ok, got ${operatorThinking.kind}`);
		}
		expect(operatorThinking.plan.commandKind).toBe("operator_thinking_list");
		expect(operatorThinking.plan.argv).toEqual([
			"mu",
			"control",
			"operator",
			"thinking",
			"openai-codex",
			"gpt-5.3-codex",
			"--json",
		]);

		const unknown = surface.build({
			commandKey: "shell exec",
			args: ["rm", "-rf", "/"],
			invocationId: "cli-6",
		});
		expect(unknown).toEqual({ kind: "skip" });
	});
});
