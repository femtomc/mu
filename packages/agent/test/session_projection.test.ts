import { describe, expect, test } from "bun:test";
import {
	assembleAssertionSet,
	diagnoseAssertionSet,
	emptyAssertionSet,
	isActivePhase,
	isValidMode,
	isValidPhase,
	isValidThinkingLevel,
	mergeContextResponse,
	projectBranchState,
	projectCompactionState,
	projectContext,
	projectLeafId,
	projectModelState,
	projectThinkingLevel,
	SESSION_SERVICE_PROTOCOL_VERSION,
	type CompactionStateAssertion,
	type DagAnchorAssertion,
	type EventAnchorAssertion,
	type LifecycleAssertion,
	type ModelStateAssertion,
	type QueueStateAssertion,
	type SessionAssertion,
	type SessionAssertionSet,
} from "../src/session_projection.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeLifecycle(overrides: Partial<LifecycleAssertion> = {}): LifecycleAssertion {
	return {
		kind: "session.lifecycle",
		session_id: "sess-001",
		phase: "open",
		mode: "memory",
		created_at_ms: 1772060000000,
		metadata: {},
		...overrides,
	};
}

function makeDagAnchor(overrides: Partial<DagAnchorAssertion> = {}): DagAnchorAssertion {
	return {
		kind: "session.dag_anchor",
		session_id: "sess-001",
		leaf_id: "entry-12",
		entry_count: 12,
		journal_size: 12,
		...overrides,
	};
}

function makeModelState(overrides: Partial<ModelStateAssertion> = {}): ModelStateAssertion {
	return {
		kind: "session.model_state",
		session_id: "sess-001",
		provider: "anthropic",
		model_id: "claude-sonnet-4-5",
		thinking_level: "high",
		...overrides,
	};
}

function makeQueueState(overrides: Partial<QueueStateAssertion> = {}): QueueStateAssertion {
	return {
		kind: "session.queue_state",
		session_id: "sess-001",
		pending_count: 0,
		active_turn_id: null,
		completed_count: 5,
		max_queue_depth: 1024,
		fair_cursor: 0,
		...overrides,
	};
}

function makeCompactionState(overrides: Partial<CompactionStateAssertion> = {}): CompactionStateAssertion {
	return {
		kind: "session.compaction_state",
		session_id: "sess-001",
		auto_compact_enabled: true,
		auto_retry_enabled: false,
		last_compaction_entry_id: null,
		last_compaction_at_ms: null,
		compaction_count: 0,
		retry_count: 0,
		...overrides,
	};
}

function makeEventAnchor(overrides: Partial<EventAnchorAssertion> = {}): EventAnchorAssertion {
	return {
		kind: "session.event_anchor",
		session_id: "sess-001",
		event_seq: 0,
		last_event_kind: null,
		last_event_at_ms: 0,
		...overrides,
	};
}

