import type { ExecutionSpec } from "../spec.js";

function emptyStringToNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function executionSpecFromDict(d: Record<string, unknown>, _repoRoot?: string): ExecutionSpec {
	const role = emptyStringToNull(d.role);
	const review = typeof d.review === "boolean" ? d.review : false;

	return {
		role,
		review,
	};
}
