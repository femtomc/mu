import { describe, expect, test } from "bun:test";
import * as controlPlane from "@femtomc/mu-control-plane";
import { ChannelSchema, channelFromString, DEFAULT_CONTROL_PLANE_POLICY } from "@femtomc/mu-control-plane";

describe("first-platform channel scope", () => {
	test("Slack/Discord/Telegram are active channels and iMessage is unsupported", () => {
		expect(ChannelSchema.safeParse("slack").success).toBe(true);
		expect(ChannelSchema.safeParse("discord").success).toBe(true);
		expect(ChannelSchema.safeParse("telegram").success).toBe(true);
		expect(ChannelSchema.safeParse("imessage").success).toBe(false);
		expect(channelFromString("imessage")).toBeNull();
		expect(Object.keys(DEFAULT_CONTROL_PLANE_POLICY.ops.channels).sort()).toEqual(["discord", "slack", "telegram", "terminal"]);
	});

	test("iMessage adapter is not exported by first-platform runtime", () => {
		expect("IMessageControlPlaneAdapter" in controlPlane).toBe(false);
	});
});