function makeCompleteSet(overrides: Partial<SessionAssertionSet> = {}): SessionAssertionSet {
	return {
		lifecycle: makeLifecycle(),
		queue_state: makeQueueState(),
		model_state: makeModelState(),
		compaction_state: makeCompactionState(),
		dag_anchor: makeDagAnchor(),
		event_anchor: makeEventAnchor(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

test("protocol version matches session-service/v1", () => {
	expect(SESSION_SERVICE_PROTOCOL_VERSION).toBe("session-service/v1");
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

describe("isValidPhase", () => {
	test("accepts all valid phases", () => {
		for (const phase of ["created", "open", "attached", "closing", "closed", "error"]) {
			expect(isValidPhase(phase)).toBe(true);
		}
	});

	test("rejects invalid phases", () => {
		expect(isValidPhase("unknown")).toBe(false);
		expect(isValidPhase("")).toBe(false);
		expect(isValidPhase("OPEN")).toBe(false);
	});
});

describe("isActivePhase", () => {
	test("open and attached are active", () => {
		expect(isActivePhase("open")).toBe(true);
		expect(isActivePhase("attached")).toBe(true);
	});

	test("other phases are not active", () => {
		expect(isActivePhase("created")).toBe(false);
		expect(isActivePhase("closing")).toBe(false);
		expect(isActivePhase("closed")).toBe(false);
		expect(isActivePhase("error")).toBe(false);
	});
});

describe("isValidMode", () => {
	test("accepts memory and persist", () => {
		expect(isValidMode("memory")).toBe(true);
		expect(isValidMode("persist")).toBe(true);
	});

	test("rejects invalid modes", () => {
		expect(isValidMode("hybrid")).toBe(false);
		expect(isValidMode("")).toBe(false);
	});
});

describe("isValidThinkingLevel", () => {
	test("accepts all valid levels", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			expect(isValidThinkingLevel(level)).toBe(true);
		}
	});

	test("rejects invalid levels", () => {
		expect(isValidThinkingLevel("ultra")).toBe(false);
		expect(isValidThinkingLevel("")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Assertion assembly
// ---------------------------------------------------------------------------

describe("emptyAssertionSet", () => {
	test("returns all null slots", () => {
		const set = emptyAssertionSet();
		expect(set.lifecycle).toBeNull();
		expect(set.queue_state).toBeNull();
		expect(set.model_state).toBeNull();
		expect(set.compaction_state).toBeNull();
		expect(set.dag_anchor).toBeNull();
		expect(set.event_anchor).toBeNull();
	});
});

describe("assembleAssertionSet", () => {
	test("assembles matching assertions by session_id", () => {
		const assertions: SessionAssertion[] = [
			makeLifecycle(),
			makeDagAnchor(),
			makeModelState(),
			makeQueueState(),
			makeCompactionState(),
			makeEventAnchor(),
		];
		const set = assembleAssertionSet("sess-001", assertions);
		expect(set.lifecycle).not.toBeNull();
		expect(set.dag_anchor).not.toBeNull();
		expect(set.model_state).not.toBeNull();
		expect(set.queue_state).not.toBeNull();
		expect(set.compaction_state).not.toBeNull();
		expect(set.event_anchor).not.toBeNull();
	});

	test("filters out assertions with non-matching session_id", () => {
		const assertions: SessionAssertion[] = [
			makeLifecycle({ session_id: "sess-001" }),
			makeDagAnchor({ session_id: "sess-002" }),
			makeModelState({ session_id: "sess-001" }),
		];
		const set = assembleAssertionSet("sess-001", assertions);
		expect(set.lifecycle?.session_id).toBe("sess-001");
		expect(set.dag_anchor).toBeNull();
		expect(set.model_state?.session_id).toBe("sess-001");
	});

	test("last-writer-wins for same kind", () => {
		const assertions: SessionAssertion[] = [
			makeModelState({ provider: "openai", model_id: "gpt-4o" }),
			makeModelState({ provider: "anthropic", model_id: "claude-sonnet-4-5" }),
		];
		const set = assembleAssertionSet("sess-001", assertions);
		expect(set.model_state?.provider).toBe("anthropic");
		expect(set.model_state?.model_id).toBe("claude-sonnet-4-5");
	});
});

// ---------------------------------------------------------------------------
// projectLeafId - equivalence with session_dag.leaf_id()
// ---------------------------------------------------------------------------

describe("projectLeafId", () => {
	test("returns leaf_id from dag_anchor", () => {
		const set = makeCompleteSet();
		const result = projectLeafId(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe("entry-12");
			expect(result.diagnostics).toHaveLength(0);
		}
	});

	test("returns null when dag_anchor has null leaf_id (empty session)", () => {
		const set = makeCompleteSet({
			dag_anchor: makeDagAnchor({ leaf_id: null, entry_count: 0, journal_size: 0 }),
		});
		const result = projectLeafId(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBeNull();
		}
	});

	test("returns null with diagnostic when dag_anchor is missing", () => {
		const set = makeCompleteSet({ dag_anchor: null });
		const result = projectLeafId(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBeNull();
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.kind).toBe("missing_assertion");
		}
	});

	test("fails when lifecycle is missing", () => {
		const set = makeCompleteSet({ lifecycle: null });
		const result = projectLeafId(set);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("missing_assertion");
			expect(result.error.assertion_kind).toBe("session.lifecycle");
		}
	});
});

// ---------------------------------------------------------------------------
// projectModelState - equivalence with session_dag.path_model()
// ---------------------------------------------------------------------------

describe("projectModelState", () => {
	test("returns model from model_state assertion", () => {
		const set = makeCompleteSet();
		const result = projectModelState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.provider).toBe("anthropic");
			expect(result.value.model_id).toBe("claude-sonnet-4-5");
			expect(result.value.thinking_level).toBe("high");
			expect(result.diagnostics).toHaveLength(0);
		}
	});

	test("returns defaults when model_state is missing", () => {
		const set = makeCompleteSet({ model_state: null });
		const result = projectModelState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.provider).toBeNull();
			expect(result.value.model_id).toBeNull();
			expect(result.value.thinking_level).toBe("off");
			expect(result.diagnostics).toHaveLength(1);
		}
	});

	test("returns null provider/model_id when assertion has nulls", () => {
		const set = makeCompleteSet({
			model_state: makeModelState({ provider: null, model_id: null, thinking_level: "minimal" }),
		});
		const result = projectModelState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.provider).toBeNull();
			expect(result.value.model_id).toBeNull();
			expect(result.value.thinking_level).toBe("minimal");
		}
	});
});

