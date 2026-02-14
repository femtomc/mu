import { expect, test } from "bun:test";
import { run } from "@mu/cli";

test("run --help", () => {
	expect(run(["--help"]).includes("Usage:")).toBe(true);
});
