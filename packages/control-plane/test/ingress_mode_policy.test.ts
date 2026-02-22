import { describe, expect, test } from "bun:test";
import {
	allowsConversationalIngressForInbound,
	CONVERSATIONAL_INGRESS_OVERRIDE_KEY,
} from "@femtomc/mu-control-plane";

describe("ingress mode policy", () => {
	test("all first-party channels are conversational by default", () => {
		expect(allowsConversationalIngressForInbound("slack", {})).toBe(true);
		expect(allowsConversationalIngressForInbound("discord", {})).toBe(true);
		expect(allowsConversationalIngressForInbound("telegram", {})).toBe(true);
		expect(allowsConversationalIngressForInbound("neovim", {})).toBe(true);
		expect(allowsConversationalIngressForInbound("terminal", {})).toBe(true);
	});

	test("explicit override metadata remains accepted for compatibility", () => {
		expect(
			allowsConversationalIngressForInbound("terminal", {
				[CONVERSATIONAL_INGRESS_OVERRIDE_KEY]: "allow",
			}),
		).toBe(true);
	});
});
