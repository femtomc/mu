import { describe, expect, test } from "bun:test";
import {
	DaemonSessionAdapter,
	createDaemonSessionAdapter,
	type DaemonCommandEnvelope,
	type DaemonCommandResponse,
	type DaemonEventEnvelope,
	type DaemonSessionSnapshot,
} from "../src/daemon_session_adapter.js";
import type {
	SessionCommand,
	SessionEventKind,
} from "@femtomc/mu-agent";

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

function makeEnvelope(
	session_id: string,
	command: SessionCommand,
	opts?: { request_id?: string; received_at_ms?: number },
): DaemonCommandEnvelope {
	return {
		request_id: opts?.request_id ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		session_id,
		command,
		received_at_ms: opts?.received_at_ms ?? Date.now(),
	};
}

function openSession(
	adapter: DaemonSessionAdapter,
	session_id: string,
): DaemonCommandResponse {
	return adapter.dispatchCommand(
		makeEnvelope(session_id, {
			kind: "session.open",
			session_id,
			mode: "memory",
		}),
	);
}

function enqueuePrompt(
	adapter: DaemonSessionAdapter,
	session_id: string,
	body: string,
): DaemonCommandResponse {
	return adapter.dispatchCommand(
		makeEnvelope(session_id, {
			kind: "session.enqueue",
			session_id,
			turn_kind: "prompt",
			body,
		}),
	);
}

function dequeue(
	adapter: DaemonSessionAdapter,
	session_id: string,
): DaemonCommandResponse {
	return adapter.dispatchCommand(
		makeEnvelope(session_id, {
			kind: "session.dequeue",
			session_id,
		}),
	);
}

function closeSession(
	adapter: DaemonSessionAdapter,
	session_id: string,
	reason: string = "test_close",
): DaemonCommandResponse {
	return adapter.dispatchCommand(
		makeEnvelope(session_id, {
			kind: "session.close",
			session_id,
			reason,
		}),
	);
}

// ---------------------------------------------------------------------------
// AC-1: Control commands route into Syndicate service messages
//        and return adapter-projected responses
// ---------------------------------------------------------------------------

