/**
 * Syndicate session service actor (session-service/v1).
 *
 * Owns session runtime state as assertion/message records rather than
 * daemon-native maps. Processes command messages, maintains canonical
 * assertion state, emits response and event messages.
 *
 * Protocol contract (from SESSION-SVC-1):
 *   - 6 assertion kinds: lifecycle, queue_state, model_state,
 *     compaction_state, dag_anchor, event_anchor
 *   - 9 command messages: open, close, enqueue, dequeue, interrupt,
 *     set_model, set_policy, branch, project_context
 *   - 5 response messages: ack, queue_receipt, dequeue_ack,
 *     interrupt_ack, context
 *   - 1 event message: session.event with 12 event kinds
 *
 * Design principles:
 *   - Single-writer: one service actor per session_id; all mutations
 *     flow through command messages and produce deterministic
 *     assertion updates.
 *   - Deterministic ordering: queue operations are FIFO with
 *     monotonic turn_id assignment.
 *   - Replay-safe: every command produces idempotent assertion state;
 *     replaying the same command sequence yields identical state.
 *   - Queue limits: configurable max_queue_depth with overflow
 *     rejection.
 *
 * Daemon adapter consumption:
 *   - Create a SessionService instance per session.
 *   - Send commands via dispatch().
 *   - Read current assertion state via assertions().
 *   - Subscribe to events/responses via on().
 */

import type {
	SessionPhase,
	SessionMode,
	SessionThinkingLevel,
	LifecycleAssertion,
	QueueStateAssertion,
	ModelStateAssertion,
	CompactionStateAssertion,
	DagAnchorAssertion,
	EventAnchorAssertion,
	SessionAssertionSet,
} from "./session_projection.js";

import {
	SESSION_SERVICE_PROTOCOL_VERSION,
	isValidPhase,
	isActivePhase,
	isValidMode,
	isValidThinkingLevel,
} from "./session_projection.js";

// ---------------------------------------------------------------------------
// Turn and queue types
// ---------------------------------------------------------------------------

export type TurnKind = "prompt" | "steer" | "follow_up" | "abort";

export type QueuedTurn = {
	readonly turn_id: string;
	readonly kind: TurnKind;
	readonly body: string;
	readonly enqueued_at_ms: number;
	readonly metadata: unknown;
};

// ---------------------------------------------------------------------------
// Command message types (the 9 commands from frozen protocol)
// ---------------------------------------------------------------------------

export type OpenCommand = {
	readonly kind: "session.open";
	readonly session_id: string;
	readonly mode: SessionMode;
	readonly metadata?: unknown;
};

export type CloseCommand = {
	readonly kind: "session.close";
	readonly session_id: string;
	readonly reason: string;
};

export type EnqueueCommand = {
	readonly kind: "session.enqueue";
	readonly session_id: string;
	readonly turn_kind: TurnKind;
	readonly body: string;
	readonly metadata?: unknown;
};

export type DequeueCommand = {
	readonly kind: "session.dequeue";
	readonly session_id: string;
};

export type InterruptCommand = {
	readonly kind: "session.interrupt";
	readonly session_id: string;
	readonly reason: string;
};

export type SetModelCommand = {
	readonly kind: "session.set_model";
	readonly session_id: string;
	readonly provider: string | null;
	readonly model_id: string | null;
	readonly thinking_level: SessionThinkingLevel;
};

export type SetPolicyCommand = {
	readonly kind: "session.set_policy";
	readonly session_id: string;
	readonly auto_compact_enabled: boolean;
	readonly auto_retry_enabled: boolean;
};

export type BranchCommand = {
	readonly kind: "session.branch";
	readonly session_id: string;
	readonly leaf_id: string;
	readonly entry_count: number;
	readonly journal_size: number;
};

export type ProjectContextCommand = {
	readonly kind: "session.project_context";
	readonly session_id: string;
};

export type SessionCommand =
	| OpenCommand
	| CloseCommand
	| EnqueueCommand
	| DequeueCommand
	| InterruptCommand
	| SetModelCommand
	| SetPolicyCommand
	| BranchCommand
	| ProjectContextCommand;

// ---------------------------------------------------------------------------
// Response message types (the 5 responses from frozen protocol)
// ---------------------------------------------------------------------------

