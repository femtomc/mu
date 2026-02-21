import { resolve as resolvePath } from "node:path";

export type ContextResolutionSource = "explicit" | "conversation" | "none";

export type ContextResolutionFailureReason =
	| "context_missing"
	| "context_ambiguous"
	| "context_unauthorized"
	| "cli_validation_failed";

export type ContextResolutionDecision =
	| {
			kind: "resolved";
			repoRoot: string;
			commandKey: string;
			args: string[];
			normalizedText: string;
			targetId: string;
			source: ContextResolutionSource;
	  }
	| {
			kind: "reject";
			reason: ContextResolutionFailureReason;
			details?: string;
	  };

export type CommandContextResolverOpts = {
	allowedRepoRoots?: readonly string[];
};

const ISSUE_ID_RE = /^mu-[a-z0-9][a-z0-9-]*$/;
const SAFE_TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_TARGET_RE = /^(?!-)[A-Za-z0-9._:@/-]{1,200}$/;

const ISSUE_TARGET_COMMANDS = new Set<string>(["issue get", "issue update", "issue claim", "issue close"]);
const TOPIC_TARGET_COMMANDS = new Set<string>(["forum read", "forum post"]);
const GENERIC_TARGET_COMMANDS = new Set<string>(["audit get", "dlq inspect", "dlq replay"]);

function readString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function collectDistinct(values: readonly string[]): string[] {
	const out: string[] = [];
	for (const value of values) {
		if (!out.includes(value)) {
			out.push(value);
		}
	}
	return out;
}

function collectIssueCandidates(opts: {
	inboundTargetType: string;
	inboundTargetId: string;
	metadata: Record<string, unknown>;
}): string[] {
	const candidates: string[] = [];
	const targetType = opts.inboundTargetType.toLowerCase();
	if (targetType === "issue" || targetType === "issue_id" || targetType === "root_issue") {
		const fromTarget = readString(opts.inboundTargetId);
		if (fromTarget) {
			candidates.push(fromTarget);
		}
	}

	for (const key of ["issue_id", "root_issue_id"]) {
		const fromMeta = readString(opts.metadata[key]);
		if (fromMeta) {
			candidates.push(fromMeta);
		}
	}

	const arr = opts.metadata.issue_ids;
	if (Array.isArray(arr)) {
		for (const entry of arr) {
			const item = readString(entry);
			if (item) {
				candidates.push(item);
			}
		}
	}

	return collectDistinct(candidates);
}

function collectTopicCandidates(opts: {
	inboundTargetType: string;
	inboundTargetId: string;
	metadata: Record<string, unknown>;
}): string[] {
	const candidates: string[] = [];
	const targetType = opts.inboundTargetType.toLowerCase();
	if (targetType === "topic" || targetType === "forum_topic" || targetType === "forum") {
		const fromTarget = readString(opts.inboundTargetId);
		if (fromTarget) {
			candidates.push(fromTarget);
		}
	}

	for (const key of ["topic", "forum_topic"]) {
		const fromMeta = readString(opts.metadata[key]);
		if (fromMeta) {
			candidates.push(fromMeta);
		}
	}

	return collectDistinct(candidates);
}

function reject(reason: ContextResolutionFailureReason, details?: string): ContextResolutionDecision {
	return {
		kind: "reject",
		reason,
		details,
	};
}

function resolveFromCandidates(opts: {
	explicitValue: string | undefined;
	conversationCandidates: readonly string[];
	validate: (value: string) => boolean;
	invalidDetails: string;
}):
	| { kind: "resolved"; value: string; source: ContextResolutionSource }
	| { kind: "reject"; reason: ContextResolutionFailureReason; details?: string } {
	if (opts.explicitValue != null) {
		if (!opts.validate(opts.explicitValue)) {
			return { kind: "reject", reason: "cli_validation_failed", details: opts.invalidDetails };
		}
		return {
			kind: "resolved",
			value: opts.explicitValue,
			source: "explicit",
		};
	}

	if (opts.conversationCandidates.length === 0) {
		return { kind: "reject", reason: "context_missing" };
	}
	if (opts.conversationCandidates.length > 1) {
		return {
			kind: "reject",
			reason: "context_ambiguous",
			details: `candidates=${opts.conversationCandidates.join(",")}`,
		};
	}

	const only = opts.conversationCandidates[0]!;
	if (!opts.validate(only)) {
		return { kind: "reject", reason: "cli_validation_failed", details: opts.invalidDetails };
	}
	return {
		kind: "resolved",
		value: only,
		source: "conversation",
	};
}

