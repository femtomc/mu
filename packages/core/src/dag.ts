import type { Issue } from "./spec.js";

export type ValidationResult = {
	is_final: boolean;
	reason: string;
};

export type RetryableDagCandidate = {
	issue: Issue;
	reason: string;
};

/**
 * Deterministic DAG reconcile primitives used by orchestrator reconciliation.
 *
 * Contract: these helpers are pure functions over the provided issue snapshot and must remain
 * side-effect free so reconcile passes are replayable/idempotent.
 */
export const DAG_RECONCILE_PRIMITIVE_INVARIANTS = [
	"DAG-RECON-001: `readyLeaves` only returns open, unblocked, leaf issues within the requested subtree scope.",
	"DAG-RECON-002: `readyLeaves` ordering is deterministic for a fixed input snapshot (priority-ordered candidate set).",
	"DAG-RECON-003: `validateDag(...).is_final=true` implies no remaining non-expanded open work in the subtree.",
	"DAG-RECON-004: closed(failure|needs_work) and expanded-without-children are non-final and require reconcile action.",
	"DAG-RECON-005: `retryableDagCandidates` selection is deterministic and side-effect free for a fixed snapshot + attempts map.",
] as const;

function childrenByParent(issues: readonly Issue[]): Map<string, Issue[]> {
	const byParent = new Map<string, Issue[]>();
	for (const issue of issues) {
		for (const dep of issue.deps) {
			if (dep.type !== "parent") {
				continue;
			}
			const list = byParent.get(dep.target) ?? [];
			list.push(issue);
			byParent.set(dep.target, list);
		}
	}
	return byParent;
}

function compareByPriorityThenId(a: Pick<Issue, "id" | "priority">, b: Pick<Issue, "id" | "priority">): number {
	const pa = a.priority ?? 3;
	const pb = b.priority ?? 3;
	if (pa !== pb) {
		return pa - pb;
	}
	return a.id.localeCompare(b.id);
}

export function subtreeIds(issues: readonly Issue[], rootId: string): string[] {
	const children = childrenByParent(issues);

	const result: string[] = [];
	const q: string[] = [rootId];
	const seen = new Set<string>();

	while (q.length > 0) {
		const nodeId = q.shift();
		if (!nodeId) {
			continue;
		}
		if (seen.has(nodeId)) {
			continue;
		}
		seen.add(nodeId);
		result.push(nodeId);
		for (const child of children.get(nodeId) ?? []) {
			q.push(child.id);
		}
	}

	return result;
}

/**
 * Reconcile selection primitive: the orchestrator must only dispatch from this ready set (or an
 * equivalent deterministic adapter) to preserve replayability.
 */
export function readyLeaves(
	issues: readonly Issue[],
	opts: { root_id?: string; tags?: readonly string[] } = {},
): Issue[] {
	const byId = new Map(issues.map((i) => [i.id, i]));
	const idsInScope = new Set(opts.root_id ? subtreeIds(issues, opts.root_id) : byId.keys());

	const blocked = new Set<string>();
	for (const issue of issues) {
		for (const dep of issue.deps) {
			if (dep.type !== "blocks") {
				continue;
			}
			if (issue.status !== "closed" || issue.outcome === "expanded") {
				blocked.add(dep.target);
			}
		}
	}

	const children = childrenByParent(issues);

	const result: Issue[] = [];
	for (const issueId of idsInScope) {
		const issue = byId.get(issueId);
		if (!issue || issue.status !== "open") {
			continue;
		}
		if (blocked.has(issueId)) {
			continue;
		}
		const kids = children.get(issueId) ?? [];
		if (kids.some((kid) => kid.status !== "closed")) {
			continue;
		}
		if (opts.tags && !opts.tags.every((tag) => issue.tags.includes(tag))) {
			continue;
		}
		result.push(issue);
	}

	result.sort(compareByPriorityThenId);
	return result;
}

/**
 * Reconcile retry primitive.
 *
 * Produces a deterministic list of closed nodes that are eligible to be reopened for orchestration.
 * The orchestrator decides whether/when to apply the reopen side effect.
 */
