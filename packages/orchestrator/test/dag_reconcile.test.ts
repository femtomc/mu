import { describe, expect, test } from "bun:test";
import { type Issue, IssueSchema } from "@femtomc/mu-core";
import { reconcileDagTurn } from "@femtomc/mu-orchestrator";

function mkIssue(overrides: Partial<Issue> & Pick<Issue, "id" | "title">): Issue {
	const base: Issue = {
		id: overrides.id,
		title: overrides.title,
		body: "",
		status: "open",
		outcome: null,
		tags: ["node:agent"],
		deps: [],
		priority: 3,
		created_at: 1,
		updated_at: 1,
	};
	return IssueSchema.parse({ ...base, ...overrides });
}

describe("reconcileDagTurn", () => {
	test("is idempotent for repeated reconcile passes over unchanged snapshot", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root", "loop:active"],
		});
		const leaf = mkIssue({
			id: "leaf",
			title: "leaf",
			deps: [{ type: "parent", target: root.id }],
			tags: ["node:agent", "role:worker"],
		});

		const opts = {
			issues: [root, leaf],
			rootId: root.id,
			attemptsByIssueId: new Map<string, number>(),
			maxReorchestrationAttempts: 3,
			dispatchTags: ["node:agent"] as const,
		};

		const first = reconcileDagTurn(opts);
		const second = reconcileDagTurn(opts);
		expect(first).toEqual(second);
		expect(first.kind).toBe("dispatch_leaf");
	});

	test("retryable worker failure still reopens deterministically", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "expanded",
			tags: ["node:agent", "node:root", "loop:active"],
		});
		const failed = mkIssue({
			id: "child",
			title: "child",
			deps: [{ type: "parent", target: root.id }],
			status: "closed",
			outcome: "failure",
			tags: ["node:agent", "role:worker"],
		});

		const decision = reconcileDagTurn({
			issues: [root, failed],
			rootId: root.id,
			attemptsByIssueId: new Map<string, number>([[failed.id, 1]]),
			maxReorchestrationAttempts: 3,
			dispatchTags: ["node:agent"],
		});
		expect(decision.kind).toBe("reopen_retryable");
	});

	test("quiesced active execution transitions into waiting_review", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "success",
			tags: ["node:agent", "node:root", "loop:active"],
		});
		const worker = mkIssue({
			id: "worker",
			title: "worker",
			status: "closed",
			outcome: "success",
			tags: ["node:agent", "role:worker"],
			deps: [{ type: "parent", target: root.id }],
		});

		const decision = reconcileDagTurn({
			issues: [root, worker],
			rootId: root.id,
			dispatchTags: ["node:agent"],
		});
		expect(decision.kind).toBe("enter_waiting_review");
	});

	test("waiting_review -> done on accept", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "success",
			tags: ["node:agent", "node:root", "loop:waiting_review"],
		});
		const reviewer = mkIssue({
			id: "review-1",
			title: "review",
			status: "closed",
			outcome: "success",
			tags: ["node:agent", "role:reviewer"],
			deps: [{ type: "parent", target: root.id }],
			created_at: 5,
			updated_at: 5,
		});

		const decision = reconcileDagTurn({
			issues: [root, reviewer],
			rootId: root.id,
			dispatchTags: ["node:agent"],
		});
		expect(decision.kind).toBe("review_accept");
	});

	test("waiting_review -> refining -> active on refine/needs_work", () => {
		const rootWaiting = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "success",
			tags: ["node:agent", "node:root", "loop:waiting_review"],
		});
		const reviewerNeedsWork = mkIssue({
			id: "review-1",
			title: "review",
			status: "closed",
			outcome: "needs_work",
			tags: ["node:agent", "role:reviewer"],
			deps: [{ type: "parent", target: rootWaiting.id }],
			created_at: 5,
			updated_at: 5,
		});

		const d0 = reconcileDagTurn({
			issues: [rootWaiting, reviewerNeedsWork],
			rootId: rootWaiting.id,
			maxRefineRoundsPerRoot: 3,
			dispatchTags: ["node:agent"],
		});
		expect(d0.kind).toBe("review_refine");

		const rootRefining = IssueSchema.parse({ ...rootWaiting, tags: ["node:agent", "node:root", "loop:refining"] });
		const d1 = reconcileDagTurn({
			issues: [rootRefining, reviewerNeedsWork],
			rootId: rootRefining.id,
			maxRefineRoundsPerRoot: 3,
			dispatchTags: ["node:agent"],
		});
		expect(d1.kind).toBe("resume_active");
	});

	test("refine budget exhaustion is deterministic and terminal", () => {
		const root = mkIssue({
			id: "root",
			title: "root",
			status: "closed",
			outcome: "success",
			tags: ["node:agent", "node:root", "loop:waiting_review"],
		});
		const reviews = [1, 2, 3, 4].map((n) =>
			mkIssue({
				id: `review-${n}`,
				title: `review ${n}`,
				status: "closed",
				outcome: "refine",
				tags: ["node:agent", "role:reviewer"],
				deps: [{ type: "parent", target: root.id }],
				created_at: n,
				updated_at: n,
			}),
		);

		const decision = reconcileDagTurn({
			issues: [root, ...reviews],
			rootId: root.id,
			maxRefineRoundsPerRoot: 3,
			dispatchTags: ["node:agent"],
		});
		expect(decision.kind).toBe("review_budget_exhausted");
	});
});