// ---------------------------------------------------------------------------
// projectThinkingLevel - equivalence with session_dag.path_thinking_level()
// ---------------------------------------------------------------------------

describe("projectThinkingLevel", () => {
	test("returns thinking level from model_state", () => {
		const set = makeCompleteSet({
			model_state: makeModelState({ thinking_level: "xhigh" }),
		});
		const result = projectThinkingLevel(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe("xhigh");
		}
	});

	test("defaults to off when model_state missing", () => {
		const set = makeCompleteSet({ model_state: null });
		const result = projectThinkingLevel(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe("off");
		}
	});
});

// ---------------------------------------------------------------------------
// projectBranchState - branch/leaf state from assertions
// ---------------------------------------------------------------------------

describe("projectBranchState", () => {
	test("returns complete branch state for active session", () => {
		const set = makeCompleteSet();
		const result = projectBranchState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.session_id).toBe("sess-001");
			expect(result.value.leaf_id).toBe("entry-12");
			expect(result.value.entry_count).toBe(12);
			expect(result.value.journal_size).toBe(12);
			expect(result.value.branch_active).toBe(true);
			expect(result.diagnostics).toHaveLength(0);
		}
	});

	test("branch_active is true for attached phase", () => {
		const set = makeCompleteSet({
			lifecycle: makeLifecycle({ phase: "attached" }),
		});
		const result = projectBranchState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.branch_active).toBe(true);
		}
	});

	test("branch_active is false for created phase", () => {
		const set = makeCompleteSet({
			lifecycle: makeLifecycle({ phase: "created" }),
		});
		const result = projectBranchState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.branch_active).toBe(false);
		}
	});

	test("branch_active is false for closing/closed/error phases", () => {
		for (const phase of ["closing", "closed", "error"] as const) {
			const set = makeCompleteSet({
				lifecycle: makeLifecycle({ phase }),
			});
			const result = projectBranchState(set);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.branch_active).toBe(false);
			}
		}
	});

	test("records stale diagnostic when dag_anchor present in terminal phase", () => {
		const set = makeCompleteSet({
			lifecycle: makeLifecycle({ phase: "closed" }),
		});
		const result = projectBranchState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const stale = result.diagnostics.find((d) => d.kind === "stale_assertion");
			expect(stale).toBeDefined();
		}
	});

	test("defaults when dag_anchor missing", () => {
		const set = makeCompleteSet({ dag_anchor: null });
		const result = projectBranchState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.leaf_id).toBeNull();
			expect(result.value.entry_count).toBe(0);
			expect(result.value.journal_size).toBe(0);
			expect(result.diagnostics).toHaveLength(1);
		}
	});
});

