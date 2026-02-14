import { expect, test } from "bun:test";
import { forumHello } from "@mu/forum";

test("forumHello", () => {
	expect(forumHello()).toBe("forum");
});
