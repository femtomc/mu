import { describe, expect, test } from "bun:test";
import {
	createSessionService,
	SessionService,
	type SessionCommand,
	type SessionResponse,
	type SessionEvent,
	type DispatchResult,
	type QueueReceiptResponse,
	type DequeueAckResponse,
	type InterruptAckResponse,
	type ContextResponse,
	type AckResponse,
	type SessionServiceListener,
} from "../src/session_service.js";
import {
	assembleAssertionSet,
	projectLeafId,
	projectModelState,
	projectBranchState,
	projectCompactionState,
	diagnoseAssertionSet,
	type SessionAssertionSet,
} from "../src/session_projection.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testClock(start: number = 1000) {
	let time = start;
	return {
		now_ms: () => {
			time += 1;
			return time;
		},
		current: () => time,
	};
}

function testTurnIdGenerator(prefix: string = "t") {
	let counter = 0;
	return () => {
		counter += 1;
		return `${prefix}-${counter}`;
	};
}

function createTestService(overrides?: {
	session_id?: string;
	max_queue_depth?: number;
	clock?: ReturnType<typeof testClock>;
	context_messages?: ReadonlyArray<unknown>;
}) {
	const clock = overrides?.clock ?? testClock();
	const session_id = overrides?.session_id ?? "test-session-1";
	return createSessionService(session_id, {
		max_queue_depth: overrides?.max_queue_depth ?? 64,
		now_ms: clock.now_ms,
		generate_turn_id: testTurnIdGenerator(`turn-${session_id}`),
		context_provider: overrides?.context_messages
			? () => overrides.context_messages!
			: null,
	});
}

function openService(svc: SessionService): DispatchResult {
	return svc.dispatch({
		kind: "session.open",
		session_id: svc.session_id,
		mode: "memory",
	});
}

function attachService(svc: SessionService): DispatchResult {
	return svc.attach();
}

function openAndAttach(svc: SessionService): void {
	openService(svc);
	attachService(svc);
}

function enqueuePrompt(svc: SessionService, body: string): DispatchResult {
	return svc.dispatch({
		kind: "session.enqueue",
		session_id: svc.session_id,
		turn_kind: "prompt",
		body,
	});
}

function enqueueSteer(svc: SessionService, body: string): DispatchResult {
	return svc.dispatch({
		kind: "session.enqueue",
		session_id: svc.session_id,
		turn_kind: "steer",
		body,
	});
}

function enqueueFollowUp(svc: SessionService, body: string): DispatchResult {
	return svc.dispatch({
		kind: "session.enqueue",
		session_id: svc.session_id,
		turn_kind: "follow_up",
		body,
	});
}

function enqueueAbort(svc: SessionService): DispatchResult {
	return svc.dispatch({
		kind: "session.enqueue",
		session_id: svc.session_id,
		turn_kind: "abort",
		body: "",
	});
}

function dequeue(svc: SessionService): DispatchResult {
	return svc.dispatch({
		kind: "session.dequeue",
		session_id: svc.session_id,
	});
}

function interrupt(svc: SessionService, reason: string): DispatchResult {
	return svc.dispatch({
		kind: "session.interrupt",
		session_id: svc.session_id,
		reason,
	});
}

