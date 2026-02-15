import type { Issue } from "./spec";

export type ValidationResult = {
	is_final: boolean;
	reason: string;
};

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

	result.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
	return result;
}

export function collapsible(issues: readonly Issue[], rootId: string): Issue[] {
	const byId = new Map(issues.map((i) => [i.id, i]));
	const idsInScope = new Set(subtreeIds(issues, rootId));
	const children = childrenByParent(issues);

	const terminalOutcomes = new Set(["success", "skipped"]);
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
