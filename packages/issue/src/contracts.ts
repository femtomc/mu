import type { Issue } from "@femtomc/mu-core";

export const ISSUE_STATUS_VALUES = ["open", "in_progress", "closed"] as const satisfies readonly Issue["status"][];

const ISSUE_STATUS_SET = new Set<Issue["status"]>(ISSUE_STATUS_VALUES);

export class IssueStoreError extends Error {
	public constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "IssueStoreError";
	}
}

export class IssueStoreNotFoundError extends IssueStoreError {
	public readonly issueId: string;

	public constructor(issueId: string) {
		super(`issue not found: ${issueId}`);
		this.name = "IssueStoreNotFoundError";
		this.issueId = issueId;
	}
}

export class IssueStoreValidationError extends IssueStoreError {
	public constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "IssueStoreValidationError";
	}
}

export function normalizeIssueStatusFilter(status: unknown): Issue["status"] | undefined {
	if (status == null || status === "") {
		return undefined;
	}
	if (typeof status !== "string") {
		throw new IssueStoreValidationError("invalid issue status filter: expected string");
	}
	const trimmed = status.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (!ISSUE_STATUS_SET.has(trimmed as Issue["status"])) {
		throw new IssueStoreValidationError(`invalid issue status filter: ${trimmed}`);
	}
	return trimmed as Issue["status"];
}

export function normalizeIssueTagFilter(tag: unknown): string | undefined {
	if (tag == null || tag === "") {
		return undefined;
	}
	if (typeof tag !== "string") {
		throw new IssueStoreValidationError("invalid issue tag filter: expected string");
	}
	const trimmed = tag.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeIssueDepInput(input: { depType: unknown; target: unknown }): {
	depType: string;
	target: string;
} {
	const depType = typeof input.depType === "string" ? input.depType.trim() : "";
	if (depType.length === 0) {
		throw new IssueStoreValidationError("dependency type is required");
	}
	const target = typeof input.target === "string" ? input.target.trim() : "";
	if (target.length === 0) {
		throw new IssueStoreValidationError("dependency target is required");
	}
	return { depType, target };
}
