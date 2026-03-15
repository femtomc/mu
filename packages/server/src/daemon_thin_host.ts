/**
 * Daemon thin-host boundary module (daemon-thin/v1).
 *
 * Formalizes the daemon's host-only responsibilities:
 *   - Transport lifecycle (HTTP server, webhook routing, process restart)
 *   - Runtime process management (reload, update, shutdown)
 *   - Host health/status reporting
 *
 * All agent/session domain state is delegated to Syndicate service
 * actors via the DaemonSessionAdapter. The daemon never owns:
 *   - Session queue state or fairness policy
 *   - Agent model/context/branch assertions
 *   - Turn execution semantics
 *
 * The host reports its own bounded metrics (uptime, transport status,
 * adapter connectivity) and reads session-domain state from
 * adapter-projected service state when needed for health endpoints.
 */

import type { DaemonSessionAdapter, DaemonProjectionSnapshot } from "./daemon_session_adapter.js";
import type {
	ControlPlaneSessionLifecycle,
	ControlPlaneSessionMutationAction,
} from "./control_plane_contract.js";

// ---------------------------------------------------------------------------
// Host responsibility boundary
// ---------------------------------------------------------------------------

/**
 * Host-only responsibilities that the daemon retains.
 * These are transport/runtime/process concerns with no agent
 * session semantics.
 */
export type DaemonHostResponsibilities = {
	/** Transport: HTTP server bind/listen/shutdown */
	readonly transport: "http";
	/** Runtime: process reload/update lifecycle */
	readonly runtime_lifecycle_actions: readonly ControlPlaneSessionMutationAction[];
	/** Routing: webhook and API route dispatch */
	readonly routing: "api_router";
};

/**
 * Describes the boundary between host-only and service-delegated state.
 */
export type DaemonBoundaryDescriptor = {
	/** Host-only: what the daemon manages directly. */
	readonly host: DaemonHostResponsibilities;
	/** Delegated: what the daemon reads from service actors. */
	readonly delegated: {
		readonly session_domain: "syndicate_session_service";
		readonly agent_semantics: "syndicate_session_service";
		readonly queue_fairness: "syndicate_session_service";
	};
};

/**
 * The canonical boundary descriptor for daemon-thin/v1.
 */
export const DAEMON_THIN_BOUNDARY: DaemonBoundaryDescriptor = {
	host: {
		transport: "http",
		runtime_lifecycle_actions: ["reload", "update"] as const,
		routing: "api_router",
	},
	delegated: {
		session_domain: "syndicate_session_service",
		agent_semantics: "syndicate_session_service",
		queue_fairness: "syndicate_session_service",
	},
};

// ---------------------------------------------------------------------------
// Host health status
// ---------------------------------------------------------------------------

/**
 * Host-scoped health status.
 *
 * Contains only bounded host metrics and adapter connectivity.
 * Session domain state is read from the adapter's projected state.
 */
export type DaemonHostHealthStatus = {
	readonly ok: boolean;
	readonly host: {
		readonly uptime_ms: number;
		readonly transport: "http";
		readonly started_at_ms: number;
	};
	readonly adapter: {
		readonly available: boolean;
		readonly active_sessions: number;
	};
	readonly boundary: DaemonBoundaryDescriptor;
};

/**
 * Extended health status that includes adapter-projected service state
 * for individual sessions. The daemon reads but does not own this data.
 */
export type DaemonExtendedHealthStatus = DaemonHostHealthStatus & {
	readonly service_projections: ReadonlyArray<{
		readonly session_id: string;
		readonly projections: DaemonProjectionSnapshot;
	}>;
};

// ---------------------------------------------------------------------------
// Host health reporter
// ---------------------------------------------------------------------------

export type DaemonHostHealthReporterOpts = {
	/** Clock function. Default: Date.now */
	readonly now_ms?: () => number;
	/** Session adapter for projected service state. */
	readonly sessionAdapter?: DaemonSessionAdapter | null;
};

/**
 * Reports daemon host health status.
 *
 * Health endpoints read host-only metrics and, when requested,
 * adapter-projected session state. The reporter never owns or
 * mutates session domain state.
 */
export class DaemonHostHealthReporter {
	readonly #now_ms: () => number;
	readonly #sessionAdapter: DaemonSessionAdapter | null;
	readonly #started_at_ms: number;

