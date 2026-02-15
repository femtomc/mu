import { describe, expect, test } from "bun:test";
import { executionSpecFromDict } from "@femtomc/mu-core/node";

describe("executionSpecFromDict", () => {
	test("empty dict", () => {
		const spec = executionSpecFromDict({});
		expect(spec.role).toBeNull();
	});

	test("role parsed", () => {
		const spec = executionSpecFromDict({ role: "worker" });
		expect(spec.role).toBe("worker");
	});

	test("ignores unknown fields", () => {
		const spec = executionSpecFromDict({
			role: "worker",
			cli: "pi",
			model: "gpt-5.3-codex",
			reasoning: "xhigh",
			prompt_path: "/tmp/role.md",
		});
		expect(spec.role).toBe("worker");
	});

	test("empty string role becomes null", () => {
		const spec = executionSpecFromDict({ role: "" });
		expect(spec.role).toBeNull();
	});
});

