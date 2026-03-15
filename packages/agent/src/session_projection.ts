/**
 * Session projection module (session-service/v1).
 *
 * Derives active branch/leaf/context outputs from assertion-native state
 * as defined by the session-service/v1 protocol
 * (session_service_protocol.syndicate).
 *
 * Design contract:
 *   - Projection helpers consume only assertion records (lifecycle,
 *     queue_state, model_state, compaction_state, dag_anchor,
 *     event_anchor). They never access the underlying session DAG
 *     directly.
 *   - Context projection (full message list) requires an externally
 *     supplied SessionContextResponse, obtained via the
 *     session.project_context command/response cycle. The projection
 *     module assembles the derived metadata (model, thinking_level)
 *     from assertions and merges it with the supplied messages.
 *   - Missing or stale assertions produce explicit ProjectionError
 *     values. Callers decide recovery policy.
 *
 * Equivalence to session_dag.syndicate helpers:
 *   - projectLeafId(set)          <=> leaf_id(session_value)
 *   - projectModelState(set)      <=> path_model(get_branch(...), 0, nil)
 *   - projectThinkingLevel(set)   <=> path_thinking_level(get_branch(...), 0, "off")
 *   - projectContext(set, msgs)   <=> build_context(session_value)
 *   - projectBranchState(set)     <=> {leaf_id, entry_count, branch_active}
 *
 * Failure/recovery behavior:
 *   - Missing lifecycle assertion: session is treated as nonexistent.
 *     ProjectionError with kind "missing_assertion" is returned.
 *   - Missing dag_anchor: leaf_id defaults to null, entry_count to 0.
 *     ProjectionError with kind "missing_assertion" is included in
 *     diagnostics but projection proceeds with defaults.
 *   - Missing model_state: model defaults to null, thinking_level to
 *     "off". Projection proceeds; error recorded in diagnostics.
 *   - Missing compaction_state: compaction metadata defaults to
 *     zero/null. Projection proceeds; error recorded in diagnostics.
 *   - Stale assertions (phase mismatch, e.g., lifecycle says "closed"
 *     but dag_anchor still present): ProjectionError with kind
 *     "stale_assertion" is returned. Caller should treat as terminal.
 *   - Invalid phase values: ProjectionError with kind "invalid_phase".
 *
 * Daemon adapter consumption:
 *   - Import types and projection functions from this module.
 *   - Observe assertion records from the Syndicate dataspace.
 *   - Call assembleAssertionSet() to collect per-session state.
 *   - Call projection functions to derive outputs without duplicating
 *     business logic.
 */

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const SESSION_SERVICE_PROTOCOL_VERSION = "session-service/v1";

const VALID_PHASES = new Set([
	"created",
	"open",
	"attached",
	"closing",
	"closed",
	"error",
] as const);

const ACTIVE_PHASES = new Set(["open", "attached"] as const);

const VALID_MODES = new Set(["memory", "persist"] as const);

const VALID_THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const);

// ---------------------------------------------------------------------------
// Assertion types (mirrors session_service_protocol.syndicate)
// ---------------------------------------------------------------------------

export type SessionPhase = "created" | "open" | "attached" | "closing" | "closed" | "error";
export type SessionMode = "memory" | "persist";
export type SessionThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type LifecycleAssertion = {
	readonly kind: "session.lifecycle";
	readonly session_id: string;
	readonly phase: SessionPhase;
	readonly mode: SessionMode;
	readonly created_at_ms: number;
	readonly metadata: unknown;
};

export type QueueStateAssertion = {
	readonly kind: "session.queue_state";
	readonly session_id: string;
	readonly pending_count: number;
	readonly active_turn_id: string | null;
	readonly completed_count: number;
	readonly max_queue_depth: number;
	readonly fair_cursor: number;
};

export type ModelStateAssertion = {
	readonly kind: "session.model_state";
	readonly session_id: string;
	readonly provider: string | null;
	readonly model_id: string | null;
	readonly thinking_level: SessionThinkingLevel;
};

export type CompactionStateAssertion = {
	readonly kind: "session.compaction_state";
	readonly session_id: string;
	readonly auto_compact_enabled: boolean;
	readonly auto_retry_enabled: boolean;
	readonly last_compaction_entry_id: string | null;
	readonly last_compaction_at_ms: number | null;
	readonly compaction_count: number;
	readonly retry_count: number;
};

