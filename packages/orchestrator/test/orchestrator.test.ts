import { expect, test } from "bun:test";
import { orchestratorHello } from "@mu/orchestrator";

test("orchestratorHello", () => {
	expect(orchestratorHello()).toBe("orchestrator(forum,issue)");
});
