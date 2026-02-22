import { describe, expect, test } from "bun:test";
import {
	ControlPlaneInteractionMessageSchema,
	formatAdapterAckMessage,
	presentPipelineResultMessage,
	stableSerializeJson,
} from "@femtomc/mu-control-plane";

describe("interaction contract presentation", () => {
	test("stable JSON serialization is deterministic", () => {
		const serialized = stableSerializeJson({
			z: 1,
			a: {
				d: 4,
				c: 3,
			},
			arr: [{ z: 2, y: 1 }],
		});
		expect(serialized).toBe('{"a":{"c":3,"d":4},"arr":[{"y":1,"z":2}],"z":1}');
	});

	test("operator chat messages keep deterministic chat semantics", () => {
		const presented = presentPipelineResultMessage({
			kind: "operator_response",
			message: "hello from operator\nwith context",
		});
		const parsed = ControlPlaneInteractionMessageSchema.parse(presented.message);
		expect(parsed.speaker).toBe("operator");
		expect(parsed.intent).toBe("chat");
		expect(parsed.state).toBe("responded");
		expect(presented.compact).toContain("CHAT · RESPONDED");
		expect(presented.detailed).toContain("Message:");
		expect(presented.detailed).toContain("hello from operator");
	});

	test("adapter ACK formatting appends deferred-delivery notice", () => {
		const ack = formatAdapterAckMessage(
			{
				kind: "denied",
				reason: "identity_not_linked",
			},
			{ deferred: true },
		);
		expect(ack).toContain("ERROR · DENIED");
		expect(ack).toContain("identity_not_linked");
		expect(ack).toContain("Delivery: update queued via outbox");
	});
});