function closeService(svc: SessionService, reason: string): DispatchResult {
	return svc.dispatch({
		kind: "session.close",
		session_id: svc.session_id,
		reason,
	});
}

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe("session service lifecycle", () => {
	test("creates in 'created' phase with all 6 assertions initialized", () => {
		const svc = createTestService();
		expect(svc.phase()).toBe("created");
		expect(svc.isActive()).toBe(false);

		const assertions = svc.assertions();
		expect(assertions.lifecycle).not.toBeNull();
		expect(assertions.lifecycle!.phase).toBe("created");
		expect(assertions.lifecycle!.session_id).toBe("test-session-1");
		expect(assertions.queue_state).not.toBeNull();
		expect(assertions.queue_state!.pending_count).toBe(0);
		expect(assertions.model_state).not.toBeNull();
		expect(assertions.model_state!.thinking_level).toBe("off");
		expect(assertions.compaction_state).not.toBeNull();
		expect(assertions.dag_anchor).not.toBeNull();
		expect(assertions.event_anchor).not.toBeNull();
	});

	test("open transitions from created to open", () => {
		const svc = createTestService();
		const result = openService(svc);

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("open");
		expect(svc.isActive()).toBe(true);
		expect(result.events.length).toBe(1);
		expect(result.events[0]!.event_kind).toBe("session_opened");
	});

	test("open with persist mode sets mode in lifecycle", () => {
		const svc = createTestService();
		const result = svc.dispatch({
			kind: "session.open",
			session_id: svc.session_id,
			mode: "persist",
		});

		expect(result.ok).toBe(true);
		expect(svc.assertions().lifecycle!.mode).toBe("persist");
	});

	test("open rejects invalid mode", () => {
		const svc = createTestService();
		const result = svc.dispatch({
			kind: "session.open",
			session_id: svc.session_id,
			mode: "invalid" as any,
		});

		expect(result.ok).toBe(false);
		expect(svc.phase()).toBe("created");
	});

	test("open rejects if already open", () => {
		const svc = createTestService();
		openService(svc);
		const result = openService(svc);

		expect(result.ok).toBe(false);
		expect(svc.phase()).toBe("open");
	});

	test("attach transitions from open to attached", () => {
		const svc = createTestService();
		openService(svc);
		const result = attachService(svc);

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("attached");
		expect(svc.isActive()).toBe(true);
		expect(result.events.length).toBe(1);
		expect(result.events[0]!.event_kind).toBe("session_attached");
	});

	test("attach rejects if not open", () => {
		const svc = createTestService();
		const result = attachService(svc);

		expect(result.ok).toBe(false);
		expect(svc.phase()).toBe("created");
	});

	test("detach transitions from attached to open", () => {
		const svc = createTestService();
		openAndAttach(svc);
		const result = svc.detach();

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("open");
		expect(svc.isActive()).toBe(true);
	});

	test("detach rejects if not attached", () => {
		const svc = createTestService();
		openService(svc);
		const result = svc.detach();

		expect(result.ok).toBe(false);
		expect(svc.phase()).toBe("open");
	});

	test("close from open phase", () => {
		const svc = createTestService();
		openService(svc);
		const result = closeService(svc, "user_requested");

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("closed");
		expect(svc.isActive()).toBe(false);
	});

	test("close from attached phase", () => {
		const svc = createTestService();
		openAndAttach(svc);
		const result = closeService(svc, "timeout");

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("closed");
	});

	test("close from created phase", () => {
		const svc = createTestService();
		const result = closeService(svc, "cancelled");

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("closed");
	});

	test("close is idempotent when already closed", () => {
		const svc = createTestService();
		openService(svc);
		closeService(svc, "first");
		const result = closeService(svc, "second");

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("closed");
		// Idempotent: no new events
		expect(result.events.length).toBe(0);
	});

	test("error transitions to error phase", () => {
		const svc = createTestService();
		openService(svc);
		const result = svc.error({ message: "backend failure" });

		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("error");
		expect(result.events.length).toBe(1);
		expect(result.events[0]!.event_kind).toBe("session_error");
	});

	test("error rejects from closed phase", () => {
		const svc = createTestService();
		openService(svc);
		closeService(svc, "done");
		const result = svc.error({ message: "too late" });

		expect(result.ok).toBe(false);
		expect(svc.phase()).toBe("closed");
	});

	test("error clears queue", () => {
		const svc = createTestService();
		openAndAttach(svc);
		enqueuePrompt(svc, "hello");
		enqueuePrompt(svc, "world");

		expect(svc.queueDepth()).toBe(2);

		svc.error({ message: "crash" });

		expect(svc.queueDepth()).toBe(0);
		expect(svc.activeTurn()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Queue semantics tests
// ---------------------------------------------------------------------------

describe("session service queue semantics", () => {
	test("enqueue adds turns in FIFO order", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "first");
		enqueueSteer(svc, "second");
		enqueueFollowUp(svc, "third");

		expect(svc.queueDepth()).toBe(3);

		const pending = svc.pendingTurns();
		expect(pending[0]!.kind).toBe("prompt");
		expect(pending[0]!.body).toBe("first");
		expect(pending[1]!.kind).toBe("steer");
		expect(pending[1]!.body).toBe("second");
		expect(pending[2]!.kind).toBe("follow_up");
		expect(pending[2]!.body).toBe("third");
	});

	test("dequeue returns turns in FIFO order", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "first");
		enqueuePrompt(svc, "second");

		const r1 = dequeue(svc);
		expect(r1.ok).toBe(true);
		const d1 = r1.response as DequeueAckResponse;
		expect(d1.kind).toBe("session.dequeue_ack");
		expect(d1.body).toBe("first");
		expect(d1.empty).toBe(false);

		// Complete the active turn before dequeuing next
		svc.completeActiveTurn();

		const r2 = dequeue(svc);
		expect(r2.ok).toBe(true);
		const d2 = r2.response as DequeueAckResponse;
		expect(d2.body).toBe("second");
	});

	test("dequeue returns empty when queue is empty", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = dequeue(svc);
		expect(result.ok).toBe(true);
		const resp = result.response as DequeueAckResponse;
		expect(resp.empty).toBe(true);
		expect(resp.turn_id).toBeNull();
	});

	test("enqueue rejects when session is not active", () => {
		const svc = createTestService();
		const result = enqueuePrompt(svc, "hello");

		expect(result.ok).toBe(false);
		const resp = result.response as QueueReceiptResponse;
		expect(resp.accepted).toBe(false);
	});

	test("enqueue rejects invalid turn_kind", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.enqueue",
			session_id: svc.session_id,
			turn_kind: "invalid" as any,
			body: "hello",
		});

		expect(result.ok).toBe(false);
		const resp = result.response as QueueReceiptResponse;
		expect(resp.accepted).toBe(false);
	});

	test("enqueue receipt includes turn_id and position", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const r1 = enqueuePrompt(svc, "first");
		const receipt1 = r1.response as QueueReceiptResponse;
		expect(receipt1.accepted).toBe(true);
		expect(receipt1.turn_id).toMatch(/^turn-/);
		expect(receipt1.position).toBe(0);

		const r2 = enqueuePrompt(svc, "second");
		const receipt2 = r2.response as QueueReceiptResponse;
		expect(receipt2.position).toBe(1);

		// Turn IDs are unique
		expect(receipt1.turn_id).not.toBe(receipt2.turn_id);
	});

	test("queue state assertion updates with enqueue/dequeue", () => {
		const svc = createTestService();
		openAndAttach(svc);

		expect(svc.assertions().queue_state!.pending_count).toBe(0);
		expect(svc.assertions().queue_state!.active_turn_id).toBeNull();

		enqueuePrompt(svc, "hello");
		expect(svc.assertions().queue_state!.pending_count).toBe(1);

		dequeue(svc);
		expect(svc.assertions().queue_state!.pending_count).toBe(0);
		expect(svc.assertions().queue_state!.active_turn_id).not.toBeNull();

		svc.completeActiveTurn();
		expect(svc.assertions().queue_state!.active_turn_id).toBeNull();
		expect(svc.assertions().queue_state!.completed_count).toBe(1);
	});

	test("fair cursor increments monotonically on dequeue", () => {
		const svc = createTestService();
		openAndAttach(svc);

		expect(svc.assertions().queue_state!.fair_cursor).toBe(0);

		enqueuePrompt(svc, "a");
		dequeue(svc);
		expect(svc.assertions().queue_state!.fair_cursor).toBe(1);

		svc.completeActiveTurn();

		enqueuePrompt(svc, "b");
		dequeue(svc);
		expect(svc.assertions().queue_state!.fair_cursor).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Queue limit tests
// ---------------------------------------------------------------------------

describe("session service queue limits", () => {
	test("rejects enqueue when queue is full", () => {
		const svc = createTestService({ max_queue_depth: 3 });
		openAndAttach(svc);

		enqueuePrompt(svc, "1");
		enqueuePrompt(svc, "2");
		enqueuePrompt(svc, "3");

		const result = enqueuePrompt(svc, "4");
		expect(result.ok).toBe(false);
		const resp = result.response as QueueReceiptResponse;
		expect(resp.accepted).toBe(false);
		expect(resp.error).toContain("queue full");

		expect(svc.queueDepth()).toBe(3);
	});

	test("can enqueue after dequeue frees space", () => {
		const svc = createTestService({ max_queue_depth: 2 });
		openAndAttach(svc);

		enqueuePrompt(svc, "1");
		enqueuePrompt(svc, "2");

		// Queue full
		expect(enqueuePrompt(svc, "3").ok).toBe(false);

		// Dequeue frees one slot
		dequeue(svc);
		svc.completeActiveTurn();

		const result = enqueuePrompt(svc, "3");
		expect(result.ok).toBe(true);
	});

	test("max_queue_depth is reflected in queue_state assertion", () => {
		const svc = createTestService({ max_queue_depth: 10 });
		expect(svc.assertions().queue_state!.max_queue_depth).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// Single-writer guarantee tests
// ---------------------------------------------------------------------------

describe("session service single-writer guarantees", () => {
	test("cannot dequeue while a turn is in-flight", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "first");
		enqueuePrompt(svc, "second");

		dequeue(svc); // first is now in-flight

		const result = dequeue(svc);
		expect(result.ok).toBe(false);
		expect(svc.activeTurn()!.body).toBe("first");
	});

	test("completeActiveTurn clears in-flight turn", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "first");
		dequeue(svc);

		expect(svc.activeTurn()).not.toBeNull();
		const result = svc.completeActiveTurn();
		expect(result.completed).toBe(true);
		expect(svc.activeTurn()).toBeNull();
	});

	test("completeActiveTurn is no-op when no turn is active", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.completeActiveTurn();
		expect(result.completed).toBe(false);
		expect(result.turn_id).toBeNull();
	});

	test("branch command implicitly completes active turn", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "hello");
		dequeue(svc);
		expect(svc.activeTurn()).not.toBeNull();

		svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-1",
			entry_count: 5,
			journal_size: 1024,
		});

		expect(svc.activeTurn()).toBeNull();
		expect(svc.assertions().queue_state!.completed_count).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Interruption semantics tests
// ---------------------------------------------------------------------------

describe("session service interruption semantics", () => {
	test("interrupt clears queue and stops active turn", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "a");
		enqueuePrompt(svc, "b");
		dequeue(svc);

		expect(svc.activeTurn()).not.toBeNull();
		expect(svc.queueDepth()).toBe(1);

		const result = interrupt(svc, "user_cancel");
		expect(result.ok).toBe(true);
		const resp = result.response as InterruptAckResponse;
		expect(resp.interrupted_turn_id).not.toBeNull();
		expect(resp.queue_cleared_count).toBe(1);

		expect(svc.activeTurn()).toBeNull();
		expect(svc.queueDepth()).toBe(0);
	});

	test("interrupt with empty queue and no active turn", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = interrupt(svc, "preemptive");
		expect(result.ok).toBe(true);
		const resp = result.response as InterruptAckResponse;
		expect(resp.interrupted_turn_id).toBeNull();
		expect(resp.queue_cleared_count).toBe(0);
	});

	test("abort enqueue clears queue and interrupts active turn", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "a");
		enqueuePrompt(svc, "b");
		dequeue(svc);

		const result = enqueueAbort(svc);
		expect(result.ok).toBe(true);

		expect(svc.activeTurn()).toBeNull();
		expect(svc.queueDepth()).toBe(0);
	});

	test("interrupt emits turn_interrupted event", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "hello");
		dequeue(svc);

		const result = interrupt(svc, "cancelled");
		const interruptEvent = result.events.find(
			(e) => e.event_kind === "turn_interrupted",
		);
		expect(interruptEvent).toBeDefined();
		expect((interruptEvent!.detail as any).reason).toBe("cancelled");
	});
});

