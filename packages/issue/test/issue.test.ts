import { expect, test } from "bun:test";
import { issueHello } from "@mu/issue";

test("issueHello", () => {
	expect(issueHello()).toBe("issue");
});
