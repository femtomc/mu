import { describe, expect, test } from "bun:test";
import * as controlPlane from "@femtomc/mu-control-plane";
import { ChannelSchema, ingressModeForValue } from "@femtomc/mu-control-plane";

describe("first-platform channel scope", () => {
	test("Slack/Discord/Telegram/Neovim/Terminal are supported and iMessage is unsupported", () => {
		expect(ChannelSchema.safeParse("slack").success).toBe(true);
		expect(ChannelSchema.safeParse("discord").success).toBe(true);
		expect(ChannelSchema.safeParse("telegram").success).toBe(true);
		expect(ChannelSchema.safeParse("neovim").success).toBe(true);
		expect(ChannelSchema.safeParse("terminal").success).toBe(true);
		expect(ChannelSchema.safeParse("imessage").success).toBe(false);
		expect(ingressModeForValue("imessage")).toBe("command_only");
	});

	test("iMessage adapter is not exported by first-platform runtime", () => {
		expect("IMessageControlPlaneAdapter" in controlPlane).toBe(false);
	});
});
