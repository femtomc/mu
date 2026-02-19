import { readyLeaves, retryableDagCandidates, type Issue, type ValidationResult, validateDag } from "@femtomc/mu-core";

export type DagRootPhase = "active" | "waiting_review" | "refining" | "done";

export const DAG_ROOT_PHASE_TAG_PREFIX = "loop:";

const ROOT_PHASES = new Set<DagRootPhase>(["active", "waiting_review", "refining", "done"]);
const REVIEWER_ROLE_TAG = "role:reviewer";
const REVIEW_ROUND_TAG_PREFIX = "review:round:";
const ACCEPT_OUTCOMES = new Set(["accept", "success"]);
const REFINE_OUTCOMES = new Set(["failure", "needs_work", "refine"]);
const DEFAULT_DISPATCH_TAGS = ["node:agent"] as const;
const DEFAULT_MAX_REFINE_ROUNDS = 3;

export type DagReconcileDecision =
	| { kind: "root_final"; validation: ValidationResult }
	| { kind: "reopen_retryable"; issue: Issue; reason: string }
	| { kind: "dispatch_leaf"; issue: Issue }
	| { kind: "dispatch_reviewer"; issue: Issue; round: number }
	| { kind: "enter_waiting_review"; reason: string; round: number }
	| { kind: "review_accept"; issue: Issue; round: number }
	| { kind: "review_refine"; issue: Issue; round: number; reason: string }
	| { kind: "review_budget_exhausted"; issue: Issue; round: number; max_rounds: number }
	| { kind: "resume_active"; reason: string }
	| { kind: "repair_deadlock"; reason: string };

export type DagReconcileOpts = {
	issues: readonly Issue[];
	rootId: string;
	attemptsByIssueId?: ReadonlyMap<string, number>;
	maxReorchestrationAttempts?: number;
	maxRefineRoundsPerRoot?: number;
	dispatchTags?: readonly string[];
};

/**
 * Deterministic intra-root reconcile selector.
 *
 * This function is intentionally side-effect free: it inspects one DAG snapshot and computes the
 * next orchestrator action. The caller is responsible for applying effects and then reconciling
 * again against a refreshed snapshot.
 */
export const DAG_RECONCILE_ENGINE_INVARIANTS = [
	"ORCH-DAG-RECON-001: one snapshot in -> one deterministic next action out.",
	"ORCH-DAG-RECON-002: retryable reopen decisions are budget-aware and derived from DAG primitives.",
	"ORCH-DAG-RECON-003: root finality is checked before dispatch in non-retry paths.",
	"ORCH-DAG-RECON-004: leaf dispatch selection is delegated to deterministic core ready-leaf primitives.",
	"ORCH-DAG-RECON-005: review loop is explicit: active -> waiting_review -> (done | refining).",
	"ORCH-DAG-RECON-006: refine loops are deterministically budgeted per root.",
] as const;

function normalizeOutcome(outcome: string | null): string | null {
	if (typeof outcome !== "string") {
		return null;
	}
	const normalized = outcome.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

function compareByCreatedThenId(a: Issue, b: Issue): number {
	if (a.created_at !== b.created_at) {
		return a.created_at - b.created_at;
	}
	return a.id.localeCompare(b.id);
}

function reviewRound(issue: Pick<Issue, "tags">): number | null {
	for (const tag of issue.tags) {
		if (!tag.startsWith(REVIEW_ROUND_TAG_PREFIX)) {
			continue;
		}
		const raw = tag.slice(REVIEW_ROUND_TAG_PREFIX.length).trim();
		if (!/^\d+$/.test(raw)) {
			continue;
		}
		return Math.max(1, Number.parseInt(raw, 10));
	}
	return null;
}

function compareReviewerIssues(a: Issue, b: Issue): number {
	const ar = reviewRound(a);
	const br = reviewRound(b);
	if (ar != null || br != null) {
		if (ar == null) {
			return -1;
		}
		if (br == null) {
			return 1;
		}
		if (ar !== br) {
			return ar - br;
		}
	}
	return compareByCreatedThenId(a, b);
}

function hasParentDep(issue: Issue, parentId: string): boolean {
	return issue.deps.some((dep) => dep.type === "parent" && dep.target === parentId);
}

function isReviewerIssue(issue: Pick<Issue, "tags">): boolean {
	return issue.tags.includes(REVIEWER_ROLE_TAG);
}

function reviewerIssuesForRoot(issues: readonly Issue[], rootId: string): Issue[] {
	return issues
		.filter((issue) => isReviewerIssue(issue) && hasParentDep(issue, rootId))
		.sort(compareReviewerIssues);
}

function normalizeMaxRefineRounds(value: number | undefined): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(1, Math.trunc(value));
	}
	return DEFAULT_MAX_REFINE_ROUNDS;
}