// ---------------------------------------------------------------------------
// projectCompactionState
// ---------------------------------------------------------------------------

describe("projectCompactionState", () => {
	test("returns compaction state from assertion", () => {
		const set = makeCompleteSet({
			compaction_state: makeCompactionState({
				auto_compact_enabled: true,
				auto_retry_enabled: true,
				last_compaction_entry_id: "entry-7",
				last_compaction_at_ms: 1772060010000,
				compaction_count: 3,
				retry_count: 1,
			}),
		});
		const result = projectCompactionState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.auto_compact_enabled).toBe(true);
			expect(result.value.auto_retry_enabled).toBe(true);
			expect(result.value.last_compaction_entry_id).toBe("entry-7");
			expect(result.value.compaction_count).toBe(3);
			expect(result.value.retry_count).toBe(1);
		}
	});

	test("defaults when compaction_state missing", () => {
		const set = makeCompleteSet({ compaction_state: null });
		const result = projectCompactionState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.auto_compact_enabled).toBe(false);
			expect(result.value.auto_retry_enabled).toBe(false);
			expect(result.value.last_compaction_entry_id).toBeNull();
			expect(result.value.compaction_count).toBe(0);
			expect(result.diagnostics).toHaveLength(1);
		}
	});
});

// ---------------------------------------------------------------------------
// projectContext - equivalence with session_dag.build_context()
// ---------------------------------------------------------------------------

describe("projectContext", () => {
	test("produces session_context shape with messages and derived metadata", () => {
		const set = makeCompleteSet();
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		];
		const result = projectContext(set, messages);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.kind).toBe("session_context");
			expect(result.value.messages).toEqual(messages);
			expect(result.value.thinking_level).toBe("high");
			expect(result.value.model).toEqual({ provider: "anthropic", model_id: "claude-sonnet-4-5" });
			expect(result.diagnostics).toHaveLength(0);
		}
	});

	test("model is null when provider or model_id is null", () => {
		const set = makeCompleteSet({
			model_state: makeModelState({ provider: null, model_id: null, thinking_level: "medium" }),
		});
		const result = projectContext(set, []);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.model).toBeNull();
			expect(result.value.thinking_level).toBe("medium");
		}
	});

	test("defaults to empty messages with diagnostic when contextMessages is null", () => {
		const set = makeCompleteSet();
		const result = projectContext(set, null);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.messages).toEqual([]);
			const msgDiag = result.diagnostics.find((d) => d.assertion_kind === "session.context");
			expect(msgDiag).toBeDefined();
		}
	});

	test("defaults to off/null when model_state missing", () => {
		const set = makeCompleteSet({ model_state: null });
		const result = projectContext(set, [{ role: "user", content: "test" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.thinking_level).toBe("off");
			expect(result.value.model).toBeNull();
			expect(result.diagnostics).toHaveLength(1);
		}
	});

	test("fails when lifecycle missing", () => {
		const set = makeCompleteSet({ lifecycle: null });
		const result = projectContext(set, []);
		expect(result.ok).toBe(false);
	});

	// Equivalence: build_context on empty session returns {kind: "session_context", messages: [], thinking_level: "off", model: nil}
	test("equivalence: empty session produces off/null/empty context", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle({ phase: "open" }),
			queue_state: makeQueueState(),
			model_state: makeModelState({ provider: null, model_id: null, thinking_level: "off" }),
			compaction_state: makeCompactionState(),
			dag_anchor: makeDagAnchor({ leaf_id: null, entry_count: 0 }),
			event_anchor: makeEventAnchor(),
		};
		const result = projectContext(set, []);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.kind).toBe("session_context");
			expect(result.value.messages).toEqual([]);
			expect(result.value.thinking_level).toBe("off");
			expect(result.value.model).toBeNull();
		}
	});

	// Equivalence: build_context with model/thinking set returns those values
	test("equivalence: session with model/thinking returns matching context", () => {
		const set = makeCompleteSet({
			model_state: makeModelState({
				provider: "openai-codex",
				model_id: "gpt-5.3-codex",
				thinking_level: "xhigh",
			}),
		});
		const messages = [
			{ role: "user", content: "build this" },
			{ role: "assistant", content: "done", provider: "openai-codex", model: "gpt-5.3-codex" },
		];
		const result = projectContext(set, messages);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.thinking_level).toBe("xhigh");
			expect(result.value.model).toEqual({ provider: "openai-codex", model_id: "gpt-5.3-codex" });
			expect(result.value.messages).toHaveLength(2);
		}
	});
});

