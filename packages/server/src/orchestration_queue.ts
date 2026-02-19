export type OrchestrationQueueState =
	| "queued"
	| "active"
	| "waiting_review"
	| "refining"
	| "done"
	| "failed"
	| "cancelled";

/**
 * Inter-root scheduler policy knob for durable queue drain.
 * - sequential: exactly one active root (`max_active_roots=1`)
 * - parallel: bounded fanout (`max_active_roots>=1`)
 */
export type InterRootQueuePolicy =
	| { mode: "sequential"; max_active_roots: 1 }
	| { mode: "parallel"; max_active_roots: number };

export const DEFAULT_INTER_ROOT_QUEUE_POLICY: InterRootQueuePolicy = {
	mode: "sequential",
	max_active_roots: 1,
};

export function normalizeInterRootQueuePolicy(policy: InterRootQueuePolicy | null | undefined): InterRootQueuePolicy {
	if (!policy) {
		return DEFAULT_INTER_ROOT_QUEUE_POLICY;
	}
	if (policy.mode === "parallel") {
		return {
			mode: "parallel",
			max_active_roots: Math.max(1, Math.trunc(policy.max_active_roots)),
		};
	}
	return DEFAULT_INTER_ROOT_QUEUE_POLICY;
}

/**
 * Allowed queue transitions. Queue tests should enforce this table exactly.
 */
export const ORCHESTRATION_QUEUE_ALLOWED_TRANSITIONS: Record<
	OrchestrationQueueState,
	readonly OrchestrationQueueState[]
> = {
	queued: ["active", "cancelled"],
	active: ["waiting_review", "done", "failed", "cancelled"],
	waiting_review: ["refining", "done", "failed", "cancelled"],
	refining: ["queued", "failed", "cancelled"],
	done: [],
	failed: [],
	cancelled: [],
};

export const ORCHESTRATION_QUEUE_INVARIANTS = [
	"ORCH-QUEUE-001: Queue writes are durable before acknowledging enqueue/start/resume requests.",
	"ORCH-QUEUE-002: Queue dispatch must claim exactly one active item at a time per root slot.",
	"ORCH-QUEUE-003: Terminal states (done|failed|cancelled) are immutable.",
	"ORCH-QUEUE-004: Review path is active -> waiting_review -> (done | refining).",
	"ORCH-QUEUE-005: Refinement re-enters execution only via refining -> queued.",
	"ORCH-QUEUE-006: sequential policy permits <=1 active root; parallel permits <=max_active_roots active roots.",
] as const;

const INTER_ROOT_OCCUPIED_STATES = new Set<OrchestrationQueueState>(["active", "waiting_review", "refining"]);

export type InterRootQueueSnapshot = {
	queue_id: string;
	root_issue_id: string | null;
	state: OrchestrationQueueState;
	job_id: string | null;
	created_at_ms: number;
};

export type InterRootQueueReconcilePlan = {
	policy: InterRootQueuePolicy;
	max_active_roots: number;
	active_root_count: number;
	available_root_slots: number;
	activate_queue_ids: string[];
	launch_queue_ids: string[];
};

export const INTER_ROOT_QUEUE_RECONCILE_INVARIANTS = [
	"ORCH-INTER-ROOT-RECON-001: one queue snapshot + policy yields one deterministic activation/launch plan.",
	"ORCH-INTER-ROOT-RECON-002: activation order is FIFO (`created_at_ms`, then `queue_id`) with per-root slot dedupe.",
	"ORCH-INTER-ROOT-RECON-003: sequential policy admits <=1 occupied root; parallel admits <=max_active_roots roots.",
	"ORCH-INTER-ROOT-RECON-004: launch candidates are active rows without bound job ids, one launch per root slot.",
] as const;

function stableCompare(a: InterRootQueueSnapshot, b: InterRootQueueSnapshot): number {
	if (a.created_at_ms !== b.created_at_ms) {
		return a.created_at_ms - b.created_at_ms;
	}
	return a.queue_id.localeCompare(b.queue_id);
}

function normalizeMaxActiveRoots(policy: InterRootQueuePolicy): number {
	if (policy.mode === "parallel") {
		return Math.max(1, Math.trunc(policy.max_active_roots));
	}
	return 1;
}

function queueRootSlotKey(row: Pick<InterRootQueueSnapshot, "queue_id" | "root_issue_id">): string {
	return row.root_issue_id ? `root:${row.root_issue_id}` : `queue:${row.queue_id}`;
}

/**
 * Deterministic inter-root queue reconcile primitive.
 *
 * Computes queue activation/launch intentions from durable queue state and policy. The caller is
 * responsible for performing side effects (claim, launch, bind, transition) and reconciling again
 * against refreshed queue/runtime snapshots.
 */
export function reconcileInterRootQueue<Row extends InterRootQueueSnapshot>(
	rows: readonly Row[],
	policy: InterRootQueuePolicy,
): InterRootQueueReconcilePlan {
	const sorted = [...rows].sort(stableCompare);
	const maxActiveRoots = normalizeMaxActiveRoots(policy);

	const occupiedRoots = new Set<string>();
	const launchRoots = new Set<string>();
	const launchQueueIds: string[] = [];
	for (const row of sorted) {
		if (!INTER_ROOT_OCCUPIED_STATES.has(row.state)) {
			continue;
		}
		const slotKey = queueRootSlotKey(row);
		occupiedRoots.add(slotKey);
		if (row.state !== "active" || row.job_id != null || launchRoots.has(slotKey)) {
			continue;
		}
		launchRoots.add(slotKey);
		launchQueueIds.push(row.queue_id);
	}

	const availableRootSlots = Math.max(0, maxActiveRoots - occupiedRoots.size);
	const claimedRoots = new Set<string>();
	const activateQueueIds: string[] = [];
	if (availableRootSlots > 0) {
		for (const row of sorted) {
			if (row.state !== "queued") {
				continue;
			}
			const slotKey = queueRootSlotKey(row);
			if (occupiedRoots.has(slotKey) || claimedRoots.has(slotKey)) {
				continue;
			}
			claimedRoots.add(slotKey);
			activateQueueIds.push(row.queue_id);
			if (activateQueueIds.length >= availableRootSlots) {
				break;
			}
		}
	}

	return {
		policy,
		max_active_roots: maxActiveRoots,
		active_root_count: occupiedRoots.size,
		available_root_slots: availableRootSlots,
		activate_queue_ids: activateQueueIds,
		launch_queue_ids: launchQueueIds,
	};
}
