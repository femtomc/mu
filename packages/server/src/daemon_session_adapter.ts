/**
 * Daemon session service adapter (daemon-adapter/v1).
 *
 * Routes daemon control commands through Syndicate SessionService
 * actors and projects responses/events back through adapter-projected
 * envelopes. The daemon stops owning session domain state; all
 * session semantics flow through the service actor.
 *
 * Design contract:
 *   - The adapter owns a SessionService per session_id.
 *   - Control commands (open/close/enqueue/dequeue/interrupt/set_model/
 *     set_policy/branch/project_context) are translated into
 *     SessionCommand messages and dispatched to the service.
 *   - Responses are projected into DaemonCommandResponse envelopes.
 *   - Events are projected into DaemonEventEnvelope records suitable
 *     for the event stream API.
 *   - UI response routing reads assertion state via projection
 *     functions without maintaining separate domain state.
 *   - Transport reconnection/replay works by snapshotting assertion
 *     state and replaying events from a cursor.
 *
 * Daemon consumption:
 *   - Create a DaemonSessionAdapter instance.
 *   - Route HTTP/API control commands through dispatchCommand().
 *   - Subscribe to projected events via onEvent().
 *   - Read current UI-relevant state via getSessionSnapshot().
 *   - Replay from a cursor via replayEvents().
 */

import {
	createSessionService,
	type SessionService,
	type SessionCommand,
	type SessionResponse,
	type SessionEvent,
	type SessionEventKind,
	type DispatchResult,
	type SessionServiceConfig,
} from "@femtomc/mu-agent";

import {
	type SessionAssertionSet,
	type SessionPhase,
	type SessionContextProjection,
	type SessionBranchProjection,
	type SessionModelProjection,
	type SessionCompactionProjection,
	type ProjectionError,
	projectLeafId,
	projectModelState,
	projectBranchState,
	projectCompactionState,
	projectContext,
	diagnoseAssertionSet,
} from "@femtomc/mu-agent";

// ---------------------------------------------------------------------------
// Daemon command envelope types
// ---------------------------------------------------------------------------

/**
 * Normalized command envelope that the daemon HTTP layer produces
 * from incoming API requests. Maps 1:1 to SessionCommand kinds.
 */
export type DaemonCommandEnvelope = {
	readonly request_id: string;
	readonly session_id: string;
	readonly command: SessionCommand;
	readonly received_at_ms: number;
};

// ---------------------------------------------------------------------------
// Daemon response envelope types
// ---------------------------------------------------------------------------

/**
 * Projected response envelope returned to the daemon HTTP layer.
 */
export type DaemonCommandResponse = {
	readonly request_id: string;
	readonly session_id: string;
	readonly ok: boolean;
	readonly command_kind: string;
	readonly response: SessionResponse;
	readonly assertions: SessionAssertionSet;
	readonly projections: DaemonProjectionSnapshot;
	readonly diagnostics: ReadonlyArray<ProjectionError>;
	readonly responded_at_ms: number;
};

/**
 * Projected state snapshot derived from assertions after a command.
 */
export type DaemonProjectionSnapshot = {
	readonly phase: SessionPhase | null;
	readonly leaf_id: string | null;
	readonly model: SessionModelProjection | null;
	readonly branch: SessionBranchProjection | null;
	readonly compaction: SessionCompactionProjection | null;
};

// ---------------------------------------------------------------------------
// Daemon event envelope types
// ---------------------------------------------------------------------------

/**
 * Projected event envelope suitable for the daemon event stream API.
 * Maps SessionEvent records into the daemon's EventEnvelope shape.
 */
export type DaemonEventEnvelope = {
	readonly ts_ms: number;
	readonly type: string;
	readonly source: string;
	readonly session_id: string;
	readonly event_kind: SessionEventKind;
	readonly event_seq: number;
	readonly detail: unknown;
	readonly assertions_after: SessionAssertionSet;
};

// ---------------------------------------------------------------------------
// Session snapshot for UI/reconnection
// ---------------------------------------------------------------------------

/**
 * Full session snapshot for UI rendering and transport reconnection.
 * Contains assertion state, projections, and event replay cursor.
 */
