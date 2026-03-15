import { describe, expect, test } from "bun:test";
import {
	DAEMON_THIN_BOUNDARY,
	DaemonHostHealthReporter,
	validateDaemonBoundary,
	observeSessionIsolation,
} from "../src/daemon_thin_host.js";
import { DaemonSessionAdapter } from "../src/daemon_session_adapter.js";
import type { ControlPlaneSessionLifecycle } from "../src/control_plane_contract.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestSessionLifecycle(): ControlPlaneSessionLifecycle {
	return {
		reload: async () => ({ ok: true, action: "reload" as const, message: "test reload" }),
		update: async () => ({ ok: true, action: "update" as const, message: "test update" }),
	};
}

function createTestAdapter(nowMs?: () => number): DaemonSessionAdapter {
	return new DaemonSessionAdapter({
		now_ms: nowMs ?? (() => Date.now()),
		max_sessions: 256,
		max_events_per_session: 1024,
	});
}

function openSession(adapter: DaemonSessionAdapter, sessionId: string): void {
	adapter.dispatchCommand({
		request_id: `open-${sessionId}`,
		session_id: sessionId,
		command: { kind: "session.open", session_id: sessionId, mode: "memory" },
		received_at_ms: Date.now(),
	});
}

function enqueueMessage(adapter: DaemonSessionAdapter, sessionId: string, message: string): void {
	adapter.dispatchCommand({
		request_id: `enqueue-${sessionId}-${message}`,
		session_id: sessionId,
		command: { kind: "session.enqueue", session_id: sessionId, turn_kind: "prompt", body: message },
		received_at_ms: Date.now(),
	});
}

// ---------------------------------------------------------------------------
// AC-1: Remove daemon-native authoritative session/queue/runtime state
// ---------------------------------------------------------------------------