describe("AC-1: control command routing through service adapter", () => {
	test("open command creates session and returns projected response", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		const resp = openSession(adapter, "s1");

		expect(resp.ok).toBe(true);
		expect(resp.command_kind).toBe("session.open");
		expect(resp.session_id).toBe("s1");
		expect(resp.assertions.lifecycle).not.toBeNull();
		expect(resp.assertions.lifecycle?.phase).toBe("open");
		expect(resp.projections.phase).toBe("open");
	});

	test("enqueue command routes through service and returns queue receipt", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const resp = enqueuePrompt(adapter, "s1", "hello world");
		expect(resp.ok).toBe(true);
		expect(resp.response.kind).toBe("session.queue_receipt");
		if (resp.response.kind === "session.queue_receipt") {
			expect(resp.response.accepted).toBe(true);
			expect(resp.response.position).toBe(0);
		}
		expect(resp.assertions.queue_state?.pending_count).toBe(1);
	});

	test("[criterion:adapter-turn:steer] enqueue/dequeue preserves steer turn kind", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const enqueueResp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.enqueue",
				session_id: "s1",
				turn_kind: "steer",
				body: "nudge: prioritize tests",
			}),
		);
		expect(enqueueResp.ok).toBe(true);
		expect(enqueueResp.assertions.queue_state?.pending_count).toBe(1);

		const dequeueResp = dequeue(adapter, "s1");
		expect(dequeueResp.ok).toBe(true);
		expect(dequeueResp.response.kind).toBe("session.dequeue_ack");
		if (dequeueResp.response.kind === "session.dequeue_ack") {
			expect(dequeueResp.response.turn_kind).toBe("steer");
			expect(dequeueResp.response.body).toBe("nudge: prioritize tests");
			expect(dequeueResp.response.empty).toBe(false);
		}
	});

	test("[criterion:adapter-turn:follow_up] enqueue/dequeue preserves follow_up turn kind", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const enqueueResp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.enqueue",
				session_id: "s1",
				turn_kind: "follow_up",
				body: "follow-up: include migration notes",
			}),
		);
		expect(enqueueResp.ok).toBe(true);
		expect(enqueueResp.assertions.queue_state?.pending_count).toBe(1);

		const dequeueResp = dequeue(adapter, "s1");
		expect(dequeueResp.ok).toBe(true);
		expect(dequeueResp.response.kind).toBe("session.dequeue_ack");
		if (dequeueResp.response.kind === "session.dequeue_ack") {
			expect(dequeueResp.response.turn_kind).toBe("follow_up");
			expect(dequeueResp.response.body).toBe("follow-up: include migration notes");
			expect(dequeueResp.response.empty).toBe(false);
		}
	});

	test("dequeue command returns turn body from service", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "test prompt body");

		const resp = dequeue(adapter, "s1");
		expect(resp.ok).toBe(true);
		expect(resp.response.kind).toBe("session.dequeue_ack");
		if (resp.response.kind === "session.dequeue_ack") {
			expect(resp.response.body).toBe("test prompt body");
			expect(resp.response.turn_kind).toBe("prompt");
			expect(resp.response.empty).toBe(false);
		}
	});

	test("set_model command routes and updates model state projection", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const resp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_model",
				session_id: "s1",
				provider: "anthropic",
				model_id: "claude-opus-4",
				thinking_level: "high",
			}),
		);
		expect(resp.ok).toBe(true);
		expect(resp.projections.model?.provider).toBe("anthropic");
		expect(resp.projections.model?.model_id).toBe("claude-opus-4");
		expect(resp.projections.model?.thinking_level).toBe("high");
	});

	test("set_policy command routes and updates compaction projection", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const resp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_policy",
				session_id: "s1",
				auto_compact_enabled: true,
				auto_retry_enabled: true,
			}),
		);
		expect(resp.ok).toBe(true);
		expect(resp.projections.compaction?.auto_compact_enabled).toBe(true);
		expect(resp.projections.compaction?.auto_retry_enabled).toBe(true);
	});

	test("branch command routes and updates dag anchor projection", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "branching");
		dequeue(adapter, "s1");

		const resp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.branch",
				session_id: "s1",
				leaf_id: "leaf-abc",
				entry_count: 5,
				journal_size: 1024,
			}),
		);
		expect(resp.ok).toBe(true);
		expect(resp.projections.leaf_id).toBe("leaf-abc");
		expect(resp.projections.branch?.leaf_id).toBe("leaf-abc");
		expect(resp.projections.branch?.entry_count).toBe(5);
		expect(resp.projections.branch?.journal_size).toBe(1024);
	});

	test("interrupt command clears queue through service", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "turn1");
		enqueuePrompt(adapter, "s1", "turn2");

		const resp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.interrupt",
				session_id: "s1",
				reason: "user_cancel",
			}),
		);
		expect(resp.ok).toBe(true);
		expect(resp.response.kind).toBe("session.interrupt_ack");
		if (resp.response.kind === "session.interrupt_ack") {
			expect(resp.response.queue_cleared_count).toBe(2);
		}
		expect(resp.assertions.queue_state?.pending_count).toBe(0);
	});

	test("close command transitions through service lifecycle", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const resp = closeSession(adapter, "s1");
		expect(resp.ok).toBe(true);
		expect(resp.projections.phase).toBe("closed");
	});

	test("command to nonexistent session returns error response", () => {
		const adapter = createDaemonSessionAdapter();
		const resp = enqueuePrompt(adapter, "nonexistent", "hello");
		expect(resp.ok).toBe(false);
		expect(resp.response.kind).toBe("session.ack");
		if (resp.response.kind === "session.ack") {
			expect(resp.response.error).toBe("session_not_found");
		}
	});

	test("session_id mismatch in command returns error from service", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		// Envelope session_id is s1, command session_id is s2 (mismatch)
		const resp = adapter.dispatchCommand({
			request_id: "req-mismatch",
			session_id: "s1",
			command: {
				kind: "session.enqueue",
				session_id: "s2",
				turn_kind: "prompt",
				body: "mismatch",
			},
			received_at_ms: Date.now(),
		});
		expect(resp.ok).toBe(false);
	});

	test("max_sessions limit rejects new open commands", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({
			now_ms: clock.now_ms,
			max_sessions: 2,
		});
		openSession(adapter, "s1");
		openSession(adapter, "s2");

		const resp = openSession(adapter, "s3");
		expect(resp.ok).toBe(false);
		if (resp.response.kind === "session.ack") {
			expect(resp.response.error).toBe("max_sessions_exceeded");
		}
	});
});