export function rootPhaseFromTags(tags: readonly string[]): DagRootPhase {
	for (const tag of tags) {
		if (!tag.startsWith(DAG_ROOT_PHASE_TAG_PREFIX)) {
			continue;
		}
		const candidate = tag.slice(DAG_ROOT_PHASE_TAG_PREFIX.length) as DagRootPhase;
		if (ROOT_PHASES.has(candidate)) {
			return candidate;
		}
	}
	return "active";
}

export function withRootPhaseTag(tags: readonly string[], phase: DagRootPhase): string[] {
	const withoutPhase = tags.filter((tag) => !tag.startsWith(DAG_ROOT_PHASE_TAG_PREFIX));
	return [...withoutPhase, `${DAG_ROOT_PHASE_TAG_PREFIX}${phase}`];
}

export function reconcileDagTurn(opts: DagReconcileOpts): DagReconcileDecision {
	const root = opts.issues.find((issue) => issue.id === opts.rootId) ?? null;
	const rootPhase = rootPhaseFromTags(root?.tags ?? []);
	const reviewerIssues = reviewerIssuesForRoot(opts.issues, opts.rootId);
	const latestReviewer = reviewerIssues.length > 0 ? reviewerIssues[reviewerIssues.length - 1]! : null;
	const latestReviewRound = latestReviewer ? (reviewRound(latestReviewer) ?? reviewerIssues.length) : 0;
	const nextReviewRound = latestReviewRound > 0 ? latestReviewRound + 1 : 1;
	const maxRefineRounds = normalizeMaxRefineRounds(opts.maxRefineRoundsPerRoot);
	const refineRoundsUsed = reviewerIssues.filter((issue) => {
		if (issue.status !== "closed") {
			return false;
		}
		const outcome = normalizeOutcome(issue.outcome);
		return outcome != null && REFINE_OUTCOMES.has(outcome);
	}).length;

	if (rootPhase === "refining") {
		return {
			kind: "resume_active",
			reason: "review_requested_refinement",
		};
	}

	if (rootPhase === "waiting_review") {
		if (!latestReviewer) {
			return {
				kind: "enter_waiting_review",
				reason: "reviewer_missing",
				round: nextReviewRound,
			};
		}

		if (latestReviewer.status === "open") {
			return {
				kind: "dispatch_reviewer",
				issue: latestReviewer,
				round: latestReviewRound,
			};
		}

		if (latestReviewer.status === "in_progress") {
			return {
				kind: "repair_deadlock",
				reason: `reviewer in_progress: ${latestReviewer.id}`,
			};
		}

		const outcome = normalizeOutcome(latestReviewer.outcome);
		if (outcome != null && ACCEPT_OUTCOMES.has(outcome)) {
			return {
				kind: "review_accept",
				issue: latestReviewer,
				round: latestReviewRound,
			};
		}

		if (refineRoundsUsed > maxRefineRounds) {
			return {
				kind: "review_budget_exhausted",
				issue: latestReviewer,
				round: latestReviewRound,
				max_rounds: maxRefineRounds,
			};
		}

		return {
			kind: "review_refine",
			issue: latestReviewer,
			round: latestReviewRound,
			reason: `outcome=${outcome ?? "null"}`,
		};
	}

	if (rootPhase === "done") {
		const validation = validateDag(opts.issues, opts.rootId);
		if (validation.is_final) {
			return { kind: "root_final", validation };
		}
		return {
			kind: "resume_active",
			reason: "done_phase_not_final",
		};
	}

	const retryable = retryableDagCandidates(opts.issues, {
		root_id: opts.rootId,
		attempts_by_issue_id: opts.attemptsByIssueId,
		max_attempts: opts.maxReorchestrationAttempts,
	}).filter((entry) => !isReviewerIssue(entry.issue));
	if (retryable.length > 0) {
		const target = retryable[0]!;
		return {
			kind: "reopen_retryable",
			issue: target.issue,
			reason: target.reason,
		};
	}

	const validation = validateDag(opts.issues, opts.rootId);
	if (validation.is_final) {
		return {
			kind: "enter_waiting_review",
			reason: validation.reason,
			round: nextReviewRound,
		};
	}

	const ready = readyLeaves(opts.issues, {
		root_id: opts.rootId,
		tags: opts.dispatchTags ?? DEFAULT_DISPATCH_TAGS,
	}).filter((issue) => !isReviewerIssue(issue));
	if (ready.length === 0) {
		return {
			kind: "repair_deadlock",
			reason: validation.reason,
		};
	}

	return {
		kind: "dispatch_leaf",
		issue: ready[0]!,
	};
}
