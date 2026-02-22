import { describe, expect, test } from "bun:test";
import {
	buildSlackProgressActionBlocks,
	formatSlackWorkingHeartbeat,
	parseSlackActionPayload,
	SLACK_CANCEL_ACTION_ID,
} from "../src/adapters/slack.js";

describe("Slack progress heartbeat formatting", () => {
	test("includes request summary and elapsed time for early ticks", () => {
		const heartbeat = formatSlackWorkingHeartbeat({
			commandText: "What was the error?",
			elapsedMs: 4_000,
		});
		expect(heartbeat.stage).toBe("working_heartbeat.analyzing");
		expect(heartbeat.text).toContain("Phase: Analyzing the request");
		expect(heartbeat.text).toContain("Request: What was the error?");
		expect(heartbeat.text).toContain("Elapsed: 4s");
	});

	test("adds delayed-run guidance after long execution", () => {
		const heartbeat = formatSlackWorkingHeartbeat({
			commandText: "This is a very long request that should still render with a compact preview for progress updates.",
			elapsedMs: 8 * 60 * 1_000,
		});
		expect(heartbeat.stage).toBe("working_heartbeat.delayed");
		expect(heartbeat.text).toContain("This is taking longer than expected");
		expect(heartbeat.text).toContain("run `/mu status` in parallel");
		expect(heartbeat.text).toContain("cancel` / `/mu cancel`");
		expect(heartbeat.text).toContain("Elapsed: 480s");
	});

	test("renders status text plus cancel button blocks for progress anchors", () => {
		const blocks = buildSlackProgressActionBlocks("INFO mu · ACK · WORKING\nElapsed: 3s");
		expect(blocks).toHaveLength(2);
		const sectionBlock = blocks[0] as Record<string, unknown>;
		expect(sectionBlock.type).toBe("section");
		const sectionText = sectionBlock.text as Record<string, unknown>;
		expect(sectionText.type).toBe("mrkdwn");
		expect(sectionText.text).toContain("Elapsed: 3s");
		const actionBlock = blocks[1] as Record<string, unknown>;
		expect(actionBlock.type).toBe("actions");
		const elements = actionBlock.elements as Array<Record<string, unknown>>;
		expect(elements).toHaveLength(1);
		expect(elements[0]?.action_id).toBe(SLACK_CANCEL_ACTION_ID);
	});

	test("parses cancel button block-action payload", () => {
		const parsed = parseSlackActionPayload(
			JSON.stringify({
				type: "block_actions",
				team: { id: "T123" },
				channel: { id: "C456" },
				user: { id: "U789", team_id: "T123" },
				trigger_id: "trigger-1",
				container: { message_ts: "1771783328.941729", channel_id: "C456" },
				message: { ts: "1771783328.941729", thread_ts: "1771767604.829589" },
				actions: [{ action_id: SLACK_CANCEL_ACTION_ID, action_ts: "1771783330.000001" }],
			}),
		);
		expect(parsed.kind).toBe("cancel_turn");
		if (parsed.kind !== "cancel_turn") {
			throw new Error(`expected cancel_turn parse, got ${parsed.kind}`);
		}
		expect(parsed.payload.teamId).toBe("T123");
		expect(parsed.payload.channelId).toBe("C456");
		expect(parsed.payload.actorId).toBe("U789");
		expect(parsed.payload.threadTs).toBe("1771767604.829589");
	});
});
