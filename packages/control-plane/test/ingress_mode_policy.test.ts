import { describe, expect, test } from "bun:test";
import {
	allowsConversationalIngressForInbound,
	CONVERSATIONAL_INGRESS_OVERRIDE_KEY,
} from "@femtomc/mu-control-plane";

describe("ingress mode policy conversational override", () => {
	test("keeps strict defaults for command-only channels", () => {
		expect(allowsConversationalIngressForInbound("neovim", {})).toBe(false);
		expect(allowsConversationalIngressForInbound("terminal", { [CONVERSATIONAL_INGRESS_OVERRIDE_KEY]: true })).toBe(false);
	});

	test("allows explicit per-inbound metadata override for command-only channels", () => {
		expect(
			allowsConversationalIngressForInbound("slack", {
				[CONVERSATIONAL_INGRESS_OVERRIDE_KEY]: "allow",
			}),
		).toBe(true);
	});

	test("conversational channels remain conversational without metadata", () => {
		expect(allowsConversationalIngressForInbound("telegram", {})).toBe(true);
	});
});