export type DagAnchorAssertion = {
	readonly kind: "session.dag_anchor";
	readonly session_id: string;
	readonly leaf_id: string | null;
	readonly entry_count: number;
	readonly journal_size: number;
};

export type EventAnchorAssertion = {
	readonly kind: "session.event_anchor";
	readonly session_id: string;
	readonly event_seq: number;
	readonly last_event_kind: string | null;
	readonly last_event_at_ms: number;
};

export type SessionAssertion =
	| LifecycleAssertion
	| QueueStateAssertion
	| ModelStateAssertion
	| CompactionStateAssertion
	| DagAnchorAssertion
	| EventAnchorAssertion;

// ---------------------------------------------------------------------------
// Assertion set (assembled per-session state)
// ---------------------------------------------------------------------------

export type SessionAssertionSet = {
	readonly lifecycle: LifecycleAssertion | null;
	readonly queue_state: QueueStateAssertion | null;
	readonly model_state: ModelStateAssertion | null;
	readonly compaction_state: CompactionStateAssertion | null;
	readonly dag_anchor: DagAnchorAssertion | null;
	readonly event_anchor: EventAnchorAssertion | null;
};

// ---------------------------------------------------------------------------
// Projection output types
// ---------------------------------------------------------------------------

/**
 * Context projection output.
 *
 * Shape matches session_dag.syndicate build_context() output:
 * {kind: "session_context", messages: [...], thinking_level: "...", model: ...}
 */
export type SessionContextProjection = {
	readonly kind: "session_context";
	readonly messages: ReadonlyArray<unknown>;
	readonly thinking_level: SessionThinkingLevel;
	readonly model: { readonly provider: string; readonly model_id: string } | null;
};

/**
 * Branch/leaf state derived from assertions.
 */
export type SessionBranchProjection = {
	readonly session_id: string;
	readonly leaf_id: string | null;
	readonly entry_count: number;
	readonly journal_size: number;
	readonly branch_active: boolean;
};

/**
 * Model state derived from assertions.
 */
export type SessionModelProjection = {
	readonly provider: string | null;
	readonly model_id: string | null;
	readonly thinking_level: SessionThinkingLevel;
};

/**
 * Compaction state derived from assertions.
 */
export type SessionCompactionProjection = {
	readonly auto_compact_enabled: boolean;
	readonly auto_retry_enabled: boolean;
	readonly last_compaction_entry_id: string | null;
	readonly last_compaction_at_ms: number | null;
	readonly compaction_count: number;
	readonly retry_count: number;
};

// ---------------------------------------------------------------------------
// Projection errors
// ---------------------------------------------------------------------------

export type ProjectionErrorKind = "missing_assertion" | "stale_assertion" | "invalid_phase";

export type ProjectionError = {
	readonly kind: ProjectionErrorKind;
	readonly assertion_kind: string;
	readonly session_id: string;
	readonly detail: string;
};

export type ProjectionResult<T> =
	| { readonly ok: true; readonly value: T; readonly diagnostics: ReadonlyArray<ProjectionError> }
	| { readonly ok: false; readonly error: ProjectionError };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function isValidPhase(value: string): value is SessionPhase {
	return VALID_PHASES.has(value as SessionPhase);
}

export function isActivePhase(phase: SessionPhase): boolean {
	return ACTIVE_PHASES.has(phase as "open" | "attached");
}

export function isValidMode(value: string): value is SessionMode {
	return VALID_MODES.has(value as SessionMode);
}

export function isValidThinkingLevel(value: string): value is SessionThinkingLevel {
	return VALID_THINKING_LEVELS.has(value as SessionThinkingLevel);
}

// ---------------------------------------------------------------------------
// Assertion assembly
// ---------------------------------------------------------------------------

/**
 * Create an empty assertion set.
 */
export function emptyAssertionSet(): SessionAssertionSet {
	return {
		lifecycle: null,
		queue_state: null,
		model_state: null,
		compaction_state: null,
		dag_anchor: null,
		event_anchor: null,
	};
}

/**
 * Assemble a SessionAssertionSet from an iterable of assertions.
 *
 * Assertions are keyed by kind; later assertions for the same kind
 * overwrite earlier ones (last-writer-wins, matching Syndicate
 * assertion retract-and-reassert semantics).
 *
 * Only assertions matching the given session_id are included.
 */