export function retryableDagCandidates(
	issues: readonly Issue[],
	opts: {
		root_id: string;
		retry_outcomes?: readonly string[];
		attempts_by_issue_id?: ReadonlyMap<string, number>;
		max_attempts?: number;
	},
): RetryableDagCandidate[] {
	const idsInScope = new Set(subtreeIds(issues, opts.root_id));
	const children = childrenByParent(issues);
	const retryOutcomes = new Set(opts.retry_outcomes ?? ["failure", "needs_work"]);
	const maxAttempts =
		typeof opts.max_attempts === "number" && Number.isFinite(opts.max_attempts)
			? Math.max(1, Math.trunc(opts.max_attempts))
			: Number.POSITIVE_INFINITY;

	const out: RetryableDagCandidate[] = [];
	for (const issue of issues) {
		if (!idsInScope.has(issue.id)) {
			continue;
		}
		if (issue.status !== "closed") {
			continue;
		}

		const attempts = opts.attempts_by_issue_id?.get(issue.id) ?? 0;
		if (attempts >= maxAttempts) {
			continue;
		}

		if (issue.outcome && retryOutcomes.has(issue.outcome)) {
			const hasOpenChildren = (children.get(issue.id) ?? []).some((child) => child.status !== "closed");
			if (!hasOpenChildren) {
				out.push({ issue, reason: `outcome=${issue.outcome}` });
			}
			continue;
		}

		if (issue.outcome === "expanded" && (children.get(issue.id)?.length ?? 0) === 0) {
			out.push({ issue, reason: "outcome=expanded_without_children" });
		}
	}

	out.sort((a, b) => compareByPriorityThenId(a.issue, b.issue));
	return out;
}

export function collapsible(issues: readonly Issue[], rootId: string): Issue[] {
	const byId = new Map(issues.map((i) => [i.id, i]));
	const idsInScope = new Set(subtreeIds(issues, rootId));
	const children = childrenByParent(issues);

	// `refine` is terminal for a closed reviewer node; refinement itself is
	// orchestrated by root-phase reconcile transitions.
	const terminalOutcomes = new Set(["success", "skipped", "refine"]);
	const result: Issue[] = [];

	for (const issueId of idsInScope) {
		const node = byId.get(issueId);
		if (!node) {
			continue;
		}
		if (node.status !== "closed" || node.outcome !== "expanded") {
			continue;
		}
		const kids = children.get(issueId) ?? [];
		if (kids.length === 0) {
			continue;
		}
		if (kids.every((kid) => kid.status === "closed" && kid.outcome != null && terminalOutcomes.has(kid.outcome))) {
			result.push(node);
		}
	}

	result.sort((a, b) => a.id.localeCompare(b.id));
	return result;
}

/**
 * Reconcile termination primitive.
 *
 * `is_final=false` is a hard signal that orchestrator must continue reconciling (or repair invalid
 * expanded state) before the root run can be considered terminal.
 */
export function validateDag(issues: readonly Issue[], rootId: string): ValidationResult {
	const byId = new Map(issues.map((i) => [i.id, i]));
	const ids = new Set(subtreeIds(issues, rootId));

	const root = byId.get(rootId);
	if (!root) {
		return { is_final: true, reason: "root not found" };
	}

	const children = childrenByParent(issues);

	const needsReorch = [...ids]
		.filter((issueId) => {
			const issue = byId.get(issueId);
			return issue?.status === "closed" && (issue.outcome === "failure" || issue.outcome === "needs_work");
		})
		.sort();
	if (needsReorch.length > 0) {
		return { is_final: false, reason: `needs work: ${needsReorch.join(",")}` };
	}

	const badExpanded = [...ids]
		.filter((issueId) => {
			const issue = byId.get(issueId);
			return (
				issue?.status === "closed" && issue.outcome === "expanded" && (children.get(issueId)?.length ?? 0) === 0
			);
		})
		.sort();
	if (badExpanded.length > 0) {
		return { is_final: false, reason: `expanded without children: ${badExpanded.join(",")}` };
	}

	const pending = [...ids].filter((issueId) => {
		const issue = byId.get(issueId);
		if (!issue) {
			return false;
		}
		if (issue.status === "closed" && issue.outcome === "expanded") {
			return false;
		}
		return issue.status !== "closed";
	});

	if (pending.length === 0) {
		return { is_final: true, reason: "all work completed" };
	}

	if (pending.length === 1 && pending[0] === rootId && ids.size > 1) {
		return { is_final: false, reason: "all children closed, root still open" };
	}

	return { is_final: false, reason: "in progress" };
}