// ---------------------------------------------------------------------------
// mergeContextResponse
// ---------------------------------------------------------------------------

describe("mergeContextResponse", () => {
	test("merges response messages with assertion-derived metadata", () => {
		const set = makeCompleteSet();
		const response = {
			session_id: "sess-001",
			messages: [{ role: "user", content: "hello" }],
			thinking_level: "medium",
			model: { provider: "openai", model_id: "gpt-4o" },
		};
		const result = mergeContextResponse(set, response);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// Assertion-derived values take precedence.
			expect(result.value.thinking_level).toBe("high");
			expect(result.value.model).toEqual({ provider: "anthropic", model_id: "claude-sonnet-4-5" });
			expect(result.value.messages).toEqual(response.messages);
		}
	});

	test("falls back to response values when model_state assertion missing", () => {
		const set = makeCompleteSet({ model_state: null });
		const response = {
			session_id: "sess-001",
			messages: [],
			thinking_level: "medium" as const,
			model: { provider: "openai", model_id: "gpt-4o" } as const,
		};
		const result = mergeContextResponse(set, response);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.thinking_level).toBe("medium");
			expect(result.value.model).toEqual({ provider: "openai", model_id: "gpt-4o" });
			expect(result.diagnostics.some((d) => d.kind === "missing_assertion")).toBe(true);
		}
	});

	test("records diagnostic on session_id mismatch", () => {
		const set = makeCompleteSet();
		const response = {
			session_id: "sess-other",
			messages: [],
		};
		const result = mergeContextResponse(set, response);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const mismatch = result.diagnostics.find((d) => d.kind === "stale_assertion");
			expect(mismatch).toBeDefined();
			expect(mismatch?.detail).toContain("sess-other");
		}
	});

	test("fails when lifecycle missing", () => {
		const set = makeCompleteSet({ lifecycle: null });
		const response = { session_id: "sess-001", messages: [] };
		const result = mergeContextResponse(set, response);
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// diagnoseAssertionSet
// ---------------------------------------------------------------------------

describe("diagnoseAssertionSet", () => {
	test("returns empty for complete healthy set", () => {
		const set = makeCompleteSet();
		const errors = diagnoseAssertionSet(set);
		expect(errors).toHaveLength(0);
	});

	test("reports missing lifecycle", () => {
		const set = emptyAssertionSet();
		const errors = diagnoseAssertionSet(set);
		expect(errors.some((e) => e.assertion_kind === "session.lifecycle")).toBe(true);
	});

	test("reports all missing assertions except lifecycle", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle(),
			queue_state: null,
			model_state: null,
			compaction_state: null,
			dag_anchor: null,
			event_anchor: null,
		};
		const errors = diagnoseAssertionSet(set);
		const kinds = errors.map((e) => e.assertion_kind);
		expect(kinds).toContain("session.queue_state");
		expect(kinds).toContain("session.model_state");
		expect(kinds).toContain("session.compaction_state");
		expect(kinds).toContain("session.dag_anchor");
		expect(kinds).toContain("session.event_anchor");
	});

	test("reports stale dag_anchor when phase is closed", () => {
		const set = makeCompleteSet({
			lifecycle: makeLifecycle({ phase: "closed" }),
		});
		const errors = diagnoseAssertionSet(set);
		const stale = errors.find(
			(e) => e.kind === "stale_assertion" && e.assertion_kind === "session.dag_anchor",
		);
		expect(stale).toBeDefined();
	});

	test("reports session_id mismatch across assertions", () => {
		const set = makeCompleteSet({
			model_state: makeModelState({ session_id: "sess-other" }),
		});
		const errors = diagnoseAssertionSet(set);
		const mismatch = errors.find(
			(e) => e.kind === "stale_assertion" && e.assertion_kind === "session.model_state",
		);
		expect(mismatch).toBeDefined();
		expect(mismatch?.detail).toContain("sess-other");
	});
});