export type DaemonSessionSnapshot = {
	readonly session_id: string;
	readonly assertions: SessionAssertionSet;
	readonly projections: DaemonProjectionSnapshot;
	readonly diagnostics: ReadonlyArray<ProjectionError>;
	readonly event_cursor: number;
	readonly snapshot_at_ms: number;
};

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export type DaemonSessionAdapterConfig = {
	/** Clock function. Default: Date.now */
	readonly now_ms?: () => number;
	/** Maximum sessions to manage concurrently. Default: 256 */
	readonly max_sessions?: number;
	/** Maximum events to retain per session for replay. Default: 1024 */
	readonly max_events_per_session?: number;
	/** Session service config overrides per session. */
	readonly session_service_config?: Partial<SessionServiceConfig>;
};

// ---------------------------------------------------------------------------
// Event listener
// ---------------------------------------------------------------------------

export type DaemonEventListener = (envelope: DaemonEventEnvelope) => void;

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_EVENTS_PER_SESSION = 1024;

type ManagedSession = {
	service: SessionService;
	events: DaemonEventEnvelope[];
	created_at_ms: number;
};

/**
 * Bridges daemon HTTP API commands to Syndicate SessionService actors.
 *
 * Thread-safety: single-threaded (matches Bun/Node event loop model).
 */
export class DaemonSessionAdapter {
	readonly #sessions: Map<string, ManagedSession> = new Map();
	readonly #listeners: Set<DaemonEventListener> = new Set();
	readonly #config: Required<
		Pick<DaemonSessionAdapterConfig, "now_ms" | "max_sessions" | "max_events_per_session">
	> & { session_service_config: Partial<SessionServiceConfig> };

