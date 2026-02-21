import { describe, expect, test } from "bun:test";
import { DEFAULT_OPERATOR_SYSTEM_PROMPT } from "@femtomc/mu-agent";

describe("operator prompt is CLI-first", () => {
	test("operator prompt uses bash + mu CLI patterns", () => {
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu --help");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu memory search|timeline|stats");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu memory index status|rebuild");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu heartbeats");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).toContain("mu cron");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).not.toContain("query({");
		expect(DEFAULT_OPERATOR_SYSTEM_PROMPT).not.toContain("command({");
	});
});
