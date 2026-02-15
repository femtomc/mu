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

	test("review defaults to false", () => {
		const spec = executionSpecFromDict({ role: "worker" });
		expect(spec.review).toBe(false);
	});

	test("review can be set to true", () => {
		const spec = executionSpecFromDict({ role: "worker", review: true });
		expect(spec.review).toBe(true);
	});

	test("review can be explicitly set to false", () => {
		const spec = executionSpecFromDict({ role: "worker", review: false });
		expect(spec.review).toBe(false);
	});

	test("non-boolean review values default to false", () => {
		const spec1 = executionSpecFromDict({ role: "worker", review: "yes" });
		expect(spec1.review).toBe(false);

		const spec2 = executionSpecFromDict({ role: "worker", review: 1 });
		expect(spec2.review).toBe(false);

		const spec3 = executionSpecFromDict({ role: "worker", review: null });
		expect(spec3.review).toBe(false);
	});
});