	constructor(config?: DaemonSessionAdapterConfig) {
		this.#config = {
			now_ms: config?.now_ms ?? (() => Date.now()),
			max_sessions: config?.max_sessions ?? DEFAULT_MAX_SESSIONS,
			max_events_per_session: config?.max_events_per_session ?? DEFAULT_MAX_EVENTS_PER_SESSION,
			session_service_config: config?.session_service_config ?? {},
		};
	}

	// -----------------------------------------------------------------------
	// Public: command dispatch
	// -----------------------------------------------------------------------

	/**
	 * Dispatch a daemon control command through the service adapter.
	 *
	 * Creates a new SessionService for the session if one does not exist
	 * (on session.open commands). Returns an error response if the
	 * session does not exist for non-open commands.
	 */
	dispatchCommand(envelope: DaemonCommandEnvelope): DaemonCommandResponse {
		const now = this.#config.now_ms();
		const { command, session_id, request_id } = envelope;

		// Auto-create session on open command
		if (command.kind === "session.open" && !this.#sessions.has(session_id)) {
			if (this.#sessions.size >= this.#config.max_sessions) {
				return this.#errorResponse(request_id, session_id, command.kind, "max_sessions_exceeded", now);
			}
			const service = createSessionService(session_id, {
				...this.#config.session_service_config,
				now_ms: this.#config.now_ms,
			});
			this.#sessions.set(session_id, {
				service,
				events: [],
				created_at_ms: now,
			});
		}

		const managed = this.#sessions.get(session_id);
		if (!managed) {
			return this.#errorResponse(request_id, session_id, command.kind, "session_not_found", now);
		}

		// Dispatch through the Syndicate service actor
		const result = managed.service.dispatch(command);

		// Project events into daemon envelopes
		for (const event of result.events) {
			const eventEnvelope = this.#projectEvent(session_id, event, result.assertions);
			managed.events.push(eventEnvelope);
			this.#trimEvents(managed);
			this.#notifyListeners(eventEnvelope);
		}

		// Build projected response
		const projections = this.#buildProjections(result.assertions);
		const diagnostics = this.#collectDiagnostics(result.assertions, projections);

		// Clean up closed sessions from managed map after projecting
		if (result.assertions.lifecycle?.phase === "closed") {
			// Retain for a brief window so replay/snapshot works;
			// caller can explicitly destroy via destroySession().
		}

		return {
			request_id,
			session_id,
			ok: result.ok,
			command_kind: command.kind,
			response: result.response,
			assertions: result.assertions,
			projections,
			diagnostics,
			responded_at_ms: this.#config.now_ms(),
		};
	}

	// -----------------------------------------------------------------------
	// Public: session lifecycle (attach/detach/error)
	// -----------------------------------------------------------------------

	/**
	 * Attach a consumer to a session (open -> attached transition).
	 */
	attach(session_id: string): DaemonCommandResponse | null {
		const managed = this.#sessions.get(session_id);
		if (!managed) return null;
		const now = this.#config.now_ms();
		const result = managed.service.attach();
		for (const event of result.events) {
			const envelope = this.#projectEvent(session_id, event, result.assertions);
			managed.events.push(envelope);
			this.#trimEvents(managed);
			this.#notifyListeners(envelope);
		}
		const projections = this.#buildProjections(result.assertions);
		const diagnostics = this.#collectDiagnostics(result.assertions, projections);
		return {
			request_id: `attach-${session_id}-${now}`,
			session_id,
			ok: result.ok,
			command_kind: "session.attach",
			response: result.response,
			assertions: result.assertions,
			projections,
			diagnostics,
			responded_at_ms: this.#config.now_ms(),
		};
	}

	/**
	 * Detach a consumer from a session (attached -> open transition).
	 */
	detach(session_id: string): DaemonCommandResponse | null {
		const managed = this.#sessions.get(session_id);
		if (!managed) return null;
		const now = this.#config.now_ms();
		const result = managed.service.detach();
		const projections = this.#buildProjections(result.assertions);
		const diagnostics = this.#collectDiagnostics(result.assertions, projections);
		return {
			request_id: `detach-${session_id}-${now}`,
			session_id,
			ok: result.ok,
			command_kind: "session.detach",
			response: result.response,
			assertions: result.assertions,
			projections,
			diagnostics,
			responded_at_ms: this.#config.now_ms(),
		};
	}

	// -----------------------------------------------------------------------
	// Public: session snapshot + reconnection/replay
	// -----------------------------------------------------------------------

	/**
	 * Get a full session snapshot for UI rendering or reconnection.
	 */
	getSessionSnapshot(session_id: string): DaemonSessionSnapshot | null {
		const managed = this.#sessions.get(session_id);
		if (!managed) return null;
		const assertions = managed.service.assertions();
		const projections = this.#buildProjections(assertions);
		const diagnostics = this.#collectDiagnostics(assertions, projections);
		const event_cursor = managed.events.length > 0
			? managed.events[managed.events.length - 1].event_seq
			: 0;
		return {
			session_id,
			assertions,
			projections,
			diagnostics,
			event_cursor,
			snapshot_at_ms: this.#config.now_ms(),
		};
	}

	/**
	 * Replay events from a cursor position for transport reconnection.
	 *
	 * Returns all events with event_seq > afterSeq, allowing a
	 * reconnecting client to catch up from its last known position.
	 */
	replayEvents(session_id: string, afterSeq: number): ReadonlyArray<DaemonEventEnvelope> {
		const managed = this.#sessions.get(session_id);
		if (!managed) return [];
		return managed.events.filter((e) => e.event_seq > afterSeq);
	}

	/**
	 * List all active session IDs managed by this adapter.
	 */
	activeSessions(): ReadonlyArray<string> {
		return [...this.#sessions.keys()];
	}

	/**
	 * Check if a session exists in the adapter.
	 */
	hasSession(session_id: string): boolean {
		return this.#sessions.has(session_id);
	}

	/**
	 * Explicitly destroy a session and release resources.
	 */
	destroySession(session_id: string): boolean {
		return this.#sessions.delete(session_id);
	}

	// -----------------------------------------------------------------------
	// Public: event subscription
	// -----------------------------------------------------------------------

	/**
	 * Subscribe to projected event envelopes.
	 * Returns an unsubscribe function.
	 */
	onEvent(listener: DaemonEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	// -----------------------------------------------------------------------
	// Public: direct assertion/projection access (for UI routing)
	// -----------------------------------------------------------------------

	/**
	 * Read current assertion state for a session without sending a command.
	 * Used by UI response routing to read state without domain ownership.
	 */
	getAssertions(session_id: string): SessionAssertionSet | null {
		const managed = this.#sessions.get(session_id);
		if (!managed) return null;
		return managed.service.assertions();
	}

	/**
	 * Build projection snapshot from current assertion state.
	 * Used by programmable UI to derive display state without
	 * reintroducing daemon-owned domain state.
	 */
	getProjections(session_id: string): DaemonProjectionSnapshot | null {
		const managed = this.#sessions.get(session_id);
		if (!managed) return null;
		return this.#buildProjections(managed.service.assertions());
	}

	// -----------------------------------------------------------------------
	// Internal: event projection
	// -----------------------------------------------------------------------

	#projectEvent(
		session_id: string,
		event: SessionEvent,
		assertionsAfter: SessionAssertionSet,
	): DaemonEventEnvelope {
		return {
			ts_ms: event.timestamp_ms,
			type: `session.${event.event_kind}`,
			source: "daemon-session-adapter",
			session_id,
			event_kind: event.event_kind,
			event_seq: event.event_seq,
			detail: event.detail,
			assertions_after: assertionsAfter,
		};
	}

	// -----------------------------------------------------------------------
	// Internal: projection building
	// -----------------------------------------------------------------------

	#buildProjections(assertions: SessionAssertionSet): DaemonProjectionSnapshot {
		const phase = assertions.lifecycle?.phase ?? null;

		const leafResult = projectLeafId(assertions);
		const leaf_id = leafResult.ok ? leafResult.value : null;

		const modelResult = projectModelState(assertions);
		const model = modelResult.ok ? modelResult.value : null;

		const branchResult = projectBranchState(assertions);
		const branch = branchResult.ok ? branchResult.value : null;

		const compactionResult = projectCompactionState(assertions);
		const compaction = compactionResult.ok ? compactionResult.value : null;

		return { phase, leaf_id, model, branch, compaction };
	}

	// -----------------------------------------------------------------------
	// Internal: diagnostics collection
	// -----------------------------------------------------------------------

	#collectDiagnostics(
		assertions: SessionAssertionSet,
		_projections: DaemonProjectionSnapshot,
	): ReadonlyArray<ProjectionError> {
		return diagnoseAssertionSet(assertions);
	}

	// -----------------------------------------------------------------------
	// Internal: event buffer management
	// -----------------------------------------------------------------------

	#trimEvents(managed: ManagedSession): void {
		const max = this.#config.max_events_per_session;
		if (managed.events.length > max) {
			managed.events.splice(0, managed.events.length - max);
		}
	}

	// -----------------------------------------------------------------------
	// Internal: error response factory
	// -----------------------------------------------------------------------

	#errorResponse(
		request_id: string,
		session_id: string,
		command_kind: string,
		error: string,
		now: number,
	): DaemonCommandResponse {
		return {
			request_id,
			session_id,
			ok: false,
			command_kind,
			response: {
				kind: "session.ack",
				session_id,
				command_kind,
				success: false,
				error,
			},
			assertions: {
				lifecycle: null,
				queue_state: null,
				model_state: null,
				compaction_state: null,
				dag_anchor: null,
				event_anchor: null,
			},
			projections: {
				phase: null,
				leaf_id: null,
				model: null,
				branch: null,
				compaction: null,
			},
			diagnostics: [{
				kind: "missing_assertion",
				assertion_kind: "session.lifecycle",
				session_id,
				detail: error,
			}],
			responded_at_ms: now,
		};
	}

	// -----------------------------------------------------------------------
	// Internal: listener notification
	// -----------------------------------------------------------------------

	#notifyListeners(envelope: DaemonEventEnvelope): void {
		for (const listener of this.#listeners) {
			listener(envelope);
		}
	}
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a new daemon session adapter instance.
 */
export function createDaemonSessionAdapter(
	config?: DaemonSessionAdapterConfig,
): DaemonSessionAdapter {
	return new DaemonSessionAdapter(config);
}