export function assembleAssertionSet(
	sessionId: string,
	assertions: Iterable<SessionAssertion>,
): SessionAssertionSet {
	const set: {
		lifecycle: LifecycleAssertion | null;
		queue_state: QueueStateAssertion | null;
		model_state: ModelStateAssertion | null;
		compaction_state: CompactionStateAssertion | null;
		dag_anchor: DagAnchorAssertion | null;
		event_anchor: EventAnchorAssertion | null;
	} = {
		lifecycle: null,
		queue_state: null,
		model_state: null,
		compaction_state: null,
		dag_anchor: null,
		event_anchor: null,
	};

	for (const assertion of assertions) {
		if (assertion.session_id !== sessionId) {
			continue;
		}
		switch (assertion.kind) {
			case "session.lifecycle":
				set.lifecycle = assertion;
				break;
			case "session.queue_state":
				set.queue_state = assertion;
				break;
			case "session.model_state":
				set.model_state = assertion;
				break;
			case "session.compaction_state":
				set.compaction_state = assertion;
				break;
			case "session.dag_anchor":
				set.dag_anchor = assertion;
				break;
			case "session.event_anchor":
				set.event_anchor = assertion;
				break;
		}
	}

	return set;
}

// ---------------------------------------------------------------------------
// Projection functions
// ---------------------------------------------------------------------------

/**
 * Project leaf_id from assertion state.
 *
 * Equivalent to: session_dag.leaf_id(session_value)
 *
 * Returns dag_anchor.leaf_id when available, null otherwise.
 */
export function projectLeafId(set: SessionAssertionSet): ProjectionResult<string | null> {
	if (!set.lifecycle) {
		return {
			ok: false,
			error: {
				kind: "missing_assertion",
				assertion_kind: "session.lifecycle",
				session_id: "",
				detail: "Cannot project leaf_id: session lifecycle assertion is missing.",
			},
		};
	}

	const sessionId = set.lifecycle.session_id;

	if (!isValidPhase(set.lifecycle.phase)) {
		return {
			ok: false,
			error: {
				kind: "invalid_phase",
				assertion_kind: "session.lifecycle",
				session_id: sessionId,
				detail: `Invalid lifecycle phase: "${set.lifecycle.phase}".`,
			},
		};
	}

	const diagnostics: ProjectionError[] = [];

	if (!set.dag_anchor) {
		diagnostics.push({
			kind: "missing_assertion",
			assertion_kind: "session.dag_anchor",
			session_id: sessionId,
			detail: "dag_anchor missing; leaf_id defaults to null.",
		});
		return { ok: true, value: null, diagnostics };
	}

	return { ok: true, value: set.dag_anchor.leaf_id, diagnostics };
}

/**
 * Project model state from assertions.
 *
 * Equivalent to: session_dag.path_model(get_branch(session_value), 0, nil)
 *
 * Returns model/thinking from model_state assertion when available,
 * defaults to null/off otherwise.
 */
export function projectModelState(set: SessionAssertionSet): ProjectionResult<SessionModelProjection> {
	if (!set.lifecycle) {
		return {
			ok: false,
			error: {
				kind: "missing_assertion",
				assertion_kind: "session.lifecycle",
				session_id: "",
				detail: "Cannot project model state: session lifecycle assertion is missing.",
			},
		};
	}

	const sessionId = set.lifecycle.session_id;
	const diagnostics: ProjectionError[] = [];

	if (!set.model_state) {
		diagnostics.push({
			kind: "missing_assertion",
			assertion_kind: "session.model_state",
			session_id: sessionId,
			detail: "model_state missing; defaults to provider=null, model_id=null, thinking_level=off.",
		});
		return {
			ok: true,
			value: { provider: null, model_id: null, thinking_level: "off" },
			diagnostics,
		};
	}

	return {
		ok: true,
		value: {
			provider: set.model_state.provider,
			model_id: set.model_state.model_id,
			thinking_level: set.model_state.thinking_level,
		},
		diagnostics,
	};
}

/**
 * Project thinking level from assertions.
 *
 * Equivalent to: session_dag.path_thinking_level(get_branch(session_value), 0, "off")
 */