// ---------------------------------------------------------------------------
// Roundtrip vectors parity (assertion shapes from frozen test vectors)
// ---------------------------------------------------------------------------

describe("roundtrip vector parity", () => {
	test("lifecycle assertion fields match protocol vector", () => {
		// From roundtrip_vectors.json: lifecycle-open-persist
		const assertion: LifecycleAssertion = {
			kind: "session.lifecycle",
			session_id: "sess-002",
			phase: "open",
			mode: "persist",
			created_at_ms: 1772060001000,
			metadata: { channel: "telegram", workspace: "/home/user/project" },
		};
		const set = assembleAssertionSet("sess-002", [assertion]);
		expect(set.lifecycle).not.toBeNull();
		expect(set.lifecycle?.phase).toBe("open");
		expect(set.lifecycle?.mode).toBe("persist");

		const leafResult = projectLeafId({ ...emptyAssertionSet(), lifecycle: assertion });
		expect(leafResult.ok).toBe(true);
		if (leafResult.ok) {
			expect(leafResult.value).toBeNull(); // no dag_anchor
		}
	});

	test("model_state assertion fields match protocol vector", () => {
		// From roundtrip_vectors.json: model-openai-xhigh
		const assertion: ModelStateAssertion = {
			kind: "session.model_state",
			session_id: "sess-002",
			provider: "openai-codex",
			model_id: "gpt-5.3-codex",
			thinking_level: "xhigh",
		};
		const set: SessionAssertionSet = {
			...emptyAssertionSet(),
			lifecycle: makeLifecycle({ session_id: "sess-002" }),
			model_state: assertion,
		};
		const result = projectModelState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.provider).toBe("openai-codex");
			expect(result.value.model_id).toBe("gpt-5.3-codex");
			expect(result.value.thinking_level).toBe("xhigh");
		}
	});

	test("dag_anchor assertion fields match protocol vector", () => {
		// From roundtrip_vectors.json: dag-populated
		const assertion: DagAnchorAssertion = {
			kind: "session.dag_anchor",
			session_id: "sess-002",
			leaf_id: "entry-12",
			entry_count: 12,
			journal_size: 12,
		};
		const set: SessionAssertionSet = {
			...emptyAssertionSet(),
			lifecycle: makeLifecycle({ session_id: "sess-002" }),
			dag_anchor: assertion,
		};
		const result = projectBranchState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.leaf_id).toBe("entry-12");
			expect(result.value.entry_count).toBe(12);
			expect(result.value.journal_size).toBe(12);
		}
	});

	test("compaction_state assertion fields match protocol vector", () => {
		// From roundtrip_vectors.json: compaction-after-run
		const assertion: CompactionStateAssertion = {
			kind: "session.compaction_state",
			session_id: "sess-002",
			auto_compact_enabled: true,
			auto_retry_enabled: true,
			last_compaction_entry_id: "entry-7",
			last_compaction_at_ms: 1772060010000,
			compaction_count: 3,
			retry_count: 1,
		};
		const set: SessionAssertionSet = {
			...emptyAssertionSet(),
			lifecycle: makeLifecycle({ session_id: "sess-002" }),
			compaction_state: assertion,
		};
		const result = projectCompactionState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.last_compaction_entry_id).toBe("entry-7");
			expect(result.value.compaction_count).toBe(3);
			expect(result.value.retry_count).toBe(1);
		}
	});
});

