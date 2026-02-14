import { expect, test } from "bun:test";
import { slackBotHello } from "@mu/slack-bot";

test("slackBotHello", () => {
	expect(slackBotHello()).toBe("slack-bot(orchestrator(forum,issue))");
});