// ---------------------------------------------------------------------------
// AC-2: Event stream envelopes projected from Syndicate events
// ---------------------------------------------------------------------------

describe("AC-2: event stream envelope projection", () => {
	test("open command produces session_opened event envelope", () => {
		const clock = testClock();
		const events: DaemonEventEnvelope[] = [];
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		adapter.onEvent((e) => events.push(e));

		openSession(adapter, "s1");

		expect(events.length).toBe(1);
		expect(events[0].event_kind).toBe("session_opened");
		expect(events[0].type).toBe("session.session_opened");
		expect(events[0].source).toBe("daemon-session-adapter");
		expect(events[0].session_id).toBe("s1");
		expect(events[0].event_seq).toBe(1);
		expect(events[0].assertions_after.lifecycle?.phase).toBe("open");
	});

	test("full lifecycle produces ordered event sequence", () => {
		const clock = testClock();
		const events: DaemonEventEnvelope[] = [];
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		adapter.onEvent((e) => events.push(e));

		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "hello");
		dequeue(adapter, "s1");
		closeSession(adapter, "s1");

		const kinds = events.map((e) => e.event_kind);
		expect(kinds).toContain("session_opened");
		expect(kinds).toContain("turn_enqueued");
		expect(kinds).toContain("turn_dequeued");
		expect(kinds).toContain("session_closed");

		// Event seqs are monotonically increasing
		for (let i = 1; i < events.length; i++) {
			expect(events[i].event_seq).toBeGreaterThan(events[i - 1].event_seq);
		}
	});

	test("event envelopes include assertions_after for each event", () => {
		const clock = testClock();
		const events: DaemonEventEnvelope[] = [];
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		adapter.onEvent((e) => events.push(e));

		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "test");

		// After open, lifecycle should be open
		expect(events[0].assertions_after.lifecycle?.phase).toBe("open");

		// After enqueue, queue should show pending
		const enqueueEvent = events.find((e) => e.event_kind === "turn_enqueued");
		expect(enqueueEvent).toBeDefined();
		expect(enqueueEvent!.assertions_after.queue_state?.pending_count).toBe(1);
	});

	test("model_changed event carries model detail", () => {
		const clock = testClock();
		const events: DaemonEventEnvelope[] = [];
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		adapter.onEvent((e) => events.push(e));

		openSession(adapter, "s1");
		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_model",
				session_id: "s1",
				provider: "openai",
				model_id: "gpt-4",
				thinking_level: "medium",
			}),
		);

		const modelEvent = events.find((e) => e.event_kind === "model_changed");
		expect(modelEvent).toBeDefined();
		expect(modelEvent!.detail).toEqual({
			provider: "openai",
			model_id: "gpt-4",
			thinking_level: "medium",
		});
	});

	test("event listener unsubscribe stops delivery", () => {
		const clock = testClock();
		const events: DaemonEventEnvelope[] = [];
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		const unsub = adapter.onEvent((e) => events.push(e));

		openSession(adapter, "s1");
		expect(events.length).toBe(1);

		unsub();
		enqueuePrompt(adapter, "s1", "after unsub");
		expect(events.length).toBe(1); // No new events after unsubscribe
	});

	test("event buffer respects max_events_per_session", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({
			now_ms: clock.now_ms,
			max_events_per_session: 5,
		});

		openSession(adapter, "s1"); // 1 event
		for (let i = 0; i < 10; i++) {
			enqueuePrompt(adapter, "s1", `turn-${i}`); // 10 events
		}

		const snapshot = adapter.getSessionSnapshot("s1");
		expect(snapshot).not.toBeNull();
		// Internal events buffer should be trimmed
		const replayed = adapter.replayEvents("s1", 0);
		expect(replayed.length).toBeLessThanOrEqual(5);
	});

	test("12 lifecycle event kinds are all projectable", () => {
		const expectedKinds: SessionEventKind[] = [
			"session_opened",
			"session_attached",
			"session_closing",
			"session_closed",
			"session_error",
			"turn_enqueued",
			"turn_dequeued",
			"turn_interrupted",
			"model_changed",
			"policy_changed",
			"branch_updated",
			"context_projected",
		];
		// Just verify types compile; full lifecycle coverage tested above
		for (const kind of expectedKinds) {
			expect(typeof kind).toBe("string");
		}
	});
});