// ---------------------------------------------------------------------------
// Model/thinking/policy toggle tests
// ---------------------------------------------------------------------------

describe("session service model and policy state", () => {
	test("set_model updates model_state assertion", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "openai",
			model_id: "gpt-5",
			thinking_level: "high",
		});

		expect(result.ok).toBe(true);
		const ms = svc.assertions().model_state!;
		expect(ms.provider).toBe("openai");
		expect(ms.model_id).toBe("gpt-5");
		expect(ms.thinking_level).toBe("high");
	});

	test("set_model rejects invalid thinking_level", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "openai",
			model_id: "gpt-5",
			thinking_level: "invalid" as any,
		});

		expect(result.ok).toBe(false);
	});

	test("set_model allowed in created phase", () => {
		const svc = createTestService();

		const result = svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "anthropic",
			model_id: "claude-4",
			thinking_level: "xhigh",
		});

		expect(result.ok).toBe(true);
		expect(svc.assertions().model_state!.provider).toBe("anthropic");
	});

	test("set_model rejects from closed phase", () => {
		const svc = createTestService();
		openService(svc);
		closeService(svc, "done");

		const result = svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "openai",
			model_id: "gpt-5",
			thinking_level: "minimal",
		});

		expect(result.ok).toBe(false);
	});

	test("set_model emits model_changed event", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "openai",
			model_id: "gpt-5",
			thinking_level: "medium",
		});

		expect(result.events.length).toBe(1);
		expect(result.events[0]!.event_kind).toBe("model_changed");
	});

	test("set_policy updates compaction_state assertion", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.set_policy",
			session_id: svc.session_id,
			auto_compact_enabled: true,
			auto_retry_enabled: true,
		});

		expect(result.ok).toBe(true);
		const cs = svc.assertions().compaction_state!;
		expect(cs.auto_compact_enabled).toBe(true);
		expect(cs.auto_retry_enabled).toBe(true);
	});

	test("set_policy emits policy_changed event", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.set_policy",
			session_id: svc.session_id,
			auto_compact_enabled: false,
			auto_retry_enabled: true,
		});

		expect(result.events.length).toBe(1);
		expect(result.events[0]!.event_kind).toBe("policy_changed");
	});

	test("set_policy allowed in created phase", () => {
		const svc = createTestService();

		const result = svc.dispatch({
			kind: "session.set_policy",
			session_id: svc.session_id,
			auto_compact_enabled: true,
			auto_retry_enabled: false,
		});

		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Branch / DAG anchor tests
// ---------------------------------------------------------------------------

describe("session service branch and dag_anchor", () => {
	test("branch updates dag_anchor assertion", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-abc",
			entry_count: 10,
			journal_size: 2048,
		});

		expect(result.ok).toBe(true);
		const da = svc.assertions().dag_anchor!;
		expect(da.leaf_id).toBe("leaf-abc");
		expect(da.entry_count).toBe(10);
		expect(da.journal_size).toBe(2048);
	});

	test("branch rejects when session is not active", () => {
		const svc = createTestService();

		const result = svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-1",
			entry_count: 1,
			journal_size: 100,
		});

		expect(result.ok).toBe(false);
	});

	test("branch emits branch_updated event", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-1",
			entry_count: 5,
			journal_size: 512,
		});

		expect(result.events.length).toBe(1);
		expect(result.events[0]!.event_kind).toBe("branch_updated");
	});
});

