import { describe, expect, test } from "bun:test";
import { collapsible, type Issue, IssueSchema, readyLeaves, subtreeIds, validateDag } from "@femtomc/mu-core";

function mkIssue(overrides: Partial<Issue> & Pick<Issue, "id" | "title">): Issue {
	const base: Issue = {
		id: overrides.id,
		title: overrides.title,
		body: "",
		status: "open",
		outcome: null,
		tags: ["node:agent"],
		deps: [],
		execution_spec: null,
		priority: 3,
		created_at: 1,
		updated_at: 1,
	};
	return IssueSchema.parse({ ...base, ...overrides });
}

describe("subtreeIds", () => {
	test("includes root and descendants via parent deps", () => {
		const root = mkIssue({ id: "root", title: "root", tags: ["node:agent", "node:root"] });
		const child = mkIssue({ id: "child", title: "child", deps: [{ type: "parent", target: root.id }] });
		const grandchild = mkIssue({
			id: "grandchild",
			title: "grandchild",
			deps: [{ type: "parent", target: child.id }],
		});

		const ids = subtreeIds([root, child, grandchild], root.id);
		expect(new Set(ids)).toEqual(new Set([root.id, child.id, grandchild.id]));
	});
});

describe("readyLeaves", () => {
	test("empty", () => {
		expect(readyLeaves([])).toEqual([]);
	});

	test("scoped by root", () => {
		const root = mkIssue({ id: "root", title: "root", tags: ["node:agent", "node:root"] });
		const child = mkIssue({ id: "child", title: "child", deps: [{ type: "parent", target: root.id }] });

		const out = readyLeaves([root, child], { root_id: root.id });
		expect(out.map((i) => i.id)).toEqual([child.id]);
	});

	test("blocked excluded", () => {
		const root = mkIssue({ id: "root", title: "root", tags: ["node:agent", "node:root"] });
		const a = mkIssue({ id: "a", title: "a", deps: [{ type: "parent", target: root.id }] });
		const b = mkIssue({ id: "b", title: "b", deps: [{ type: "parent", target: root.id }] });
		const aBlocksB: Issue = IssueSchema.parse({
			...a,
			deps: [...a.deps, { type: "blocks", target: b.id }],
		});

		const out = readyLeaves([root, aBlocksB, b], { root_id: root.id });
		const ids = out.map((i) => i.id);
		expect(ids).toContain(a.id);
		expect(ids).not.toContain(b.id);
	});

	test("closed-success unblocks; closed-expanded still blocks", () => {
		const root = mkIssue({ id: "root", title: "root", tags: ["node:agent", "node:root"] });
		const blocker = mkIssue({ id: "blocker", title: "blocker", deps: [{ type: "parent", target: root.id }] });
		const target = mkIssue({ id: "target", title: "target", deps: [{ type: "parent", target: root.id }] });

		const blocksTarget: Issue = IssueSchema.parse({
			...blocker,
			deps: [...blocker.deps, { type: "blocks", target: target.id }],
		});

		const out1 = readyLeaves([root, blocksTarget, target], { root_id: root.id }).map((i) => i.id);
		expect(out1).not.toContain(target.id);

		const closedSuccess: Issue = IssueSchema.parse({ ...blocksTarget, status: "closed", outcome: "success" });
		const out2 = readyLeaves([root, closedSuccess, target], { root_id: root.id }).map((i) => i.id);
		expect(out2).toContain(target.id);

		const closedExpanded: Issue = IssueSchema.parse({ ...blocksTarget, status: "closed", outcome: "expanded" });
		const out3 = readyLeaves([root, closedExpanded, target], { root_id: root.id }).map((i) => i.id);
		expect(out3).not.toContain(target.id);
	});

	test("sorted by priority (ascending)", () => {
		const a = mkIssue({ id: "a", title: "a", priority: 3 });
		const b = mkIssue({ id: "b", title: "b", priority: 1 });
		expect(readyLeaves([a, b]).map((i) => i.id)).toEqual([b.id, a.id]);
	});
});

describe("validateDag", () => {
	test("root not found", () => {
		const v = validateDag([], "nope");
		expect(v.is_final).toBe(true);
		expect(v.reason.includes("not found")).toBe(true);
	});

	test("single open root", () => {
		const root = mkIssue({ id: "root", title: "root", tags: ["node:agent", "node:root"] });
		const v = validateDag([root], root.id);
		expect(v.is_final).toBe(false);
		expect(v.reason).toBe("in progress");
	});

	test("single root closed success", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			tags: ["node:agent", "node:root"],
			status: "closed",
			outcome: "success",
		});
		const v = validateDag([root], root.id);
		expect(v.is_final).toBe(true);
	});

	test("descendant failure triggers needs work", () => {
		const root = mkIssue({ id: "root", title: "root", tags: ["node:agent", "node:root"] });
		const child = mkIssue({
			id: "child",
			title: "child",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "failure",
		});
		const v = validateDag([root, child], root.id);
		expect(v.is_final).toBe(false);
		expect(v.reason.includes("needs work")).toBe(true);
	});

	test("expanded root with open children is in progress", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root"],
		});
		const c1 = mkIssue({ id: "c1", title: "c1", deps: [{ type: "parent", target: root.id }] });
		const c2 = mkIssue({ id: "c2", title: "c2", deps: [{ type: "parent", target: root.id }] });
		const v = validateDag([root, c1, c2], root.id);
		expect(v.is_final).toBe(false);
		expect(v.reason).toBe("in progress");
	});

	test("expanded root all children done is final", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root"],
		});
		const c1 = mkIssue({
			id: "c1",
			title: "c1",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "success",
		});
		const c2 = mkIssue({
			id: "c2",
			title: "c2",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "success",
		});
		const v = validateDag([root, c1, c2], root.id);
		expect(v.is_final).toBe(true);
		expect(v.reason).toBe("all work completed");
	});

	test("expanded without children is not final", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root"],
		});
		const v = validateDag([root], root.id);
		expect(v.is_final).toBe(false);
		expect(v.reason.includes("expanded without children")).toBe(true);
	});

	test("root open, all descendants closed signals readiness", () => {
		const root = mkIssue({ id: "root", title: "root", tags: ["node:agent", "node:root"] });
		const child = mkIssue({
			id: "child",
			title: "child",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "success",
		});
		const v = validateDag([root, child], root.id);
		expect(v.is_final).toBe(false);
		expect(v.reason.includes("all children closed")).toBe(true);
	});
});

describe("collapsible", () => {
	test("expanded root with all children success returns root", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root"],
		});
		const c1 = mkIssue({
			id: "c1",
			title: "c1",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "success",
		});
		const c2 = mkIssue({
			id: "c2",
			title: "c2",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "success",
		});

		const out = collapsible([root, c1, c2], root.id);
		expect(out.map((i) => i.id)).toEqual([root.id]);
	});

	test("nested expansion is bottom-up (outer blocked by expanded child)", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root"],
		});
		const child = mkIssue({
			id: "child",
			title: "child",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "expanded",
		});
		const gc1 = mkIssue({
			id: "gc1",
			title: "gc1",
			deps: [{ type: "parent", target: child.id }],
			status: "closed",
			outcome: "success",
		});
		const gc2 = mkIssue({
			id: "gc2",
			title: "gc2",
			deps: [{ type: "parent", target: child.id }],
			status: "closed",
			outcome: "success",
		});

		const out = collapsible([root, child, gc1, gc2], root.id);
		expect(out.map((i) => i.id)).toEqual([child.id]);
	});
});