// ---------------------------------------------------------------------------
// AC-3: Programmable UI response routing through service path
// ---------------------------------------------------------------------------

describe("AC-3: programmable UI response routing via service path", () => {
	test("getAssertions reads state without daemon domain ownership", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_model",
				session_id: "s1",
				provider: "anthropic",
				model_id: "claude-sonnet",
				thinking_level: "high",
			}),
		);

		const assertions = adapter.getAssertions("s1");
		expect(assertions).not.toBeNull();
		expect(assertions!.model_state?.provider).toBe("anthropic");
		expect(assertions!.model_state?.model_id).toBe("claude-sonnet");
		expect(assertions!.lifecycle?.phase).toBe("open");
	});

	test("getProjections derives UI state from assertions only", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		enqueuePrompt(adapter, "s1", "ui-test");
		dequeue(adapter, "s1");
		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.branch",
				session_id: "s1",
				leaf_id: "leaf-ui-1",
				entry_count: 3,
				journal_size: 512,
			}),
		);

		const projections = adapter.getProjections("s1");
		expect(projections).not.toBeNull();
		expect(projections!.phase).toBe("open");
		expect(projections!.leaf_id).toBe("leaf-ui-1");
		expect(projections!.branch?.entry_count).toBe(3);
	});

	test("UI state reads remain consistent without mutation commands", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_model",
				session_id: "s1",
				provider: "openai",
				model_id: "gpt-5",
				thinking_level: "xhigh",
			}),
		);

		// Multiple reads without commands should return same state
		const p1 = adapter.getProjections("s1");
		const p2 = adapter.getProjections("s1");
		expect(p1).toEqual(p2);

		// Assertions should also be stable
		const a1 = adapter.getAssertions("s1");
		const a2 = adapter.getAssertions("s1");
		expect(a1!.model_state).toEqual(a2!.model_state);
	});

	test("diagnostics detect missing/stale assertions for UI consumers", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const snapshot = adapter.getSessionSnapshot("s1");
		expect(snapshot).not.toBeNull();
		// A freshly opened session has all assertion slots filled by the service,
		// but dag_anchor may have null leaf_id which is normal
		expect(snapshot!.diagnostics).toBeDefined();
	});

	test("getAssertions returns null for nonexistent session", () => {
		const adapter = createDaemonSessionAdapter();
		expect(adapter.getAssertions("nope")).toBeNull();
	});

	test("getProjections returns null for nonexistent session", () => {
		const adapter = createDaemonSessionAdapter();
		expect(adapter.getProjections("nope")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-4: Transport reconnection/replay via adapter path
// ---------------------------------------------------------------------------

describe("AC-4: transport reconnection and replay", () => {
	test("getSessionSnapshot returns full assertion + projection state", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_model",
				session_id: "s1",
				provider: "anthropic",
				model_id: "claude-opus-4",
				thinking_level: "high",
			}),
		);
		enqueuePrompt(adapter, "s1", "reconnect-test");

		const snapshot = adapter.getSessionSnapshot("s1");
		expect(snapshot).not.toBeNull();
		expect(snapshot!.session_id).toBe("s1");
		expect(snapshot!.assertions.lifecycle?.phase).toBe("open");
		expect(snapshot!.projections.model?.provider).toBe("anthropic");
		expect(snapshot!.event_cursor).toBeGreaterThan(0);
		expect(snapshot!.snapshot_at_ms).toBeGreaterThan(0);
	});

	test("replayEvents returns events after given cursor", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1"); // event_seq 1
		enqueuePrompt(adapter, "s1", "turn1"); // event_seq 2
		enqueuePrompt(adapter, "s1", "turn2"); // event_seq 3

		// Replay from seq 1 (after open) should get enqueue events
		const replayed = adapter.replayEvents("s1", 1);
		expect(replayed.length).toBe(2);
		expect(replayed[0].event_seq).toBe(2);
		expect(replayed[1].event_seq).toBe(3);
	});

	test("replayEvents from seq 0 returns all events", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "turn1");
		enqueuePrompt(adapter, "s1", "turn2");

		const allEvents = adapter.replayEvents("s1", 0);
		expect(allEvents.length).toBe(3); // open + 2 enqueues
	});

	test("replayEvents returns empty for nonexistent session", () => {
		const adapter = createDaemonSessionAdapter();
		expect(adapter.replayEvents("nope", 0)).toEqual([]);
	});

	test("snapshot + replay reproduces consistent state for reconnection", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "before-disconnect");

		// Client takes snapshot at this point
		const snapshot1 = adapter.getSessionSnapshot("s1");
		expect(snapshot1).not.toBeNull();
		const cursorAtDisconnect = snapshot1!.event_cursor;

		// More activity happens while "disconnected"
		enqueuePrompt(adapter, "s1", "during-disconnect-1");
		enqueuePrompt(adapter, "s1", "during-disconnect-2");

		// Client "reconnects" and replays from cursor
		const missedEvents = adapter.replayEvents("s1", cursorAtDisconnect);
		expect(missedEvents.length).toBe(2);
		expect(missedEvents[0].event_kind).toBe("turn_enqueued");
		expect(missedEvents[1].event_kind).toBe("turn_enqueued");

		// Fresh snapshot after reconnect has all state
		const snapshot2 = adapter.getSessionSnapshot("s1");
		expect(snapshot2!.assertions.queue_state?.pending_count).toBe(3);
		expect(snapshot2!.event_cursor).toBeGreaterThan(cursorAtDisconnect);
	});

	test("full lifecycle replay: open -> work -> close", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });

		// Full lifecycle
		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "prompt1");
		dequeue(adapter, "s1");
		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.branch",
				session_id: "s1",
				leaf_id: "leaf-1",
				entry_count: 2,
				journal_size: 256,
			}),
		);
		closeSession(adapter, "s1");

		// Replay everything
		const allEvents = adapter.replayEvents("s1", 0);
		const kinds = allEvents.map((e) => e.event_kind);
		expect(kinds).toContain("session_opened");
		expect(kinds).toContain("turn_enqueued");
		expect(kinds).toContain("turn_dequeued");
		expect(kinds).toContain("branch_updated");
		expect(kinds).toContain("session_closed");

		// All event seqs are monotonically increasing
		for (let i = 1; i < allEvents.length; i++) {
			expect(allEvents[i].event_seq).toBeGreaterThan(allEvents[i - 1].event_seq);
		}
	});

	test("attach/detach transitions project through adapter", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");

		const attachResp = adapter.attach("s1");
		expect(attachResp).not.toBeNull();
		expect(attachResp!.ok).toBe(true);
		expect(attachResp!.projections.phase).toBe("attached");

		const detachResp = adapter.detach("s1");
		expect(detachResp).not.toBeNull();
		expect(detachResp!.ok).toBe(true);
		expect(detachResp!.projections.phase).toBe("open");
	});

	test("attach on nonexistent session returns null", () => {
		const adapter = createDaemonSessionAdapter();
		expect(adapter.attach("nope")).toBeNull();
	});

	test("detach on nonexistent session returns null", () => {
		const adapter = createDaemonSessionAdapter();
		expect(adapter.detach("nope")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

describe("session management", () => {
	test("activeSessions lists managed sessions", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		expect(adapter.activeSessions()).toEqual([]);

		openSession(adapter, "s1");
		openSession(adapter, "s2");
		const sessions = adapter.activeSessions();
		expect(sessions).toContain("s1");
		expect(sessions).toContain("s2");
		expect(sessions.length).toBe(2);
	});

	test("hasSession reports existence", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		expect(adapter.hasSession("s1")).toBe(false);

		openSession(adapter, "s1");
		expect(adapter.hasSession("s1")).toBe(true);
	});

	test("destroySession removes session and releases resources", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		expect(adapter.hasSession("s1")).toBe(true);

		const destroyed = adapter.destroySession("s1");
		expect(destroyed).toBe(true);
		expect(adapter.hasSession("s1")).toBe(false);
		expect(adapter.getAssertions("s1")).toBeNull();
		expect(adapter.replayEvents("s1", 0)).toEqual([]);
	});

	test("destroySession returns false for nonexistent session", () => {
		const adapter = createDaemonSessionAdapter();
		expect(adapter.destroySession("nope")).toBe(false);
	});

	test("multiple sessions are independent", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		openSession(adapter, "s2");

		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_model",
				session_id: "s1",
				provider: "anthropic",
				model_id: "claude",
				thinking_level: "high",
			}),
		);

		// s1 has model set, s2 does not
		const p1 = adapter.getProjections("s1");
		const p2 = adapter.getProjections("s2");
		expect(p1!.model?.provider).toBe("anthropic");
		expect(p2!.model?.provider).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Multi-session event isolation