// ---------------------------------------------------------------------------
// Context projection tests
// ---------------------------------------------------------------------------

describe("session service context projection", () => {
	test("project_context returns context with model state", () => {
		const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
		const svc = createTestService({ context_messages: messages });
		openAndAttach(svc);

		svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "anthropic",
			model_id: "claude-4",
			thinking_level: "high",
		});

		const result = svc.dispatch({
			kind: "session.project_context",
			session_id: svc.session_id,
		});

		expect(result.ok).toBe(true);
		const resp = result.response as ContextResponse;
		expect(resp.kind).toBe("session.context");
		expect(resp.messages.length).toBe(2);
		expect(resp.thinking_level).toBe("high");
		expect(resp.model!.provider).toBe("anthropic");
		expect(resp.model!.model_id).toBe("claude-4");
	});

	test("project_context returns empty messages when no context_provider", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.project_context",
			session_id: svc.session_id,
		});

		expect(result.ok).toBe(true);
		const resp = result.response as ContextResponse;
		expect(resp.messages.length).toBe(0);
	});

	test("project_context emits context_projected event", () => {
		const svc = createTestService();
		openAndAttach(svc);

		const result = svc.dispatch({
			kind: "session.project_context",
			session_id: svc.session_id,
		});

		expect(result.events.length).toBe(1);
		expect(result.events[0]!.event_kind).toBe("context_projected");
	});
});

