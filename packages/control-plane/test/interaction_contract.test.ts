import { describe, expect, test } from "bun:test";
import {
	type CommandRecord,
	ControlPlaneInteractionMessageSchema,
	createAcceptedCommandRecord,
	formatAdapterAckMessage,
	type InboundEnvelope,
	presentPipelineResultMessage,
	stableSerializeJson,
	transitionCommandRecord,
} from "@femtomc/mu-control-plane";

function mkInbound(text: string): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 1_000,
		request_id: "req-contract-1",
		delivery_id: "delivery-contract-1",
		channel: "slack",
		channel_tenant_id: "team-1",
		channel_conversation_id: "chan-1",
		actor_id: "actor-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: "/tmp/mu-contract-test",
		command_text: text,
		scope_required: "cp.read",
		scope_effective: "cp.read",
		target_type: "status",
		target_id: "chan-1",
		idempotency_key: "idem-contract-1",
		fingerprint: "fp-contract-1",
		metadata: {},
	};
}

function mkAwaitingConfirmationCommand(): CommandRecord {
	const accepted = createAcceptedCommandRecord({
		commandId: "cmd-contract-await",
		inbound: mkInbound("/mu issue close mu-42"),
		nowMs: 1_000,
	});
	return transitionCommandRecord(accepted, {
		nextState: "awaiting_confirmation",
		nowMs: 1_050,
		confirmationExpiresAtMs: 2_000,
	});
}

function mkCompletedCliCommand(): CommandRecord {
	const accepted = createAcceptedCommandRecord({
		commandId: "cmd-contract-complete",
		inbound: {
			...mkInbound("/mu run resume mu-root-1"),
			target_type: "run resume",
			target_id: "mu-root-1",
			scope_required: "cp.run.execute",
			scope_effective: "cp.run.execute",
		},
		nowMs: 1_000,
		operatorSessionId: "operator-session-1",
		operatorTurnId: "operator-turn-1",
	});
	const queued = transitionCommandRecord(accepted, {
		nextState: "queued",
		nowMs: 1_010,
		errorCode: null,
	});
	const inProgress = transitionCommandRecord(queued, {
		nextState: "in_progress",
		nowMs: 1_020,
		errorCode: null,
		cliInvocationId: "cli-1",
		cliCommandKind: "run_resume",
		runRootId: "mu-root-1",
	});
	return transitionCommandRecord(inProgress, {
		nextState: "completed",
		nowMs: 1_030,
		errorCode: null,
		cliInvocationId: "cli-1",
		cliCommandKind: "run_resume",
		runRootId: "mu-root-1",
		result: {
			z: 1,
			a: {
				d: 4,
				c: 3,
			},
		},
	});
}

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

	test("awaiting confirmation messages include lifecycle transition and actions", () => {
		const command = mkAwaitingConfirmationCommand();
		const presented = presentPipelineResultMessage({
			kind: "awaiting_confirmation",
			command,
		});

		const parsed = ControlPlaneInteractionMessageSchema.parse(presented.message);
		expect(parsed.speaker).toBe("mu_system");
		expect(parsed.intent).toBe("lifecycle");
		expect(parsed.state).toBe("awaiting_confirmation");
		expect(parsed.actions).toEqual([
			{ label: "Confirm", command: `/mu confirm ${command.command_id}`, kind: "primary" },
			{ label: "Cancel", command: `/mu cancel ${command.command_id}`, kind: "secondary" },
		]);

		expect(presented.compact).toContain("LIFECYCLE · AWAITING CONFIRMATION");
		expect(presented.compact).toContain(`/mu confirm ${command.command_id}`);
		expect(presented.detailed).toContain("transition: ACCEPTED → AWAITING CONFIRMATION");
		expect(presented.detailed).toContain("Payload (structured; can be collapsed in rich clients):");
	});

	test("completed CLI messages are attributed to mu tools and preserve sortable payload", () => {
		const command = mkCompletedCliCommand();
		const presented = presentPipelineResultMessage({
			kind: "completed",
			command,
		});

		expect(presented.message.speaker).toBe("mu_tool");
		expect(presented.message.intent).toBe("result");
		expect(presented.compact).toContain("RESULT · COMPLETED");
		expect(presented.detailed).toContain("CLI command: run_resume");
		const resultPayload = presented.message.payload.result as Record<string, unknown>;
		expect(stableSerializeJson(resultPayload)).toBe('{"a":{"c":3,"d":4},"z":1}');
	});

	test("adapter ACK formatting appends deferred-delivery notice", () => {
		const ack = formatAdapterAckMessage(
			{
				kind: "denied",
				reason: "missing_scope",
			},
			{ deferred: true },
		);
		expect(ack).toContain("ERROR · DENIED");
		expect(ack).toContain("missing_scope");
		expect(ack).toContain("Delivery: detailed update queued via outbox");
	});
});