export type AckResponse = {
	readonly kind: "session.ack";
	readonly session_id: string;
	readonly command_kind: string;
	readonly success: boolean;
	readonly error?: string;
};

export type QueueReceiptResponse = {
	readonly kind: "session.queue_receipt";
	readonly session_id: string;
	readonly turn_id: string;
	readonly position: number;
	readonly accepted: boolean;
	readonly error?: string;
};

export type DequeueAckResponse = {
	readonly kind: "session.dequeue_ack";
	readonly session_id: string;
	readonly turn_id: string | null;
	readonly turn_kind: TurnKind | null;
	readonly body: string | null;
	readonly empty: boolean;
};

export type InterruptAckResponse = {
	readonly kind: "session.interrupt_ack";
	readonly session_id: string;
	readonly interrupted_turn_id: string | null;
	readonly queue_cleared_count: number;
};

export type ContextResponse = {
	readonly kind: "session.context";
	readonly session_id: string;
	readonly messages: ReadonlyArray<unknown>;
	readonly thinking_level: SessionThinkingLevel;
	readonly model: { readonly provider: string; readonly model_id: string } | null;
};

export type SessionResponse =
	| AckResponse
	| QueueReceiptResponse
	| DequeueAckResponse
	| InterruptAckResponse
	| ContextResponse;

// ---------------------------------------------------------------------------
// Event message types
// ---------------------------------------------------------------------------

export type SessionEventKind =
	| "session_opened"
	| "session_attached"
	| "session_closing"
	| "session_closed"
	| "session_error"
	| "turn_enqueued"
	| "turn_dequeued"
	| "turn_interrupted"
	| "model_changed"
	| "policy_changed"
	| "branch_updated"
	| "context_projected";

export type SessionEvent = {
	readonly kind: "session.event";
	readonly session_id: string;
	readonly event_kind: SessionEventKind;
	readonly event_seq: number;
	readonly timestamp_ms: number;
	readonly detail: unknown;
};

// ---------------------------------------------------------------------------
// Service configuration
// ---------------------------------------------------------------------------

export type SessionServiceConfig = {
	/** Maximum pending turns in queue. Default: 64. */
	readonly max_queue_depth: number;
	/** Clock function for timestamps. Default: Date.now. */
	readonly now_ms: () => number;
	/** ID generator for turn IDs. Default: monotonic counter. */
	readonly generate_turn_id: () => string;
	/** Context messages provider for project_context. */
	readonly context_provider: ((session_id: string) => ReadonlyArray<unknown>) | null;
};

const DEFAULT_MAX_QUEUE_DEPTH = 64;

// ---------------------------------------------------------------------------
// Service listener
// ---------------------------------------------------------------------------

export type SessionServiceListener = {
	onResponse?: (response: SessionResponse) => void;
	onEvent?: (event: SessionEvent) => void;
	onAssertionChange?: (assertions: SessionAssertionSet) => void;
};

// ---------------------------------------------------------------------------
// Dispatch result
// ---------------------------------------------------------------------------

export type DispatchResult = {
	readonly ok: boolean;
	readonly response: SessionResponse;
	readonly events: ReadonlyArray<SessionEvent>;
	readonly assertions: SessionAssertionSet;
};

// ---------------------------------------------------------------------------
// Valid phase transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: ReadonlyMap<SessionPhase, ReadonlySet<SessionPhase>> = new Map([
	["created", new Set(["open", "error", "closed"] as const)],
	["open", new Set(["attached", "closing", "error", "closed"] as const)],
	["attached", new Set(["open", "closing", "error", "closed"] as const)],
	["closing", new Set(["closed", "error"] as const)],
	["closed", new Set<SessionPhase>()],
	["error", new Set(["closed"] as const)],
]);

function canTransition(from: SessionPhase, to: SessionPhase): boolean {
	return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}

// ---------------------------------------------------------------------------
// Session service actor
// ---------------------------------------------------------------------------

export class SessionService {
	readonly session_id: string;
	readonly protocol_version: string = SESSION_SERVICE_PROTOCOL_VERSION;