// ---------------------------------------------------------------------------
// Event sequencing tests
// ---------------------------------------------------------------------------

describe("session service event sequencing", () => {
	test("event_seq is monotonically increasing", () => {
		const svc = createTestService();

		const r1 = openService(svc);
		const r2 = attachService(svc);
		const r3 = enqueuePrompt(svc, "hello");

		const seqs = [
			r1.events[0]!.event_seq,
			r2.events[0]!.event_seq,
			r3.events[0]!.event_seq,
		];

		expect(seqs[0]!).toBeLessThan(seqs[1]!);
		expect(seqs[1]!).toBeLessThan(seqs[2]!);
	});

	test("event_anchor tracks latest event", () => {
		const svc = createTestService();

		openService(svc);
		expect(svc.assertions().event_anchor!.last_event_kind).toBe("session_opened");
		expect(svc.assertions().event_anchor!.event_seq).toBe(1);

		attachService(svc);
		expect(svc.assertions().event_anchor!.last_event_kind).toBe("session_attached");
		expect(svc.assertions().event_anchor!.event_seq).toBe(2);
	});

	test("timestamps are monotonic across events", () => {
		const clock = testClock();
		const svc = createTestService({ clock });
		openAndAttach(svc);

		enqueuePrompt(svc, "a");
		enqueuePrompt(svc, "b");

		// All events should have increasing timestamps
		const ea = svc.assertions().event_anchor!;
		expect(ea.last_event_at_ms).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Session ID mismatch tests
// ---------------------------------------------------------------------------

describe("session service session_id validation", () => {
	test("rejects command with wrong session_id", () => {
		const svc = createTestService({ session_id: "my-session" });

		const result = svc.dispatch({
			kind: "session.open",
			session_id: "wrong-session",
			mode: "memory",
		});

		expect(result.ok).toBe(false);
		const resp = result.response as AckResponse;
		expect(resp.error).toContain("session_id mismatch");
	});
});

// ---------------------------------------------------------------------------
// Listener notification tests
// ---------------------------------------------------------------------------

describe("session service listeners", () => {
	test("listener receives response notifications", () => {
		const svc = createTestService();
		const responses: SessionResponse[] = [];

		svc.on({
			onResponse: (r) => responses.push(r),
		});

		openService(svc);
		expect(responses.length).toBe(1);
		expect(responses[0]!.kind).toBe("session.ack");
	});

	test("listener receives event notifications", () => {
		const svc = createTestService();
		const events: SessionEvent[] = [];

		svc.on({
			onEvent: (e) => events.push(e),
		});

		openService(svc);
		expect(events.length).toBe(1);
		expect(events[0]!.event_kind).toBe("session_opened");
	});

	test("listener receives assertion change notifications", () => {
		const svc = createTestService();
		const snapshots: SessionAssertionSet[] = [];

		svc.on({
			onAssertionChange: (s) => snapshots.push(s),
		});

		openService(svc);
		expect(snapshots.length).toBe(1);
		expect(snapshots[0]!.lifecycle!.phase).toBe("open");
	});

	test("unsubscribe removes listener", () => {
		const svc = createTestService();
		const events: SessionEvent[] = [];

		const unsub = svc.on({
			onEvent: (e) => events.push(e),
		});

		openService(svc);
		expect(events.length).toBe(1);

		unsub();

		attachService(svc);
		expect(events.length).toBe(1); // no new events
	});
});

// ---------------------------------------------------------------------------
// Replay-safe transition tests
// ---------------------------------------------------------------------------

describe("session service replay-safe transitions", () => {
	test("replaying identical command sequence produces identical state", () => {
		const commands: SessionCommand[] = [
			{ kind: "session.open", session_id: "replay-test", mode: "memory" },
			{
				kind: "session.set_model",
				session_id: "replay-test",
				provider: "openai",
				model_id: "gpt-5",
				thinking_level: "high",
			},
			{
				kind: "session.set_policy",
				session_id: "replay-test",
				auto_compact_enabled: true,
				auto_retry_enabled: false,
			},
			{
				kind: "session.enqueue",
				session_id: "replay-test",
				turn_kind: "prompt",
				body: "hello world",
			},
		];

		// First run
		const clock1 = testClock(5000);
		const svc1 = createSessionService("replay-test", {
			max_queue_depth: 64,
			now_ms: clock1.now_ms,
			generate_turn_id: testTurnIdGenerator("r1"),
		});
		for (const cmd of commands) {
			svc1.dispatch(cmd);
		}

		// Second run (same clock, same id generator)
		const clock2 = testClock(5000);
		const svc2 = createSessionService("replay-test", {
			max_queue_depth: 64,
			now_ms: clock2.now_ms,
			generate_turn_id: testTurnIdGenerator("r1"),
		});
		for (const cmd of commands) {
			svc2.dispatch(cmd);
		}

		// Assertion state should be identical
		const a1 = svc1.assertions();
		const a2 = svc2.assertions();

		expect(a1.lifecycle!.phase).toBe(a2.lifecycle!.phase);
		expect(a1.lifecycle!.mode).toBe(a2.lifecycle!.mode);
		expect(a1.model_state!.provider).toBe(a2.model_state!.provider);
		expect(a1.model_state!.model_id).toBe(a2.model_state!.model_id);
		expect(a1.model_state!.thinking_level).toBe(a2.model_state!.thinking_level);
		expect(a1.compaction_state!.auto_compact_enabled).toBe(a2.compaction_state!.auto_compact_enabled);
		expect(a1.compaction_state!.auto_retry_enabled).toBe(a2.compaction_state!.auto_retry_enabled);
		expect(a1.queue_state!.pending_count).toBe(a2.queue_state!.pending_count);
		expect(a1.queue_state!.fair_cursor).toBe(a2.queue_state!.fair_cursor);
		expect(a1.event_anchor!.event_seq).toBe(a2.event_anchor!.event_seq);
	});

	test("replaying open + enqueue + dequeue + branch produces consistent dag_anchor", () => {
		const clock = testClock();
		const svc = createSessionService("replay-dag", {
			now_ms: clock.now_ms,
			generate_turn_id: testTurnIdGenerator("rd"),
		});

		svc.dispatch({ kind: "session.open", session_id: "replay-dag", mode: "persist" });
		svc.attach();
		svc.dispatch({
			kind: "session.enqueue",
			session_id: "replay-dag",
			turn_kind: "prompt",
			body: "build something",
		});
		svc.dispatch({ kind: "session.dequeue", session_id: "replay-dag" });
		svc.dispatch({
			kind: "session.branch",
			session_id: "replay-dag",
			leaf_id: "leaf-42",
			entry_count: 7,
			journal_size: 3000,
		});

		const a = svc.assertions();
		expect(a.dag_anchor!.leaf_id).toBe("leaf-42");
		expect(a.dag_anchor!.entry_count).toBe(7);
		expect(a.queue_state!.completed_count).toBe(1);
		expect(a.queue_state!.active_turn_id).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Projection integration tests (assertion state consumed by projection module)
// ---------------------------------------------------------------------------

describe("session service assertion projection integration", () => {
	test("service assertions are consumable by assembleAssertionSet", () => {
		const svc = createTestService();
		openAndAttach(svc);

		svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "openai",
			model_id: "gpt-5",
			thinking_level: "high",
		});

		svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-1",
			entry_count: 3,
			journal_size: 500,
		});

		const assertions = svc.assertions();
		const allAssertions = [
			assertions.lifecycle!,
			assertions.queue_state!,
			assertions.model_state!,
			assertions.compaction_state!,
			assertions.dag_anchor!,
			assertions.event_anchor!,
		];

		const assembled = assembleAssertionSet(svc.session_id, allAssertions);
		expect(assembled.lifecycle).not.toBeNull();
		expect(assembled.lifecycle!.phase).toBe("attached");
		expect(assembled.model_state!.provider).toBe("openai");
		expect(assembled.dag_anchor!.leaf_id).toBe("leaf-1");
	});

	test("service assertions pass diagnoseAssertionSet with no errors", () => {
		const svc = createTestService();
		openAndAttach(svc);

		svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "anthropic",
			model_id: "claude-4",
			thinking_level: "medium",
		});

		svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-1",
			entry_count: 1,
			journal_size: 100,
		});

		const errors = diagnoseAssertionSet(svc.assertions());
		expect(errors.length).toBe(0);
	});

	test("projectLeafId reads dag_anchor from service state", () => {
		const svc = createTestService();
		openAndAttach(svc);

		svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-xyz",
			entry_count: 5,
			journal_size: 1000,
		});

		const result = projectLeafId(svc.assertions());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe("leaf-xyz");
		}
	});

	test("projectModelState reads model from service state", () => {
		const svc = createTestService();
		openAndAttach(svc);

		svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "openai",
			model_id: "gpt-5",
			thinking_level: "xhigh",
		});

		const result = projectModelState(svc.assertions());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.provider).toBe("openai");
			expect(result.value.model_id).toBe("gpt-5");
			expect(result.value.thinking_level).toBe("xhigh");
		}
	});

	test("projectBranchState reads branch info from service state", () => {
		const svc = createTestService();
		openAndAttach(svc);

		svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-42",
			entry_count: 10,
			journal_size: 2048,
		});

		const result = projectBranchState(svc.assertions());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.leaf_id).toBe("leaf-42");
			expect(result.value.entry_count).toBe(10);
			expect(result.value.journal_size).toBe(2048);
			expect(result.value.branch_active).toBe(true);
		}
	});

	test("projectCompactionState reads policy from service state", () => {
		const svc = createTestService();
		openAndAttach(svc);

		svc.dispatch({
			kind: "session.set_policy",
			session_id: svc.session_id,
			auto_compact_enabled: true,
			auto_retry_enabled: true,
		});

		const result = projectCompactionState(svc.assertions());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.auto_compact_enabled).toBe(true);
			expect(result.value.auto_retry_enabled).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Full workflow integration test
// ---------------------------------------------------------------------------

describe("session service full workflow", () => {
	test("open -> attach -> set_model -> enqueue -> dequeue -> branch -> close", () => {
		const clock = testClock();
		const svc = createTestService({ clock });
		const allEvents: SessionEvent[] = [];
		svc.on({ onEvent: (e) => allEvents.push(e) });

		// Open
		const r1 = openService(svc);
		expect(r1.ok).toBe(true);
		expect(svc.phase()).toBe("open");

		// Attach
		const r2 = attachService(svc);
		expect(r2.ok).toBe(true);
		expect(svc.phase()).toBe("attached");

		// Set model
		svc.dispatch({
			kind: "session.set_model",
			session_id: svc.session_id,
			provider: "anthropic",
			model_id: "claude-4-sonnet",
			thinking_level: "high",
		});

		// Set policy
		svc.dispatch({
			kind: "session.set_policy",
			session_id: svc.session_id,
			auto_compact_enabled: true,
			auto_retry_enabled: false,
		});

		// Enqueue prompt
		const r3 = enqueuePrompt(svc, "Write a function");
		expect(r3.ok).toBe(true);

		// Enqueue follow-up
		const r4 = enqueueFollowUp(svc, "Add tests");
		expect(r4.ok).toBe(true);

		expect(svc.queueDepth()).toBe(2);

		// Dequeue first turn
		const r5 = dequeue(svc);
		expect(r5.ok).toBe(true);
		const d5 = r5.response as DequeueAckResponse;
		expect(d5.body).toBe("Write a function");
		expect(d5.turn_kind).toBe("prompt");

		// Branch (completes the turn)
		svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-1",
			entry_count: 3,
			journal_size: 500,
		});

		expect(svc.activeTurn()).toBeNull();
		expect(svc.assertions().queue_state!.completed_count).toBe(1);

		// Dequeue second turn
		const r6 = dequeue(svc);
		expect(r6.ok).toBe(true);
		const d6 = r6.response as DequeueAckResponse;
		expect(d6.body).toBe("Add tests");
		expect(d6.turn_kind).toBe("follow_up");

		// Branch again
		svc.dispatch({
			kind: "session.branch",
			session_id: svc.session_id,
			leaf_id: "leaf-2",
			entry_count: 6,
			journal_size: 1200,
		});

		expect(svc.assertions().queue_state!.completed_count).toBe(2);

		// Close
		const r7 = closeService(svc, "user_done");
		expect(r7.ok).toBe(true);
		expect(svc.phase()).toBe("closed");

		// Verify final assertion state
		const final = svc.assertions();
		expect(final.lifecycle!.phase).toBe("closed");
		expect(final.dag_anchor!.leaf_id).toBe("leaf-2");
		expect(final.model_state!.provider).toBe("anthropic");
		expect(final.compaction_state!.auto_compact_enabled).toBe(true);

		// Verify event sequence
		const eventKinds = allEvents.map((e) => e.event_kind);
		expect(eventKinds).toContain("session_opened");
		expect(eventKinds).toContain("session_attached");
		expect(eventKinds).toContain("model_changed");
		expect(eventKinds).toContain("policy_changed");
		expect(eventKinds).toContain("turn_enqueued");
		expect(eventKinds).toContain("turn_dequeued");
		expect(eventKinds).toContain("branch_updated");
		expect(eventKinds).toContain("session_closed");

		// Verify monotonic event_seq
		for (let i = 1; i < allEvents.length; i++) {
			expect(allEvents[i]!.event_seq).toBeGreaterThan(allEvents[i - 1]!.event_seq);
		}
	});
});