// ---------------------------------------------------------------------------
// Equivalence scenarios: assertion projection matches session_dag semantics
// ---------------------------------------------------------------------------

describe("equivalence: assertion projection vs session_dag helpers", () => {
	// session_dag.leaf_id(new()) returns nil
	test("empty session: leaf_id is null", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle(),
			queue_state: makeQueueState(),
			model_state: makeModelState({ provider: null, model_id: null, thinking_level: "off" }),
			compaction_state: makeCompactionState(),
			dag_anchor: makeDagAnchor({ leaf_id: null, entry_count: 0, journal_size: 0 }),
			event_anchor: makeEventAnchor(),
		};
		const result = projectLeafId(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBeNull();
		}
	});

	// session_dag.build_context(new()) returns {kind: "session_context", messages: [], thinking_level: "off", model: nil}
	test("empty session: context is empty/off/null", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle(),
			queue_state: makeQueueState(),
			model_state: makeModelState({ provider: null, model_id: null, thinking_level: "off" }),
			compaction_state: makeCompactionState(),
			dag_anchor: makeDagAnchor({ leaf_id: null, entry_count: 0, journal_size: 0 }),
			event_anchor: makeEventAnchor(),
		};
		const result = projectContext(set, []);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				kind: "session_context",
				messages: [],
				thinking_level: "off",
				model: null,
			});
		}
	});

	// After append_message + append_thinking_level("high"):
	// leaf_id is "entry-2", thinking_level is "high", messages contains user message
	test("session with messages and thinking: leaf/model/thinking match", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle(),
			queue_state: makeQueueState(),
			model_state: makeModelState({ thinking_level: "high", provider: null, model_id: null }),
			compaction_state: makeCompactionState(),
			dag_anchor: makeDagAnchor({ leaf_id: "entry-2", entry_count: 2, journal_size: 2 }),
			event_anchor: makeEventAnchor({ event_seq: 2 }),
		};

		const leafResult = projectLeafId(set);
		expect(leafResult.ok).toBe(true);
		if (leafResult.ok) {
			expect(leafResult.value).toBe("entry-2");
		}

		const thinkingResult = projectThinkingLevel(set);
		expect(thinkingResult.ok).toBe(true);
		if (thinkingResult.ok) {
			expect(thinkingResult.value).toBe("high");
		}
	});

	// After append_model_change("anthropic", "claude-sonnet-4-5"):
	// path_model returns {provider: "anthropic", model_id: "claude-sonnet-4-5"}
	test("session with model change: model state matches", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle(),
			queue_state: makeQueueState(),
			model_state: makeModelState({ provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" }),
			compaction_state: makeCompactionState(),
			dag_anchor: makeDagAnchor({ leaf_id: "entry-3", entry_count: 3 }),
			event_anchor: makeEventAnchor(),
		};

		const modelResult = projectModelState(set);
		expect(modelResult.ok).toBe(true);
		if (modelResult.ok) {
			expect(modelResult.value.provider).toBe("anthropic");
			expect(modelResult.value.model_id).toBe("claude-sonnet-4-5");
		}
	});

	// After branch(session, "entry-1"):
	// leaf_id changes to "entry-1"
	test("session after branch: leaf_id reflects new branch point", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle(),
			queue_state: makeQueueState(),
			model_state: makeModelState(),
			compaction_state: makeCompactionState(),
			dag_anchor: makeDagAnchor({ leaf_id: "entry-1", entry_count: 5 }),
			event_anchor: makeEventAnchor(),
		};

		const leafResult = projectLeafId(set);
		expect(leafResult.ok).toBe(true);
		if (leafResult.ok) {
			expect(leafResult.value).toBe("entry-1");
		}
	});

	// After compaction: compaction_state reflects compaction metadata
	test("session after compaction: compaction state matches", () => {
		const set: SessionAssertionSet = {
			lifecycle: makeLifecycle(),
			queue_state: makeQueueState(),
			model_state: makeModelState(),
			compaction_state: makeCompactionState({
				auto_compact_enabled: true,
				last_compaction_entry_id: "entry-5",
				last_compaction_at_ms: 1772060010000,
				compaction_count: 1,
			}),
			dag_anchor: makeDagAnchor({ leaf_id: "entry-6", entry_count: 6 }),
			event_anchor: makeEventAnchor(),
		};

		const compResult = projectCompactionState(set);
		expect(compResult.ok).toBe(true);
		if (compResult.ok) {
			expect(compResult.value.last_compaction_entry_id).toBe("entry-5");
			expect(compResult.value.compaction_count).toBe(1);
		}
	});
});