function normalizeTargetlessArgs(args: readonly string[]): string[] {
	return args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
}

export class CommandContextResolver {
	readonly #allowedRepoRoots: Set<string> | null;

	public constructor(opts: CommandContextResolverOpts = {}) {
		if (!opts.allowedRepoRoots || opts.allowedRepoRoots.length === 0) {
			this.#allowedRepoRoots = null;
		} else {
			this.#allowedRepoRoots = new Set(opts.allowedRepoRoots.map((path) => resolvePath(path)));
		}
	}

	public resolve(opts: {
		repoRoot: string;
		commandKey: string;
		args: readonly string[];
		inboundTargetType: string;
		inboundTargetId: string;
		metadata: Record<string, unknown>;
	}): ContextResolutionDecision {
		const repoRoot = resolvePath(opts.repoRoot);
		if (this.#allowedRepoRoots && !this.#allowedRepoRoots.has(repoRoot)) {
			return reject("context_unauthorized", `repo_root=${repoRoot}`);
		}

		const args = normalizeTargetlessArgs(opts.args);
		const metadata = opts.metadata ?? {};

		if (ISSUE_TARGET_COMMANDS.has(opts.commandKey)) {
			const explicit = args[0];
			const resolved = resolveFromCandidates({
				explicitValue: explicit,
				conversationCandidates: collectIssueCandidates({
					inboundTargetType: opts.inboundTargetType,
					inboundTargetId: opts.inboundTargetId,
					metadata,
				}),
				validate: (value) => ISSUE_ID_RE.test(value),
				invalidDetails: "issue id must match /^mu-[a-z0-9][a-z0-9-]*$/",
			});
			if (resolved.kind === "reject") {
				return resolved;
			}

			const rest = explicit != null ? args.slice(1) : args;
			const resolvedArgs = [resolved.value, ...rest];
			return {
				kind: "resolved",
				repoRoot,
				commandKey: opts.commandKey,
				args: resolvedArgs,
				normalizedText: [opts.commandKey, ...resolvedArgs].join(" ").trim(),
				targetId: resolved.value,
				source: resolved.source,
			};
		}

		if (TOPIC_TARGET_COMMANDS.has(opts.commandKey)) {
			const explicit = args[0];
			const resolved = resolveFromCandidates({
				explicitValue: explicit,
				conversationCandidates: collectTopicCandidates({
					inboundTargetType: opts.inboundTargetType,
					inboundTargetId: opts.inboundTargetId,
					metadata,
				}),
				validate: (value) => SAFE_TOPIC_RE.test(value),
				invalidDetails: "topic must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/",
			});
			if (resolved.kind === "reject") {
				return resolved;
			}

			const rest = explicit != null ? args.slice(1) : args;
			const resolvedArgs = [resolved.value, ...rest];
			return {
				kind: "resolved",
				repoRoot,
				commandKey: opts.commandKey,
				args: resolvedArgs,
				normalizedText: [opts.commandKey, ...resolvedArgs].join(" ").trim(),
				targetId: resolved.value,
				source: resolved.source,
			};
		}

		if (GENERIC_TARGET_COMMANDS.has(opts.commandKey)) {
			const explicit = args[0];
			if (!explicit) {
				return reject("context_missing");
			}
			if (!SAFE_TARGET_RE.test(explicit)) {
				return reject("cli_validation_failed", "target contains unsafe characters");
			}
			if (args.length > 1) {
				return reject("cli_validation_failed", "unexpected extra target arguments");
			}
			return {
				kind: "resolved",
				repoRoot,
				commandKey: opts.commandKey,
				args: [explicit],
				normalizedText: [opts.commandKey, explicit].join(" "),
				targetId: explicit,
				source: "explicit",
			};
		}

		const normalizedArgs = normalizeTargetlessArgs(args);
		const normalizedText = [opts.commandKey, ...normalizedArgs].join(" ").trim();
		return {
			kind: "resolved",
			repoRoot,
			commandKey: opts.commandKey,
			args: normalizedArgs,
			normalizedText,
			targetId: readString(opts.inboundTargetId) ?? opts.commandKey,
			source: "none",
		};
	}
}