export function projectThinkingLevel(set: SessionAssertionSet): ProjectionResult<SessionThinkingLevel> {
	const modelResult = projectModelState(set);
	if (!modelResult.ok) {
		return modelResult;
	}
	return {
		ok: true,
		value: modelResult.value.thinking_level,
		diagnostics: modelResult.diagnostics,
	};
}

/**
 * Project branch state from assertions.
 *
 * Derives {session_id, leaf_id, entry_count, journal_size, branch_active}
 * from lifecycle + dag_anchor assertions.
 */
export function projectBranchState(set: SessionAssertionSet): ProjectionResult<SessionBranchProjection> {
	if (!set.lifecycle) {
		return {
			ok: false,
			error: {
				kind: "missing_assertion",
				assertion_kind: "session.lifecycle",
				session_id: "",
				detail: "Cannot project branch state: session lifecycle assertion is missing.",
			},
		};
	}

	const sessionId = set.lifecycle.session_id;

	if (!isValidPhase(set.lifecycle.phase)) {
		return {
			ok: false,
			error: {
				kind: "invalid_phase",
				assertion_kind: "session.lifecycle",
				session_id: sessionId,
				detail: `Invalid lifecycle phase: "${set.lifecycle.phase}".`,
			},
		};
	}

	const diagnostics: ProjectionError[] = [];
	const branchActive = isActivePhase(set.lifecycle.phase);

	if (!set.dag_anchor) {
		diagnostics.push({
			kind: "missing_assertion",
			assertion_kind: "session.dag_anchor",
			session_id: sessionId,
			detail: "dag_anchor missing; branch state defaults to leaf_id=null, entry_count=0, journal_size=0.",
		});
		return {
			ok: true,
			value: {
				session_id: sessionId,
				leaf_id: null,
				entry_count: 0,
				journal_size: 0,
				branch_active: branchActive,
			},
			diagnostics,
		};
	}

	// Staleness check: if lifecycle says closed/error but dag_anchor is still present,
	// the assertion set may be stale. We still project but record the diagnostic.
	if (set.lifecycle.phase === "closed" || set.lifecycle.phase === "error") {
		diagnostics.push({
			kind: "stale_assertion",
			assertion_kind: "session.dag_anchor",
			session_id: sessionId,
			detail: `dag_anchor present but lifecycle phase is "${set.lifecycle.phase}"; assertion may be stale.`,
		});
	}

	return {
		ok: true,
		value: {
			session_id: sessionId,
			leaf_id: set.dag_anchor.leaf_id,
			entry_count: set.dag_anchor.entry_count,
			journal_size: set.dag_anchor.journal_size,
			branch_active: branchActive,
		},
		diagnostics,
	};
}

/**
 * Project compaction state from assertions.
 */
export function projectCompactionState(set: SessionAssertionSet): ProjectionResult<SessionCompactionProjection> {
	if (!set.lifecycle) {
		return {
			ok: false,
			error: {
				kind: "missing_assertion",
				assertion_kind: "session.lifecycle",
				session_id: "",
				detail: "Cannot project compaction state: session lifecycle assertion is missing.",
			},
		};
	}

	const sessionId = set.lifecycle.session_id;
	const diagnostics: ProjectionError[] = [];

	if (!set.compaction_state) {
		diagnostics.push({
			kind: "missing_assertion",
			assertion_kind: "session.compaction_state",
			session_id: sessionId,
			detail: "compaction_state missing; defaults to disabled with zero counts.",
		});
		return {
			ok: true,
			value: {
				auto_compact_enabled: false,
				auto_retry_enabled: false,
				last_compaction_entry_id: null,
				last_compaction_at_ms: null,
				compaction_count: 0,
				retry_count: 0,
			},
			diagnostics,
		};
	}

	return {
		ok: true,
		value: {
			auto_compact_enabled: set.compaction_state.auto_compact_enabled,
			auto_retry_enabled: set.compaction_state.auto_retry_enabled,
			last_compaction_entry_id: set.compaction_state.last_compaction_entry_id,
			last_compaction_at_ms: set.compaction_state.last_compaction_at_ms,
			compaction_count: set.compaction_state.compaction_count,
			retry_count: set.compaction_state.retry_count,
		},
		diagnostics,
	};
}

