import { describe, expect, test } from "bun:test";
import {
	CommandStateSchema,
	canTransition,
	createAcceptedCommandRecord,
	type InboundEnvelope,
	InvalidCommandTransitionError,
	transitionCommandRecord,
} from "@femtomc/mu-control-plane";

function mkInbound(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 100,
		request_id: "req-1",
		delivery_id: "delivery-1",
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_conversation_id: "conv-1",
		actor_id: "actor-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: "/repo",
		command_text: "issue close mu-123",
		scope_required: "cp.issue.write",
		scope_effective: "cp.issue.write",
		target_type: "issue",
		target_id: "mu-123",
		idempotency_key: "idem-1",
		fingerprint: "fingerprint-1",
		metadata: {},
		...overrides,
	};
}

describe("command state machine", () => {
	test("valid transitions succeed and track attempt/terminal fields", () => {
		const accepted = createAcceptedCommandRecord({ commandId: "cmd-1", inbound: mkInbound(), nowMs: 10 });
		expect(accepted.state).toBe("accepted");
		expect(accepted.attempt).toBe(0);

		const queued = transitionCommandRecord(accepted, { nextState: "queued", nowMs: 20 });
		expect(queued.state).toBe("queued");
		expect(queued.attempt).toBe(0);

		const inProgress = transitionCommandRecord(queued, { nextState: "in_progress", nowMs: 30 });
		expect(inProgress.state).toBe("in_progress");
		expect(inProgress.attempt).toBe(1);

		const completed = transitionCommandRecord(inProgress, {
			nextState: "completed",
			nowMs: 40,
			result: { ok: true },
		});
		expect(completed.state).toBe("completed");
		expect(completed.terminal_at_ms).toBe(40);
		expect(completed.error_code).toBeNull();
		expect(completed.result).toEqual({ ok: true });
	});

	test("non-terminal retry path supports deferred -> queued", () => {
		const accepted = createAcceptedCommandRecord({ commandId: "cmd-2", inbound: mkInbound(), nowMs: 10 });
		const queued = transitionCommandRecord(accepted, { nextState: "queued", nowMs: 20 });
		const inProgress = transitionCommandRecord(queued, { nextState: "in_progress", nowMs: 30 });
		const deferred = transitionCommandRecord(inProgress, {
			nextState: "deferred",
			nowMs: 40,
			retryAtMs: 100,
			errorCode: "backpressure",
		});
		const queuedAgain = transitionCommandRecord(deferred, { nextState: "queued", nowMs: 101, retryAtMs: null });

		expect(deferred.state).toBe("deferred");
		expect(deferred.retry_at_ms).toBe(100);
		expect(queuedAgain.state).toBe("queued");
		expect(queuedAgain.retry_at_ms).toBeNull();
	});

	test("invalid transitions fail", () => {
		const accepted = createAcceptedCommandRecord({ commandId: "cmd-3", inbound: mkInbound(), nowMs: 10 });
		expect(canTransition("accepted", "completed")).toBe(false);
		expect(() => transitionCommandRecord(accepted, { nextState: "completed", nowMs: 20 })).toThrow(
			InvalidCommandTransitionError,
		);

		const terminal = transitionCommandRecord(transitionCommandRecord(accepted, { nextState: "queued", nowMs: 20 }), {
			nextState: "cancelled",
			nowMs: 30,
		});
		expect(() => transitionCommandRecord(terminal, { nextState: "queued", nowMs: 40 })).toThrow(
			InvalidCommandTransitionError,
		);
	});

	test("state schema includes all expected states", () => {
		expect(CommandStateSchema.options).toEqual([
			"accepted",
			"awaiting_confirmation",
			"queued",
			"in_progress",
			"deferred",
			"completed",
			"failed",
			"cancelled",
			"expired",
			"dead_letter",
		]);
	});
});