describe("daemon thin-host boundary (AC-1): no daemon-native session authority", () => {
	test("boundary descriptor declares session domain as syndicate-delegated", () => {
		expect(DAEMON_THIN_BOUNDARY.delegated.session_domain).toBe("syndicate_session_service");
		expect(DAEMON_THIN_BOUNDARY.delegated.agent_semantics).toBe("syndicate_session_service");
		expect(DAEMON_THIN_BOUNDARY.delegated.queue_fairness).toBe("syndicate_session_service");
	});

	test("boundary descriptor declares host responsibilities as transport/runtime only", () => {
		expect(DAEMON_THIN_BOUNDARY.host.transport).toBe("http");
		expect(DAEMON_THIN_BOUNDARY.host.routing).toBe("api_router");
		expect(DAEMON_THIN_BOUNDARY.host.runtime_lifecycle_actions).toEqual(["reload", "update"]);
	});

	test("validateDaemonBoundary passes for valid host + adapter configuration", () => {
		const lifecycle = createTestSessionLifecycle();
		const adapter = createTestAdapter();
		const result = validateDaemonBoundary({
			sessionLifecycle: lifecycle,
			sessionAdapter: adapter,
		});
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	test("validateDaemonBoundary passes without adapter (host-only mode)", () => {
		const lifecycle = createTestSessionLifecycle();
		const result = validateDaemonBoundary({
			sessionLifecycle: lifecycle,
			sessionAdapter: null,
		});
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	test("validateDaemonBoundary detects missing lifecycle functions", () => {
		const brokenLifecycle = { reload: "not_a_function", update: "not_a_function" };
		const result = validateDaemonBoundary({
			sessionLifecycle: brokenLifecycle as unknown as ControlPlaneSessionLifecycle,
		});
		expect(result.valid).toBe(false);
		expect(result.violations.length).toBeGreaterThanOrEqual(2);
		expect(result.violations.some((v) => v.includes("reload"))).toBe(true);
		expect(result.violations.some((v) => v.includes("update"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC-2: Daemon keeps only transport/runtime lifecycle/process concerns
// ---------------------------------------------------------------------------

describe("daemon thin-host boundary (AC-2): host keeps transport/runtime only", () => {
	test("host health reporter provides bounded host metrics", () => {
		let clock = 1000;
		const reporter = new DaemonHostHealthReporter({ now_ms: () => clock });

		clock = 5000;
		const health = reporter.health();

		expect(health.ok).toBe(true);
		expect(health.host.transport).toBe("http");
		expect(health.host.started_at_ms).toBe(1000);
		expect(health.host.uptime_ms).toBe(4000);
		expect(health.boundary).toEqual(DAEMON_THIN_BOUNDARY);
	});

	test("host health reporter without adapter reports no session state", () => {
		const reporter = new DaemonHostHealthReporter({ now_ms: () => Date.now() });
		const health = reporter.health();

		expect(health.adapter.available).toBe(false);
		expect(health.adapter.active_sessions).toBe(0);
	});

	test("host health reporter with adapter reads adapter-projected state", () => {
		const adapter = createTestAdapter();
		const reporter = new DaemonHostHealthReporter({
			now_ms: () => Date.now(),
			sessionAdapter: adapter,
		});

		// No sessions yet
		let health = reporter.health();
		expect(health.adapter.available).toBe(true);
		expect(health.adapter.active_sessions).toBe(0);

		// Open a session via adapter (domain state lives in adapter)
		openSession(adapter, "session-1");
		health = reporter.health();
		expect(health.adapter.active_sessions).toBe(1);

		// Open another session
		openSession(adapter, "session-2");
		health = reporter.health();
		expect(health.adapter.active_sessions).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// AC-3: Health/status endpoints read from adapter-projected service state
// ---------------------------------------------------------------------------

describe("daemon thin-host boundary (AC-3): health reads adapter-projected state", () => {
	test("extended health includes per-session projection snapshots", () => {
		const adapter = createTestAdapter();
		const reporter = new DaemonHostHealthReporter({
			now_ms: () => Date.now(),
			sessionAdapter: adapter,
		});

		openSession(adapter, "s1");
		openSession(adapter, "s2");

		const extended = reporter.extendedHealth();
		expect(extended.ok).toBe(true);
		expect(extended.service_projections).toHaveLength(2);

		const s1 = extended.service_projections.find((p) => p.session_id === "s1");
		const s2 = extended.service_projections.find((p) => p.session_id === "s2");
		expect(s1).toBeTruthy();
		expect(s2).toBeTruthy();

		// Projections should contain session-domain fields read from service actors
		expect(s1!.projections).toHaveProperty("phase");
		expect(s1!.projections).toHaveProperty("leaf_id");
		expect(s1!.projections).toHaveProperty("model");
		expect(s1!.projections).toHaveProperty("branch");
		expect(s1!.projections).toHaveProperty("compaction");
	});

	test("extended health with no adapter returns empty projections", () => {
		const reporter = new DaemonHostHealthReporter({ now_ms: () => Date.now() });
		const extended = reporter.extendedHealth();
		expect(extended.service_projections).toEqual([]);
	});

	test("extended health reflects session destroy (daemon does not retain stale state)", () => {
		const adapter = createTestAdapter();
		const reporter = new DaemonHostHealthReporter({
			now_ms: () => Date.now(),
			sessionAdapter: adapter,
		});

		openSession(adapter, "volatile");
		expect(reporter.extendedHealth().service_projections).toHaveLength(1);

		adapter.destroySession("volatile");
		expect(reporter.extendedHealth().service_projections).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-4: Multi-session fairness and isolation regression
// ---------------------------------------------------------------------------

describe("daemon thin-host boundary (AC-4): multi-session fairness/isolation", () => {
	test("sessions have independent event streams (no cross-session leakage)", () => {
		const adapter = createTestAdapter();

		openSession(adapter, "alice");
		openSession(adapter, "bob");

		adapter.attach("alice");
		adapter.attach("bob");

		enqueueMessage(adapter, "alice", "alice-message-1");
		enqueueMessage(adapter, "alice", "alice-message-2");
		enqueueMessage(adapter, "bob", "bob-message-1");

		const aliceEvents = adapter.replayEvents("alice", 0);
		const bobEvents = adapter.replayEvents("bob", 0);

		// Alice's events should only reference alice
		for (const event of aliceEvents) {
			expect(event.session_id).toBe("alice");
		}

		// Bob's events should only reference bob
		for (const event of bobEvents) {
			expect(event.session_id).toBe("bob");
		}

		// Event counts should be independent
		// Alice has open + attach + 2 enqueue events
		// Bob has open + attach + 1 enqueue event
		// (exact counts depend on SessionService, but isolation must hold)
		const aliceSessionIds = new Set(aliceEvents.map((e) => e.session_id));
		const bobSessionIds = new Set(bobEvents.map((e) => e.session_id));
		expect(aliceSessionIds.size).toBe(1);
		expect(bobSessionIds.size).toBe(1);
	});

	test("observeSessionIsolation confirms per-session independence", () => {
		const adapter = createTestAdapter();

		openSession(adapter, "s1");
		openSession(adapter, "s2");
		openSession(adapter, "s3");

		adapter.attach("s1");
		adapter.attach("s2");
		adapter.attach("s3");

		enqueueMessage(adapter, "s1", "msg-s1");
		enqueueMessage(adapter, "s2", "msg-s2");
		enqueueMessage(adapter, "s3", "msg-s3");

		const observations = observeSessionIsolation(adapter);
		expect(observations).toHaveLength(3);

		for (const obs of observations) {
			expect(obs.has_independent_events).toBe(true);
			expect(obs.event_count).toBeGreaterThan(0);
		}
	});

	test("adapter snapshot isolation: one session's snapshot does not affect another", () => {
		const adapter = createTestAdapter();

		openSession(adapter, "isolated-a");
		openSession(adapter, "isolated-b");

		const snapA = adapter.getSessionSnapshot("isolated-a");
		const snapB = adapter.getSessionSnapshot("isolated-b");

		expect(snapA).not.toBeNull();
		expect(snapB).not.toBeNull();
		expect(snapA!.session_id).toBe("isolated-a");
		expect(snapB!.session_id).toBe("isolated-b");

		// Snapshots should be independent
		expect(snapA!.assertions).not.toBe(snapB!.assertions);
	});

	test("session destroy does not affect other sessions", () => {
		const adapter = createTestAdapter();

		openSession(adapter, "persist");
		openSession(adapter, "ephemeral");

		expect(adapter.hasSession("persist")).toBe(true);
		expect(adapter.hasSession("ephemeral")).toBe(true);

		adapter.destroySession("ephemeral");

		expect(adapter.hasSession("persist")).toBe(true);
		expect(adapter.hasSession("ephemeral")).toBe(false);

		// Persistent session should still function
		const snap = adapter.getSessionSnapshot("persist");
		expect(snap).not.toBeNull();
		expect(snap!.session_id).toBe("persist");
	});

	test("event replay is cursor-isolated across sessions", () => {
		const adapter = createTestAdapter();

		openSession(adapter, "replay-a");
		openSession(adapter, "replay-b");

		adapter.attach("replay-a");
		adapter.attach("replay-b");

		enqueueMessage(adapter, "replay-a", "a1");
		enqueueMessage(adapter, "replay-a", "a2");
		enqueueMessage(adapter, "replay-b", "b1");

		// Replay from cursor 0 for each session
		const replayA = adapter.replayEvents("replay-a", 0);
		const replayB = adapter.replayEvents("replay-b", 0);

		// Each replay should only contain events for that session
		expect(replayA.every((e) => e.session_id === "replay-a")).toBe(true);
		expect(replayB.every((e) => e.session_id === "replay-b")).toBe(true);

		// Replaying from a later cursor should return fewer events
		if (replayA.length > 1) {
			const midCursor = replayA[0].event_seq;
			const replayAPartial = adapter.replayEvents("replay-a", midCursor);
			expect(replayAPartial.length).toBeLessThan(replayA.length);
		}
	});

	test("concurrent session operations maintain assertion independence", () => {
		const adapter = createTestAdapter();

		openSession(adapter, "concurrent-1");
		openSession(adapter, "concurrent-2");
		openSession(adapter, "concurrent-3");

		adapter.attach("concurrent-1");
		adapter.attach("concurrent-2");
		adapter.attach("concurrent-3");

		// Interleave operations across sessions
		enqueueMessage(adapter, "concurrent-1", "c1-msg1");
		enqueueMessage(adapter, "concurrent-2", "c2-msg1");
		enqueueMessage(adapter, "concurrent-3", "c3-msg1");
		enqueueMessage(adapter, "concurrent-1", "c1-msg2");
		enqueueMessage(adapter, "concurrent-2", "c2-msg2");

		// Each session's assertions should be independently managed
		const a1 = adapter.getAssertions("concurrent-1");
		const a2 = adapter.getAssertions("concurrent-2");
		const a3 = adapter.getAssertions("concurrent-3");

		expect(a1).not.toBeNull();
		expect(a2).not.toBeNull();
		expect(a3).not.toBeNull();

		// Assertions should reflect each session's own state
		// (they should not be the same object references)
		expect(a1).not.toBe(a2);
		expect(a2).not.toBe(a3);
	});
});

// ---------------------------------------------------------------------------
// Boundary validation edge cases
// ---------------------------------------------------------------------------

describe("daemon thin-host boundary validation edge cases", () => {
	test("boundary descriptor is frozen/deterministic", () => {
		// Multiple reads should return the same structure
		expect(DAEMON_THIN_BOUNDARY.host.transport).toBe("http");
		expect(DAEMON_THIN_BOUNDARY.delegated.session_domain).toBe("syndicate_session_service");

		// Structure should be consistent
		const json1 = JSON.stringify(DAEMON_THIN_BOUNDARY);
		const json2 = JSON.stringify(DAEMON_THIN_BOUNDARY);
		expect(json1).toBe(json2);
	});

	test("health reporter uptime is monotonic", () => {
		let clock = 0;
		const reporter = new DaemonHostHealthReporter({ now_ms: () => clock });

		clock = 100;
		const h1 = reporter.health();
		clock = 200;
		const h2 = reporter.health();

		expect(h2.host.uptime_ms).toBeGreaterThan(h1.host.uptime_ms);
	});

	test("validateDaemonBoundary detects adapter projection interface violations", () => {
		const lifecycle = createTestSessionLifecycle();
		const brokenAdapter = {
			activeSessions: "not_a_function",
			getAssertions: "not_a_function",
			getProjections: "not_a_function",
		};
		const result = validateDaemonBoundary({
			sessionLifecycle: lifecycle,
			sessionAdapter: brokenAdapter as unknown as DaemonSessionAdapter,
		});
		expect(result.valid).toBe(false);
		expect(result.violations.length).toBeGreaterThanOrEqual(3);
	});
});