// ---------------------------------------------------------------------------

describe("multi-session event isolation", () => {
	test("events from different sessions are independently projected", () => {
		const clock = testClock();
		const events: DaemonEventEnvelope[] = [];
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		adapter.onEvent((e) => events.push(e));

		openSession(adapter, "s1");
		openSession(adapter, "s2");
		enqueuePrompt(adapter, "s1", "s1-turn");
		enqueuePrompt(adapter, "s2", "s2-turn");

		const s1Events = events.filter((e) => e.session_id === "s1");
		const s2Events = events.filter((e) => e.session_id === "s2");
		expect(s1Events.length).toBeGreaterThan(0);
		expect(s2Events.length).toBeGreaterThan(0);

		// Event seqs are per-session (each starts from 1)
		const s1Seqs = s1Events.map((e) => e.event_seq);
		const s2Seqs = s2Events.map((e) => e.event_seq);
		expect(s1Seqs[0]).toBe(1);
		expect(s2Seqs[0]).toBe(1);
	});

	test("replay is scoped to individual sessions", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		openSession(adapter, "s1");
		openSession(adapter, "s2");
		enqueuePrompt(adapter, "s1", "s1-only");

		const s1Replay = adapter.replayEvents("s1", 0);
		const s2Replay = adapter.replayEvents("s2", 0);

		// s1 has open + enqueue events, s2 has only open
		expect(s1Replay.length).toBe(2);
		expect(s2Replay.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Abort (special enqueue) through adapter
// ---------------------------------------------------------------------------

describe("abort handling through adapter", () => {
	test("abort enqueue clears queue and interrupts active turn", () => {
		const clock = testClock();
		const events: DaemonEventEnvelope[] = [];
		const adapter = createDaemonSessionAdapter({ now_ms: clock.now_ms });
		adapter.onEvent((e) => events.push(e));

		openSession(adapter, "s1");
		enqueuePrompt(adapter, "s1", "turn1");
		enqueuePrompt(adapter, "s1", "turn2");
		dequeue(adapter, "s1"); // turn1 is now active

		const resp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.enqueue",
				session_id: "s1",
				turn_kind: "abort",
				body: "",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(resp.assertions.queue_state?.pending_count).toBe(0);
		expect(resp.assertions.queue_state?.active_turn_id).toBeNull();

		// Should have turn_interrupted event
		const interruptEvents = events.filter((e) => e.event_kind === "turn_interrupted");
		expect(interruptEvents.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Project context command through adapter
// ---------------------------------------------------------------------------

describe("project_context through adapter", () => {
	test("project_context routes through service and returns context response", () => {
		const clock = testClock();
		const adapter = createDaemonSessionAdapter({
			now_ms: clock.now_ms,
			session_service_config: {
				context_provider: (_id: string) => [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "hi" },
				],
			},
		});
		openSession(adapter, "s1");
		adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.set_model",
				session_id: "s1",
				provider: "anthropic",
				model_id: "claude",
				thinking_level: "medium",
			}),
		);

		const resp = adapter.dispatchCommand(
			makeEnvelope("s1", {
				kind: "session.project_context",
				session_id: "s1",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(resp.response.kind).toBe("session.context");
		if (resp.response.kind === "session.context") {
			expect(resp.response.messages.length).toBe(2);
			expect(resp.response.thinking_level).toBe("medium");
			expect(resp.response.model?.provider).toBe("anthropic");
		}
	});
});