// ---------------------------------------------------------------------------
// Deterministic ordering tests (prompt/steer/follow_up/abort)
// ---------------------------------------------------------------------------

describe("session service deterministic turn ordering", () => {
	test("prompt, steer, and follow_up maintain insertion order", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "p1");
		enqueueSteer(svc, "s1");
		enqueueFollowUp(svc, "f1");
		enqueuePrompt(svc, "p2");

		const bodies: string[] = [];
		for (let i = 0; i < 4; i++) {
			const r = dequeue(svc);
			if (r.ok) {
				const resp = r.response as DequeueAckResponse;
				if (resp.body) bodies.push(resp.body);
			}
			svc.completeActiveTurn();
		}

		expect(bodies).toEqual(["p1", "s1", "f1", "p2"]);
	});

	test("abort clears all pending regardless of turn kind", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "p1");
		enqueueSteer(svc, "s1");
		enqueueFollowUp(svc, "f1");

		enqueueAbort(svc);

		expect(svc.queueDepth()).toBe(0);
		expect(svc.pendingTurns().length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Close with active work tests
// ---------------------------------------------------------------------------

describe("session service close with active work", () => {
	test("close transitions through closing when active turn exists", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "hello");
		dequeue(svc);

		const result = closeService(svc, "shutdown");
		expect(result.ok).toBe(true);
		expect(svc.phase()).toBe("closed");

		// Should have both closing and closed events
		const eventKinds = result.events.map((e) => e.event_kind);
		expect(eventKinds).toContain("session_closing");
		expect(eventKinds).toContain("session_closed");
	});

	test("close clears queue and active turn", () => {
		const svc = createTestService();
		openAndAttach(svc);

		enqueuePrompt(svc, "a");
		enqueuePrompt(svc, "b");
		dequeue(svc);

		closeService(svc, "done");

		expect(svc.queueDepth()).toBe(0);
		expect(svc.activeTurn()).toBeNull();
	});
});