	// Mutable assertion state (single-writer)
	private _lifecycle: LifecycleAssertion;
	private _queue_state: QueueStateAssertion;
	private _model_state: ModelStateAssertion;
	private _compaction_state: CompactionStateAssertion;
	private _dag_anchor: DagAnchorAssertion;
	private _event_anchor: EventAnchorAssertion;

	// Internal queue (FIFO)
	private _queue: QueuedTurn[] = [];
	private _active_turn: QueuedTurn | null = null;

	// Monotonic counters
	private _event_seq: number = 0;
	private _turn_counter: number = 0;
	private _completed_count: number = 0;

	// Configuration
	private readonly _config: SessionServiceConfig;

	// Listeners
	private readonly _listeners: Set<SessionServiceListener> = new Set();

	constructor(
		session_id: string,
		config?: Partial<SessionServiceConfig>,
	) {
		this.session_id = session_id;

		let turnCounter = 0;
		this._config = {
			max_queue_depth: config?.max_queue_depth ?? DEFAULT_MAX_QUEUE_DEPTH,
			now_ms: config?.now_ms ?? (() => Date.now()),
			generate_turn_id: config?.generate_turn_id ?? (() => {
				turnCounter += 1;
				return `turn-${session_id}-${turnCounter}`;
			}),
			context_provider: config?.context_provider ?? null,
		};

		const now = this._config.now_ms();

		// Initialize all 6 assertions in created state
		this._lifecycle = {
			kind: "session.lifecycle",
			session_id,
			phase: "created",
			mode: "memory",
			created_at_ms: now,
			metadata: null,
		};

		this._queue_state = {
			kind: "session.queue_state",
			session_id,
			pending_count: 0,
			active_turn_id: null,
			completed_count: 0,
			max_queue_depth: this._config.max_queue_depth,
			fair_cursor: 0,
		};

		this._model_state = {
			kind: "session.model_state",
			session_id,
			provider: null,
			model_id: null,
			thinking_level: "off",
		};

		this._compaction_state = {
			kind: "session.compaction_state",
			session_id,
			auto_compact_enabled: false,
			auto_retry_enabled: false,
			last_compaction_entry_id: null,
			last_compaction_at_ms: null,
			compaction_count: 0,
			retry_count: 0,
		};

		this._dag_anchor = {
			kind: "session.dag_anchor",
			session_id,
			leaf_id: null,
			entry_count: 0,
			journal_size: 0,
		};

		this._event_anchor = {
			kind: "session.event_anchor",
			session_id,
			event_seq: 0,
			last_event_kind: null,
			last_event_at_ms: now,
		};
	}

	// ---------------------------------------------------------------------------
	// Public: assertion state (read-only snapshot)
	// ---------------------------------------------------------------------------

	assertions(): SessionAssertionSet {
		return {
			lifecycle: this._lifecycle,
			queue_state: this._queue_state,
			model_state: this._model_state,
			compaction_state: this._compaction_state,
			dag_anchor: this._dag_anchor,
			event_anchor: this._event_anchor,
		};
	}

	phase(): SessionPhase {
		return this._lifecycle.phase;
	}

	isActive(): boolean {
		return isActivePhase(this._lifecycle.phase);
	}

	queueDepth(): number {
		return this._queue.length;
	}

	activeTurn(): QueuedTurn | null {
		return this._active_turn;
	}

	pendingTurns(): ReadonlyArray<QueuedTurn> {
		return this._queue;
	}

	// ---------------------------------------------------------------------------
	// Public: listener registration
	// ---------------------------------------------------------------------------