/**
 * Project full session context from assertions + externally supplied messages.
 *
 * Equivalent to: session_dag.build_context(session_value)
 *
 * The messages array must be obtained via the session.project_context
 * command / session.context response cycle, since the full message list
 * requires access to the session DAG which lives in the service actor.
 *
 * This function combines the assertion-derived model/thinking metadata
 * with the supplied messages to produce the canonical
 * SessionContextProjection shape.
 *
 * When contextMessages is null (not yet fetched), the projection
 * returns an empty messages array and records a diagnostic.
 */
export function projectContext(
	set: SessionAssertionSet,
	contextMessages: ReadonlyArray<unknown> | null,
): ProjectionResult<SessionContextProjection> {
	if (!set.lifecycle) {
		return {
			ok: false,
			error: {
				kind: "missing_assertion",
				assertion_kind: "session.lifecycle",
				session_id: "",
				detail: "Cannot project context: session lifecycle assertion is missing.",
			},
		};
	}

	const sessionId = set.lifecycle.session_id;

	if (!isValidPhase(set.lifecycle.phase)) {
		return {
			ok: false,
			error: {
				kind: "invalid_phase",
				assertion_kind: "session.lifecycle",
				session_id: sessionId,
				detail: `Invalid lifecycle phase: "${set.lifecycle.phase}".`,
			},
		};
	}

	const diagnostics: ProjectionError[] = [];

	// Derive model from assertions.
	let thinkingLevel: SessionThinkingLevel = "off";
	let model: { readonly provider: string; readonly model_id: string } | null = null;

	if (set.model_state) {
		thinkingLevel = set.model_state.thinking_level;
		if (set.model_state.provider !== null && set.model_state.model_id !== null) {
			model = {
				provider: set.model_state.provider,
				model_id: set.model_state.model_id,
			};
		}
	} else {
		diagnostics.push({
			kind: "missing_assertion",
			assertion_kind: "session.model_state",
			session_id: sessionId,
			detail: "model_state missing; context defaults to thinking_level=off, model=null.",
		});
	}

	// Use supplied messages or default to empty.
	const messages = contextMessages ?? [];
	if (contextMessages === null) {
		diagnostics.push({
			kind: "missing_assertion",
			assertion_kind: "session.context",
			session_id: sessionId,
			detail: "Context messages not supplied; messages array is empty. Use session.project_context command to obtain messages.",
		});
	}

	return {
		ok: true,
		value: {
			kind: "session_context",
			messages,
			thinking_level: thinkingLevel,
			model,
		},
		diagnostics,
	};
}

/**
 * Merge an externally received session.context response with assertion
 * state, producing a unified SessionContextProjection.
 *
 * This is the primary entry point for daemon adapters that receive
 * context responses from the session service actor: it validates the
 * response shape, cross-checks session_id, and overlays assertion-
 * derived model/thinking metadata.
 *
 * The assertion-derived model/thinking takes precedence over values
 * in the context response, since assertions represent the current
 * service actor state while context response values may be from an
 * earlier projection.
 */
export function mergeContextResponse(
	set: SessionAssertionSet,
	response: {
		readonly session_id: string;
		readonly messages: ReadonlyArray<unknown>;
		readonly thinking_level?: string;
		readonly model?: { readonly provider: string; readonly model_id: string } | null;
	},
): ProjectionResult<SessionContextProjection> {
	if (!set.lifecycle) {
		return {
			ok: false,
			error: {
				kind: "missing_assertion",
				assertion_kind: "session.lifecycle",
				session_id: response.session_id,
				detail: "Cannot merge context response: session lifecycle assertion is missing.",
			},
		};
	}

	const sessionId = set.lifecycle.session_id;
	const diagnostics: ProjectionError[] = [];

	if (response.session_id !== sessionId) {
		diagnostics.push({
			kind: "stale_assertion",
			assertion_kind: "session.context",
			session_id: sessionId,
			detail: `Context response session_id "${response.session_id}" does not match assertion set session_id "${sessionId}".`,
		});
	}

	// Assertion-derived model/thinking takes precedence.
	let thinkingLevel: SessionThinkingLevel = "off";
	let model: { readonly provider: string; readonly model_id: string } | null = null;

	if (set.model_state) {
		thinkingLevel = set.model_state.thinking_level;
		if (set.model_state.provider !== null && set.model_state.model_id !== null) {
			model = { provider: set.model_state.provider, model_id: set.model_state.model_id };
		}
	} else {
		// Fall back to response values when assertion is missing.
		if (response.thinking_level && isValidThinkingLevel(response.thinking_level)) {
			thinkingLevel = response.thinking_level;
		}
		model = response.model ?? null;
		diagnostics.push({
			kind: "missing_assertion",
			assertion_kind: "session.model_state",
			session_id: sessionId,
			detail: "model_state assertion missing; using context response values as fallback.",
		});
	}

	return {
		ok: true,
		value: {
			kind: "session_context",
			messages: response.messages,
			thinking_level: thinkingLevel,
			model,
		},
		diagnostics,
	};
}