// ---------------------------------------------------------------------------
// Intentional deltas from session_dag semantics (documented)
// ---------------------------------------------------------------------------

describe("intentional deltas from session_dag semantics", () => {
	// Delta 1: session_dag.build_context() walks the full entry path and
	// accumulates messages inline. The assertion-based projection separates
	// message retrieval (via session.project_context command) from metadata
	// projection (via assertions). This decoupling is intentional: daemon
	// adapters observe assertions reactively and request full context on demand,
	// avoiding the need to maintain a local DAG replica.
	test("delta: context messages are externally supplied, not inline-projected", () => {
		const set = makeCompleteSet();
		// With null messages (not fetched yet), projection returns empty array.
		const result = projectContext(set, null);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.messages).toEqual([]);
			// Diagnostic documents the delta.
			expect(result.diagnostics.some((d) => d.detail.includes("session.project_context"))).toBe(true);
		}
	});

	// Delta 2: session_dag path_model() walks entries and picks the last
	// model_change entry or assistant message with provider/model. The
	// assertion-based projection reads the single model_state assertion
	// which represents the service actor's authoritative current state.
	// This is equivalent when the service actor correctly updates
	// model_state on every model change; any divergence is a service bug.
	test("delta: model state is single-assertion, not path-accumulated", () => {
		const set = makeCompleteSet({
			model_state: makeModelState({
				provider: "openai-codex",
				model_id: "gpt-5.3-codex",
				thinking_level: "xhigh",
			}),
		});
		const result = projectModelState(set);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// Single authoritative value, not accumulated from path.
			expect(result.value.provider).toBe("openai-codex");
			expect(result.value.model_id).toBe("gpt-5.3-codex");
			expect(result.value.thinking_level).toBe("xhigh");
		}
	});

	// Delta 3: session_dag has no concept of session lifecycle phases.
	// The assertion-based projection gates all outputs on lifecycle
	// validity. Projections fail with missing_assertion when lifecycle
	// is absent, and produce stale_assertion diagnostics when terminal.
	test("delta: lifecycle gating is assertion-only (not in session_dag)", () => {
		const set = makeCompleteSet({ lifecycle: null });
		const leafResult = projectLeafId(set);
		expect(leafResult.ok).toBe(false);

		const contextResult = projectContext(set, []);
		expect(contextResult.ok).toBe(false);

		const branchResult = projectBranchState(set);
		expect(branchResult.ok).toBe(false);
	});
});