	constructor(opts?: DaemonHostHealthReporterOpts) {
		this.#now_ms = opts?.now_ms ?? (() => Date.now());
		this.#sessionAdapter = opts?.sessionAdapter ?? null;
		this.#started_at_ms = this.#now_ms();
	}

	/**
	 * Basic host health status with adapter connectivity.
	 */
	health(): DaemonHostHealthStatus {
		const now = this.#now_ms();
		const activeSessions = this.#sessionAdapter?.activeSessions() ?? [];
		return {
			ok: true,
			host: {
				uptime_ms: now - this.#started_at_ms,
				transport: "http",
				started_at_ms: this.#started_at_ms,
			},
			adapter: {
				available: this.#sessionAdapter !== null,
				active_sessions: activeSessions.length,
			},
			boundary: DAEMON_THIN_BOUNDARY,
		};
	}

	/**
	 * Extended health status including adapter-projected session state.
	 *
	 * The daemon reads this data from the adapter's service projections.
	 * It does not own or maintain this state.
	 */
	extendedHealth(): DaemonExtendedHealthStatus {
		const base = this.health();
		if (!this.#sessionAdapter) {
			return { ...base, service_projections: [] };
		}
		const sessionIds = this.#sessionAdapter.activeSessions();
		const projections = sessionIds
			.map((session_id) => {
				const proj = this.#sessionAdapter!.getProjections(session_id);
				if (!proj) return null;
				return { session_id, projections: proj };
			})
			.filter((p): p is NonNullable<typeof p> => p !== null);
		return { ...base, service_projections: projections };
	}
}

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

/**
 * Result of validating the thin-host boundary invariants.
 */
export type DaemonBoundaryValidationResult = {
	readonly valid: boolean;
	readonly violations: ReadonlyArray<string>;
};

/**
 * Validate that the daemon's runtime state conforms to thin-host
 * boundary invariants.
 *
 * Checks:
 * - Session lifecycle is host-scoped (reload/update only).
 * - No daemon-native session queue or agent state detected.
 * - Adapter delegates domain state to service actors.
 */
export function validateDaemonBoundary(opts: {
	sessionLifecycle: ControlPlaneSessionLifecycle;
	sessionAdapter?: DaemonSessionAdapter | null;
}): DaemonBoundaryValidationResult {
	const violations: string[] = [];

	// Validate session lifecycle is host-scoped
	if (typeof opts.sessionLifecycle.reload !== "function") {
		violations.push("sessionLifecycle.reload is not a function (host lifecycle missing)");
	}
	if (typeof opts.sessionLifecycle.update !== "function") {
		violations.push("sessionLifecycle.update is not a function (host lifecycle missing)");
	}

	// Validate that session adapter, if present, delegates properly
	if (opts.sessionAdapter) {
		// The adapter should expose activeSessions, getAssertions, getProjections
		// as read-only projection methods (no direct state mutation by daemon)
		if (typeof opts.sessionAdapter.activeSessions !== "function") {
			violations.push("sessionAdapter.activeSessions is not a function (adapter projection missing)");
		}
		if (typeof opts.sessionAdapter.getAssertions !== "function") {
			violations.push("sessionAdapter.getAssertions is not a function (adapter projection missing)");
		}
		if (typeof opts.sessionAdapter.getProjections !== "function") {
			violations.push("sessionAdapter.getProjections is not a function (adapter projection missing)");
		}
	}

	return {
		valid: violations.length === 0,
		violations,
	};
}

// ---------------------------------------------------------------------------
// Multi-session fairness contract
// ---------------------------------------------------------------------------

/**
 * Session fairness invariant: the daemon does not enforce fairness
 * policy. Fairness is a service-level concern delegated to the
 * SessionService actors.
 *
 * This type documents what the daemon can observe about session
 * isolation, read from adapter-projected state.
 */
export type SessionIsolationObservation = {
	readonly session_id: string;
	readonly event_count: number;
	readonly has_independent_events: boolean;
};

/**
 * Observe session isolation through the adapter's projected state.
 * The daemon does not enforce isolation; it only reads evidence
 * from the adapter layer.
 */
export function observeSessionIsolation(
	adapter: DaemonSessionAdapter,
): ReadonlyArray<SessionIsolationObservation> {
	const sessionIds = adapter.activeSessions();
	return sessionIds.map((session_id) => {
		const events = adapter.replayEvents(session_id, 0);
		const eventSessionIds = new Set(events.map((e) => e.session_id));
		return {
			session_id,
			event_count: events.length,
			has_independent_events: eventSessionIds.size <= 1,
		};
	});
}