// ---------------------------------------------------------------------------
// Assertion set diagnostics
// ---------------------------------------------------------------------------

/**
 * Validate an assertion set for completeness and consistency.
 *
 * Returns a list of all projection errors found. An empty list means
 * the assertion set is complete and internally consistent.
 */
export function diagnoseAssertionSet(set: SessionAssertionSet): ReadonlyArray<ProjectionError> {
	const errors: ProjectionError[] = [];

	if (!set.lifecycle) {
		errors.push({
			kind: "missing_assertion",
			assertion_kind: "session.lifecycle",
			session_id: "",
			detail: "No lifecycle assertion; session may not exist or has been fully retracted.",
		});
		return errors;
	}

	const sessionId = set.lifecycle.session_id;

	if (!isValidPhase(set.lifecycle.phase)) {
		errors.push({
			kind: "invalid_phase",
			assertion_kind: "session.lifecycle",
			session_id: sessionId,
			detail: `Invalid lifecycle phase: "${set.lifecycle.phase}".`,
		});
	}

	const isTerminal = set.lifecycle.phase === "closed" || set.lifecycle.phase === "error";

	if (!set.dag_anchor) {
		errors.push({
			kind: "missing_assertion",
			assertion_kind: "session.dag_anchor",
			session_id: sessionId,
			detail: "No dag_anchor assertion.",
		});
	} else if (isTerminal) {
		errors.push({
			kind: "stale_assertion",
			assertion_kind: "session.dag_anchor",
			session_id: sessionId,
			detail: `dag_anchor still present but lifecycle phase is "${set.lifecycle.phase}".`,
		});
	}

	if (!set.model_state) {
		errors.push({
			kind: "missing_assertion",
			assertion_kind: "session.model_state",
			session_id: sessionId,
			detail: "No model_state assertion.",
		});
	}

	if (!set.queue_state) {
		errors.push({
			kind: "missing_assertion",
			assertion_kind: "session.queue_state",
			session_id: sessionId,
			detail: "No queue_state assertion.",
		});
	}

	if (!set.compaction_state) {
		errors.push({
			kind: "missing_assertion",
			assertion_kind: "session.compaction_state",
			session_id: sessionId,
			detail: "No compaction_state assertion.",
		});
	}

	if (!set.event_anchor) {
		errors.push({
			kind: "missing_assertion",
			assertion_kind: "session.event_anchor",
			session_id: sessionId,
			detail: "No event_anchor assertion.",
		});
	}

	// Cross-assertion consistency: session_id must match across all present assertions.
	const assertionSlots: Array<{ kind: string; sid: string }> = [];
	if (set.queue_state) assertionSlots.push({ kind: "session.queue_state", sid: set.queue_state.session_id });
	if (set.model_state) assertionSlots.push({ kind: "session.model_state", sid: set.model_state.session_id });
	if (set.compaction_state)
		assertionSlots.push({ kind: "session.compaction_state", sid: set.compaction_state.session_id });
	if (set.dag_anchor) assertionSlots.push({ kind: "session.dag_anchor", sid: set.dag_anchor.session_id });
	if (set.event_anchor) assertionSlots.push({ kind: "session.event_anchor", sid: set.event_anchor.session_id });

	for (const slot of assertionSlots) {
		if (slot.sid !== sessionId) {
			errors.push({
				kind: "stale_assertion",
				assertion_kind: slot.kind,
				session_id: sessionId,
				detail: `session_id mismatch: lifecycle says "${sessionId}" but ${slot.kind} says "${slot.sid}".`,
			});
		}
	}

	return errors;
}
