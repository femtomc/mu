import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OPERATOR_SYSTEM_PROMPT,
	DEFAULT_ORCHESTRATOR_PROMPT,
	DEFAULT_REVIEWER_PROMPT,
	DEFAULT_WORKER_PROMPT,
} from "@femtomc/mu-agent";

describe("role prompts are CLI-first", () => {
	test("orchestrator prompt uses mu CLI workflow", () => {
		expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("mu issues get <id>");
		expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("mu issues create");
		expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("mu context search");
		expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("mu context index status");
		expect(DEFAULT_ORCHESTRATOR_PROMPT).not.toContain("query({");
		expect(DEFAULT_ORCHESTRATOR_PROMPT).not.toContain("command({");
	});

	test("worker prompt uses mu CLI workflow", () => {
		expect(DEFAULT_WORKER_PROMPT).toContain("mu issues get <id>");
		expect(DEFAULT_WORKER_PROMPT).toContain("mu issues close <id>");
		expect(DEFAULT_WORKER_PROMPT).toContain("mu context search");
		expect(DEFAULT_WORKER_PROMPT).toContain("mu context index status");
		expect(DEFAULT_WORKER_PROMPT).not.toContain("query({");
		expect(DEFAULT_WORKER_PROMPT).not.toContain("command({");
	});

	test("reviewer prompt uses mu CLI workflow", () => {
		expect(DEFAULT_REVIEWER_PROMPT).toContain("mu issues get <id>");
		expect(DEFAULT_REVIEWER_PROMPT).toContain("mu forum post issue:<id>");
		expect(DEFAULT_REVIEWER_PROMPT).toContain("mu context search");
		expect(DEFAULT_REVIEWER_PROMPT).toContain("mu context timeline");
		expect(DEFAULT_REVIEWER_PROMPT).not.toContain("query({");
		expect(DEFAULT_REVIEWER_PROMPT).not.toContain("command({");
	});

	test("operator prompt uses bash + mu CLI patterns", () => {
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu status --pretty");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu runs start");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu context search");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu context index status");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).not.toContain("query({");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).not.toContain("command({");
	});
});
