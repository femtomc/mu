export const DEFAULT_FORUM_READ_LIMIT = 50;
export const MAX_FORUM_READ_LIMIT = 200;

export class ForumStoreValidationError extends Error {
	public constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "ForumStoreValidationError";
	}
}

export function normalizeForumTopic(topic: unknown): string {
	if (typeof topic !== "string") {
		throw new ForumStoreValidationError("topic is required");
	}
	const normalized = topic.trim();
	if (normalized.length === 0) {
		throw new ForumStoreValidationError("topic is required");
	}
	return normalized;
}

export function normalizeForumPrefix(prefix: unknown): string | null {
	if (prefix == null || prefix === "") {
		return null;
	}
	if (typeof prefix !== "string") {
		throw new ForumStoreValidationError("invalid prefix filter: expected string");
	}
	const normalized = prefix.trim();
	return normalized.length > 0 ? normalized : null;
}

export function normalizeForumReadLimit(limit: unknown): number {
	if (limit == null || limit === "") {
		return DEFAULT_FORUM_READ_LIMIT;
	}
	let value: number;
	if (typeof limit === "number" && Number.isFinite(limit)) {
		value = limit;
	} else if (typeof limit === "string" && /^\d+$/.test(limit.trim())) {
		value = Number.parseInt(limit, 10);
	} else {
		throw new ForumStoreValidationError("invalid limit: expected positive integer");
	}

	const normalized = Math.trunc(value);
	if (normalized < 1) {
		throw new ForumStoreValidationError("invalid limit: must be >= 1");
	}
	return Math.min(MAX_FORUM_READ_LIMIT, normalized);
}