	on(listener: SessionServiceListener): () => void {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	// ---------------------------------------------------------------------------
	// Public: command dispatch
	// ---------------------------------------------------------------------------

	dispatch(command: SessionCommand): DispatchResult {
		if (command.session_id !== this.session_id) {
			const errorResponse = this._ack(command.kind, false, `session_id mismatch: expected "${this.session_id}", got "${command.session_id}"`);
			return { ok: false, response: errorResponse, events: [], assertions: this.assertions() };
		}

		switch (command.kind) {
			case "session.open":
				return this._handleOpen(command);
			case "session.close":
				return this._handleClose(command);
			case "session.enqueue":
				return this._handleEnqueue(command);
			case "session.dequeue":
				return this._handleDequeue(command);
			case "session.interrupt":
				return this._handleInterrupt(command);
			case "session.set_model":
				return this._handleSetModel(command);
			case "session.set_policy":
				return this._handleSetPolicy(command);
			case "session.branch":
				return this._handleBranch(command);
			case "session.project_context":
				return this._handleProjectContext(command);
			default: {
				const errorResponse = this._ack((command as { kind: string }).kind, false, `unknown command kind: "${(command as { kind: string }).kind}"`);
				return { ok: false, response: errorResponse, events: [], assertions: this.assertions() };
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Command handlers
	// ---------------------------------------------------------------------------

	private _handleOpen(cmd: OpenCommand): DispatchResult {
		// Only valid from created phase
		if (this._lifecycle.phase !== "created") {
			const resp = this._ack(cmd.kind, false, `cannot open: session is in phase "${this._lifecycle.phase}", expected "created"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		if (!isValidMode(cmd.mode)) {
			const resp = this._ack(cmd.kind, false, `invalid mode: "${cmd.mode}"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		this._lifecycle = {
			...this._lifecycle,
			phase: "open",
			mode: cmd.mode,
			metadata: cmd.metadata ?? null,
		};

		const event = this._emitEvent("session_opened", { mode: cmd.mode });
		const resp = this._ack(cmd.kind, true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	private _handleClose(cmd: CloseCommand): DispatchResult {
		const currentPhase = this._lifecycle.phase;
		if (currentPhase === "closed") {
			// Idempotent: already closed
			const resp = this._ack(cmd.kind, true);
			return { ok: true, response: resp, events: [], assertions: this.assertions() };
		}

		if (currentPhase === "created") {
			// Direct close from created
			this._lifecycle = { ...this._lifecycle, phase: "closed" };
			const event = this._emitEvent("session_closed", { reason: cmd.reason });
			const resp = this._ack(cmd.kind, true);
			this._clearQueueOnClose();
			this._notifyAssertionChange();
			return { ok: true, response: resp, events: [event], assertions: this.assertions() };
		}

		// Transition to closing, then closed
		if (!canTransition(currentPhase, "closing") && !canTransition(currentPhase, "closed")) {
			const resp = this._ack(cmd.kind, false, `cannot close: session is in phase "${currentPhase}"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		const events: SessionEvent[] = [];

		if (canTransition(currentPhase, "closing") && this._active_turn !== null) {
			// Transition through closing if there is active work
			this._lifecycle = { ...this._lifecycle, phase: "closing" };
			events.push(this._emitEvent("session_closing", { reason: cmd.reason }));
		}

		// Complete the close
		this._lifecycle = { ...this._lifecycle, phase: "closed" };
		events.push(this._emitEvent("session_closed", { reason: cmd.reason }));
		this._clearQueueOnClose();
		const resp = this._ack(cmd.kind, true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events, assertions: this.assertions() };
	}

	private _handleEnqueue(cmd: EnqueueCommand): DispatchResult {
		if (!this.isActive()) {
			const resp: QueueReceiptResponse = {
				kind: "session.queue_receipt",
				session_id: this.session_id,
				turn_id: "",
				position: -1,
				accepted: false,
				error: `cannot enqueue: session is in phase "${this._lifecycle.phase}", expected open or attached`,
			};
			this._notifyResponse(resp);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		if (!this._isValidTurnKind(cmd.turn_kind)) {
			const resp: QueueReceiptResponse = {
				kind: "session.queue_receipt",
				session_id: this.session_id,
				turn_id: "",
				position: -1,
				accepted: false,
				error: `invalid turn_kind: "${cmd.turn_kind}"`,
			};
			this._notifyResponse(resp);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		// Handle abort specially: clear queue and interrupt active turn
		if (cmd.turn_kind === "abort") {
			return this._handleAbortEnqueue(cmd);
		}

		// Check queue depth limit
		if (this._queue.length >= this._config.max_queue_depth) {
			const resp: QueueReceiptResponse = {
				kind: "session.queue_receipt",
				session_id: this.session_id,
				turn_id: "",
				position: -1,
				accepted: false,
				error: `queue full: ${this._queue.length}/${this._config.max_queue_depth}`,
			};
			this._notifyResponse(resp);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		const turn_id = this._config.generate_turn_id();
		const now = this._config.now_ms();

		const turn: QueuedTurn = {
			turn_id,
			kind: cmd.turn_kind,
			body: cmd.body,
			enqueued_at_ms: now,
			metadata: cmd.metadata ?? null,
		};

		this._queue.push(turn);
		const position = this._queue.length - 1;

		this._updateQueueState();

		const event = this._emitEvent("turn_enqueued", {
			turn_id,
			turn_kind: cmd.turn_kind,
			position,
		});

		const resp: QueueReceiptResponse = {
			kind: "session.queue_receipt",
			session_id: this.session_id,
			turn_id,
			position,
			accepted: true,
		};

		this._notifyResponse(resp);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	private _handleAbortEnqueue(cmd: EnqueueCommand): DispatchResult {
		const events: SessionEvent[] = [];
		const clearedCount = this._queue.length;
		const interruptedTurnId = this._active_turn?.turn_id ?? null;

		// Clear entire queue
		this._queue = [];

		// Interrupt active turn
		if (this._active_turn) {
			events.push(this._emitEvent("turn_interrupted", {
				turn_id: this._active_turn.turn_id,
				reason: "abort",
			}));
			this._active_turn = null;
		}

		this._updateQueueState();

		events.push(this._emitEvent("turn_enqueued", {
			turn_id: "abort",
			turn_kind: "abort",
			position: 0,
			cleared_count: clearedCount,
			interrupted_turn_id: interruptedTurnId,
		}));

		const resp: QueueReceiptResponse = {
			kind: "session.queue_receipt",
			session_id: this.session_id,
			turn_id: "abort",
			position: 0,
			accepted: true,
		};

		this._notifyResponse(resp);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events, assertions: this.assertions() };
	}

	private _handleDequeue(cmd: DequeueCommand): DispatchResult {
		if (!this.isActive()) {
			const resp: DequeueAckResponse = {
				kind: "session.dequeue_ack",
				session_id: this.session_id,
				turn_id: null,
				turn_kind: null,
				body: null,
				empty: true,
			};
			this._notifyResponse(resp);
			return { ok: true, response: resp, events: [], assertions: this.assertions() };
		}

		// If there is already an active turn, reject (single-writer)
		if (this._active_turn !== null) {
			const resp: DequeueAckResponse = {
				kind: "session.dequeue_ack",
				session_id: this.session_id,
				turn_id: null,
				turn_kind: null,
				body: null,
				empty: false,
			};
			// Not empty but cannot dequeue while a turn is active
			this._notifyResponse(resp);
			return {
				ok: false,
				response: {
					kind: "session.ack",
					session_id: this.session_id,
					command_kind: cmd.kind,
					success: false,
					error: `cannot dequeue: turn "${this._active_turn.turn_id}" is in-flight`,
				},
				events: [],
				assertions: this.assertions(),
			};
		}

		if (this._queue.length === 0) {
			const resp: DequeueAckResponse = {
				kind: "session.dequeue_ack",
				session_id: this.session_id,
				turn_id: null,
				turn_kind: null,
				body: null,
				empty: true,
			};
			this._notifyResponse(resp);
			return { ok: true, response: resp, events: [], assertions: this.assertions() };
		}

		const turn = this._queue.shift()!;
		this._active_turn = turn;

		// Advance fair cursor monotonically
		this._queue_state = {
			...this._queue_state,
			fair_cursor: this._queue_state.fair_cursor + 1,
		};

		this._updateQueueState();

		const event = this._emitEvent("turn_dequeued", {
			turn_id: turn.turn_id,
			turn_kind: turn.kind,
		});

		const resp: DequeueAckResponse = {
			kind: "session.dequeue_ack",
			session_id: this.session_id,
			turn_id: turn.turn_id,
			turn_kind: turn.kind,
			body: turn.body,
			empty: false,
		};

		this._notifyResponse(resp);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	private _handleInterrupt(cmd: InterruptCommand): DispatchResult {
		const events: SessionEvent[] = [];
		const interruptedTurnId = this._active_turn?.turn_id ?? null;
		const clearedCount = this._queue.length;

		// Clear pending queue
		this._queue = [];

		// Interrupt active turn
		if (this._active_turn) {
			events.push(this._emitEvent("turn_interrupted", {
				turn_id: this._active_turn.turn_id,
				reason: cmd.reason,
			}));
			this._active_turn = null;
		}

		this._updateQueueState();

		const resp: InterruptAckResponse = {
			kind: "session.interrupt_ack",
			session_id: this.session_id,
			interrupted_turn_id: interruptedTurnId,
			queue_cleared_count: clearedCount,
		};

		this._notifyResponse(resp);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events, assertions: this.assertions() };
	}

	private _handleSetModel(cmd: SetModelCommand): DispatchResult {
		if (!this.isActive() && this._lifecycle.phase !== "created") {
			const resp = this._ack(cmd.kind, false, `cannot set model: session is in phase "${this._lifecycle.phase}"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		if (!isValidThinkingLevel(cmd.thinking_level)) {
			const resp = this._ack(cmd.kind, false, `invalid thinking_level: "${cmd.thinking_level}"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		this._model_state = {
			kind: "session.model_state",
			session_id: this.session_id,
			provider: cmd.provider,
			model_id: cmd.model_id,
			thinking_level: cmd.thinking_level,
		};

		const event = this._emitEvent("model_changed", {
			provider: cmd.provider,
			model_id: cmd.model_id,
			thinking_level: cmd.thinking_level,
		});

		const resp = this._ack(cmd.kind, true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	private _handleSetPolicy(cmd: SetPolicyCommand): DispatchResult {
		if (!this.isActive() && this._lifecycle.phase !== "created") {
			const resp = this._ack(cmd.kind, false, `cannot set policy: session is in phase "${this._lifecycle.phase}"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		this._compaction_state = {
			...this._compaction_state,
			auto_compact_enabled: cmd.auto_compact_enabled,
			auto_retry_enabled: cmd.auto_retry_enabled,
		};

		const event = this._emitEvent("policy_changed", {
			auto_compact_enabled: cmd.auto_compact_enabled,
			auto_retry_enabled: cmd.auto_retry_enabled,
		});

		const resp = this._ack(cmd.kind, true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	private _handleBranch(cmd: BranchCommand): DispatchResult {
		if (!this.isActive()) {
			const resp = this._ack(cmd.kind, false, `cannot branch: session is in phase "${this._lifecycle.phase}"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		this._dag_anchor = {
			kind: "session.dag_anchor",
			session_id: this.session_id,
			leaf_id: cmd.leaf_id,
			entry_count: cmd.entry_count,
			journal_size: cmd.journal_size,
		};

		// If there was an active turn, it completed successfully
		if (this._active_turn) {
			this._completed_count += 1;
			this._active_turn = null;
			this._updateQueueState();
		}

		const event = this._emitEvent("branch_updated", {
			leaf_id: cmd.leaf_id,
			entry_count: cmd.entry_count,
			journal_size: cmd.journal_size,
		});

		const resp = this._ack(cmd.kind, true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	private _handleProjectContext(cmd: ProjectContextCommand): DispatchResult {
		const messages = this._config.context_provider
			? this._config.context_provider(this.session_id)
			: [];

		const model = this._model_state.provider !== null && this._model_state.model_id !== null
			? { provider: this._model_state.provider, model_id: this._model_state.model_id }
			: null;

		const event = this._emitEvent("context_projected", {
			message_count: messages.length,
		});

		const resp: ContextResponse = {
			kind: "session.context",
			session_id: this.session_id,
			messages,
			thinking_level: this._model_state.thinking_level,
			model,
		};

		this._notifyResponse(resp);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	// ---------------------------------------------------------------------------
	// Public: complete active turn (explicit completion signal)
	// ---------------------------------------------------------------------------

	/**
	 * Signal that the active turn has completed. This is called by the
	 * executor after processing a dequeued turn, before issuing a branch
	 * command. If branch is called directly, it implicitly completes
	 * the active turn.
	 */
	completeActiveTurn(): { completed: boolean; turn_id: string | null } {
		if (!this._active_turn) {
			return { completed: false, turn_id: null };
		}
		const turn_id = this._active_turn.turn_id;
		this._completed_count += 1;
		this._active_turn = null;
		this._updateQueueState();
		this._notifyAssertionChange();
		return { completed: true, turn_id };
	}

	// ---------------------------------------------------------------------------
	// Public: attach/detach (phase transitions)
	// ---------------------------------------------------------------------------

	/**
	 * Transition from open to attached (marks a consumer has connected).
	 */
	attach(): DispatchResult {
		if (this._lifecycle.phase !== "open") {
			const resp = this._ack("session.attach", false, `cannot attach: session is in phase "${this._lifecycle.phase}", expected "open"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		this._lifecycle = { ...this._lifecycle, phase: "attached" };
		const event = this._emitEvent("session_attached", {});
		const resp = this._ack("session.attach", true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	/**
	 * Transition from attached back to open (consumer disconnected).
	 */
	detach(): DispatchResult {
		if (this._lifecycle.phase !== "attached") {
			const resp = this._ack("session.detach", false, `cannot detach: session is in phase "${this._lifecycle.phase}", expected "attached"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		this._lifecycle = { ...this._lifecycle, phase: "open" };
		const resp = this._ack("session.detach", true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [], assertions: this.assertions() };
	}

	// ---------------------------------------------------------------------------
	// Public: error transition
	// ---------------------------------------------------------------------------

	/**
	 * Transition to error phase. Valid from any non-terminal phase.
	 */
	error(detail: unknown): DispatchResult {
		const currentPhase = this._lifecycle.phase;
		if (currentPhase === "closed" || currentPhase === "error") {
			const resp = this._ack("session.error", false, `cannot enter error: session is in phase "${currentPhase}"`);
			return { ok: false, response: resp, events: [], assertions: this.assertions() };
		}

		this._lifecycle = { ...this._lifecycle, phase: "error" };
		this._clearQueueOnClose();
		const event = this._emitEvent("session_error", { detail });
		const resp = this._ack("session.error", true);
		this._notifyAssertionChange();
		return { ok: true, response: resp, events: [event], assertions: this.assertions() };
	}

	// ---------------------------------------------------------------------------
	// Internal helpers
	// ---------------------------------------------------------------------------

	private _updateQueueState(): void {
		this._queue_state = {
			kind: "session.queue_state",
			session_id: this.session_id,
			pending_count: this._queue.length,
			active_turn_id: this._active_turn?.turn_id ?? null,
			completed_count: this._completed_count,
			max_queue_depth: this._config.max_queue_depth,
			fair_cursor: this._queue_state.fair_cursor,
		};
	}

	private _clearQueueOnClose(): void {
		this._queue = [];
		this._active_turn = null;
		this._updateQueueState();
	}

	private _emitEvent(event_kind: SessionEventKind, detail: unknown): SessionEvent {
		this._event_seq += 1;
		const now = this._config.now_ms();

		const event: SessionEvent = {
			kind: "session.event",
			session_id: this.session_id,
			event_kind,
			event_seq: this._event_seq,
			timestamp_ms: now,
			detail,
		};

		this._event_anchor = {
			kind: "session.event_anchor",
			session_id: this.session_id,
			event_seq: this._event_seq,
			last_event_kind: event_kind,
			last_event_at_ms: now,
		};

		for (const listener of this._listeners) {
			listener.onEvent?.(event);
		}

		return event;
	}

	private _ack(command_kind: string, success: boolean, error?: string): AckResponse {
		const resp: AckResponse = {
			kind: "session.ack",
			session_id: this.session_id,
			command_kind,
			success,
			...(error !== undefined ? { error } : {}),
		};
		this._notifyResponse(resp);
		return resp;
	}

	private _notifyResponse(response: SessionResponse): void {
		for (const listener of this._listeners) {
			listener.onResponse?.(response);
		}
	}

	private _notifyAssertionChange(): void {
		const snapshot = this.assertions();
		for (const listener of this._listeners) {
			listener.onAssertionChange?.(snapshot);
		}
	}

	private _isValidTurnKind(kind: string): kind is TurnKind {
		return kind === "prompt" || kind === "steer" || kind === "follow_up" || kind === "abort";
	}
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a new session service actor in the "created" phase.
 */
export function createSessionService(
	session_id: string,
	config?: Partial<SessionServiceConfig>,
): SessionService {
	return new SessionService(session_id, config);
}
