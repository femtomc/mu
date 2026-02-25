import { describe, expect, test } from "bun:test";
import { allowsConversationalIngressForInbound } from "@femtomc/mu-control-plane";

describe("ingress mode policy", () => {
	test("all first-party channels are conversational by default", () => {
		expect(allowsConversationalIngressForInbound("slack")).toBe(true);
		expect(allowsConversationalIngressForInbound("discord")).toBe(true);
		expect(allowsConversationalIngressForInbound("telegram")).toBe(true);
		expect(allowsConversationalIngressForInbound("neovim")).toBe(true);
		expect(allowsConversationalIngressForInbound("terminal")).toBe(true);
	});

	test("unknown channels remain command-only", () => {
		expect(allowsConversationalIngressForInbound("custom-channel")).toBe(false);
	});
});
