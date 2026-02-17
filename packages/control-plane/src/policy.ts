import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type Channel, ChannelSchema, type IdentityBinding } from "./identity_store.js";
import { type AssuranceTier, AssuranceTierSchema } from "./models.js";

const TIER_RANK = {
	tier_a: 3,
	tier_b: 2,
	tier_c: 1,
} as const satisfies Record<AssuranceTier, number>;

function assuranceAtLeast(actual: AssuranceTier, required: AssuranceTier): boolean {
	return TIER_RANK[actual] >= TIER_RANK[required];
}

export const CommandPolicyRuleSchema = z.object({
	scopes: z.array(z.string().min(1)).min(1),
	mutating: z.boolean(),
	confirmation_required: z.boolean().default(false),
	min_assurance_tier: AssuranceTierSchema.default("tier_c"),
	ops_class: z.string().min(1).default("default"),
});
export type CommandPolicyRule = z.infer<typeof CommandPolicyRuleSchema>;

export const CommandClassPolicySchema = z.object({
	mutations_enabled: z.boolean().default(true),
});
export type CommandClassPolicy = z.infer<typeof CommandClassPolicySchema>;

export const ChannelSafetyPolicySchema = z.object({
	mutations_enabled: z.boolean().default(true),
});
export type ChannelSafetyPolicy = z.infer<typeof ChannelSafetyPolicySchema>;

export const RateLimitPolicySchema = z.object({
	window_ms: z.number().int().positive().default(60_000),
	actor_limit: z.number().int().nonnegative().default(30),
	channel_limit: z.number().int().nonnegative().default(120),
	overflow_behavior: z.enum(["defer", "fail"]).default("defer"),
	defer_ms: z.number().int().nonnegative().default(5_000),
});
export type RateLimitPolicy = z.infer<typeof RateLimitPolicySchema>;

export const OpsSafetyPolicySchema = z.object({
	mutations_enabled: z.boolean().default(true),
	channels: z.partialRecord(ChannelSchema, ChannelSafetyPolicySchema).default({}),
	command_classes: z.record(z.string(), CommandClassPolicySchema).default({}),
	rate_limits: RateLimitPolicySchema.default(() => ({
		window_ms: 60_000,
		actor_limit: 30,
		channel_limit: 120,
		overflow_behavior: "defer" as const,
		defer_ms: 5_000,
	})),
});
export type OpsSafetyPolicy = z.infer<typeof OpsSafetyPolicySchema>;

export const ControlPlanePolicySchema = z.object({
	version: z.literal(1).default(1),
	default_deny: z.literal(true).default(true),
	commands: z.record(z.string(), CommandPolicyRuleSchema),
	ops: OpsSafetyPolicySchema.default(() => ({
		mutations_enabled: true,
		channels: {},
		command_classes: {},
		rate_limits: {
			window_ms: 60_000,
			actor_limit: 30,
			channel_limit: 120,
			overflow_behavior: "defer" as const,
			defer_ms: 5_000,
		},
	})),
});
export type ControlPlanePolicy = z.infer<typeof ControlPlanePolicySchema>;

export const ControlPlanePolicyOverridesSchema = z.object({
	version: z.literal(1).optional(),
	default_deny: z.literal(true).optional(),
	commands: z.record(z.string(), CommandPolicyRuleSchema.partial()).optional(),
	ops: z
		.object({
			mutations_enabled: z.boolean().optional(),
			channels: z.partialRecord(ChannelSchema, ChannelSafetyPolicySchema.partial()).optional(),
			command_classes: z.record(z.string(), CommandClassPolicySchema.partial()).optional(),
			rate_limits: RateLimitPolicySchema.partial().optional(),
		})
		.optional(),
});
export type ControlPlanePolicyOverrides = z.infer<typeof ControlPlanePolicyOverridesSchema>;

const DEFAULT_COMMANDS: Record<string, CommandPolicyRule> = {
	status: {
		scopes: ["cp.read"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_c",
		ops_class: "read",
	},
	ready: {
		scopes: ["cp.read"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_c",
		ops_class: "read",
	},
	"issue get": {
		scopes: ["cp.read"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_c",
		ops_class: "read",
	},
	"issue list": {
		scopes: ["cp.read"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_c",
		ops_class: "read",
	},
	"forum read": {
		scopes: ["cp.read"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_c",
		ops_class: "read",
	},
	"audit get": {
		scopes: ["cp.read"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_c",
		ops_class: "read",
	},
	"issue create": {
		scopes: ["cp.issue.write"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "issue_write",
	},
	"issue update": {
		scopes: ["cp.issue.write"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "issue_write",
	},
	"issue claim": {
		scopes: ["cp.issue.write"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "issue_write",
	},
	"issue close": {
		scopes: ["cp.issue.write"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "issue_write",
	},
	"issue dep add": {
		scopes: ["cp.issue.write"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "issue_write",
	},
	"issue dep remove": {
		scopes: ["cp.issue.write"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "issue_write",
	},
	"forum post": {
		scopes: ["cp.forum.write"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "forum_write",
	},
	"run start": {
		scopes: ["cp.run.execute"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "run_execute",
	},
	"run resume": {
		scopes: ["cp.run.execute"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "run_execute",
	},
	"link begin": {
		scopes: ["cp.identity.self"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "identity_write",
	},
	"link finish": {
		scopes: ["cp.identity.self"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "identity_write",
	},
	"unlink self": {
		scopes: ["cp.identity.self"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "identity_write",
	},
	revoke: {
		scopes: ["cp.identity.admin"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "identity_admin",
	},
	"grant scope": {
		scopes: ["cp.identity.admin"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "identity_admin",
	},
	"policy update": {
		scopes: ["cp.identity.admin"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "identity_admin",
	},
	"kill-switch set": {
		scopes: ["cp.ops.admin"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "ops_admin",
	},
	"dlq list": {
		scopes: ["cp.ops.admin"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_b",
		ops_class: "ops_admin",
	},
	"dlq inspect": {
		scopes: ["cp.ops.admin"],
		mutating: false,
		confirmation_required: false,
		min_assurance_tier: "tier_b",
		ops_class: "ops_admin",
	},
	"dlq replay": {
		scopes: ["cp.ops.admin"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "ops_admin",
	},
	"rate-limit override": {
		scopes: ["cp.ops.admin"],
		mutating: true,
		confirmation_required: true,
		min_assurance_tier: "tier_b",
		ops_class: "ops_admin",
	},
};

export const DEFAULT_CONTROL_PLANE_POLICY: ControlPlanePolicy = ControlPlanePolicySchema.parse({
	version: 1,
	default_deny: true,
	commands: DEFAULT_COMMANDS,
	ops: {
		mutations_enabled: true,
		channels: {
			slack: { mutations_enabled: true },
			discord: { mutations_enabled: true },
			telegram: { mutations_enabled: true },
		},
		command_classes: {
			issue_write: { mutations_enabled: true },
			forum_write: { mutations_enabled: true },
			run_execute: { mutations_enabled: true },
			identity_write: { mutations_enabled: true },
			identity_admin: { mutations_enabled: true },
			ops_admin: { mutations_enabled: true },
		},
		rate_limits: {
			window_ms: 60_000,
			actor_limit: 30,
			channel_limit: 120,
			overflow_behavior: "defer",
			defer_ms: 5_000,
		},
	},
});

function mergeRules(
	base: Record<string, CommandPolicyRule>,
	overrides: Record<string, Partial<CommandPolicyRule>>,
): Record<string, CommandPolicyRule> {
	const merged: Record<string, CommandPolicyRule> = {};
	for (const [commandKey, baseRule] of Object.entries(base)) {
		merged[commandKey] = CommandPolicyRuleSchema.parse(baseRule);
	}
	for (const [commandKey, partialRule] of Object.entries(overrides)) {
		const combined = {
			...(merged[commandKey] ?? {}),
			...partialRule,
		};
		merged[commandKey] = CommandPolicyRuleSchema.parse(combined);
	}
	return merged;
}

export function buildControlPlanePolicy(overrides: ControlPlanePolicyOverrides = {}): ControlPlanePolicy {
	const parsed = ControlPlanePolicyOverridesSchema.parse(overrides);
	const merged = {
		version: 1,
		default_deny: true as const,
		commands: mergeRules(DEFAULT_CONTROL_PLANE_POLICY.commands, parsed.commands ?? {}),
		ops: {
			...DEFAULT_CONTROL_PLANE_POLICY.ops,
			...parsed.ops,
			channels: {
				...DEFAULT_CONTROL_PLANE_POLICY.ops.channels,
				...(parsed.ops?.channels ?? {}),
			},
			command_classes: {
				...DEFAULT_CONTROL_PLANE_POLICY.ops.command_classes,
				...(parsed.ops?.command_classes ?? {}),
			},
			rate_limits: {
				...DEFAULT_CONTROL_PLANE_POLICY.ops.rate_limits,
				...(parsed.ops?.rate_limits ?? {}),
			},
		},
	};
	return ControlPlanePolicySchema.parse(merged);
}

export async function loadControlPlanePolicy(path: string): Promise<ControlPlanePolicy> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return DEFAULT_CONTROL_PLANE_POLICY;
		}
		throw err;
	}

	const parsedJson = JSON.parse(raw) as unknown;
	const overrides = ControlPlanePolicyOverridesSchema.parse(parsedJson);
	return buildControlPlanePolicy(overrides);
}

export type AuthorizationDenyReason =
	| "unmapped_command"
	| "missing_scope"
	| "assurance_tier_too_low"
	| "readonly_mode_disallows_mutation"
	| "mutation_mode_requires_mutating_command";

export type AuthorizationDecision =
	| { kind: "allow"; rule: CommandPolicyRule; effectiveScope: string }
	| { kind: "deny"; reason: AuthorizationDenyReason; missingScopes?: readonly string[] };

export type RequestedCommandMode = "auto" | "mutation" | "readonly";

export type OpsSafetyDecision =
	| { kind: "allow" }
	| {
			kind: "deny";
			reason:
				| "mutations_disabled_global"
				| "mutations_disabled_channel"
				| "mutations_disabled_class"
				| "backpressure_overflow";
	  }
	| { kind: "defer"; reason: "backpressure_deferred"; retryAtMs: number };

export class PolicyEngine {
	#policy: ControlPlanePolicy;
	readonly #actorCounters = new Map<string, number>();
	readonly #channelCounters = new Map<string, number>();

	public constructor(policy: ControlPlanePolicy = DEFAULT_CONTROL_PLANE_POLICY) {
		this.#policy = ControlPlanePolicySchema.parse(policy);
	}

	public static async fromFile(path: string): Promise<PolicyEngine> {
		return new PolicyEngine(await loadControlPlanePolicy(path));
	}

	public get policy(): ControlPlanePolicy {
		return this.#policy;
	}

	public setPolicy(policy: ControlPlanePolicy): void {
		this.#policy = ControlPlanePolicySchema.parse(policy);
		this.resetRateLimitState();
	}

	public async reloadFromFile(path: string): Promise<void> {
		this.setPolicy(await loadControlPlanePolicy(path));
	}

	public ruleForCommand(commandKey: string): CommandPolicyRule | null {
		const rule = this.#policy.commands[commandKey];
		return rule ? CommandPolicyRuleSchema.parse(rule) : null;
	}

	public authorizeCommand(opts: {
		commandKey: string;
		binding: Pick<IdentityBinding, "channel" | "assurance_tier" | "scopes">;
		requestedMode: RequestedCommandMode;
	}): AuthorizationDecision {
		const rule = this.ruleForCommand(opts.commandKey);
		if (!rule) {
			return { kind: "deny", reason: "unmapped_command" };
		}

		if (opts.requestedMode === "readonly" && rule.mutating) {
			return { kind: "deny", reason: "readonly_mode_disallows_mutation" };
		}
		if (opts.requestedMode === "mutation" && !rule.mutating) {
			return { kind: "deny", reason: "mutation_mode_requires_mutating_command" };
		}

		const missingScopes = rule.scopes.filter((scope) => !opts.binding.scopes.includes(scope));
		if (missingScopes.length > 0) {
			return { kind: "deny", reason: "missing_scope", missingScopes };
		}

		if (!assuranceAtLeast(opts.binding.assurance_tier, rule.min_assurance_tier)) {
			return { kind: "deny", reason: "assurance_tier_too_low" };
		}

		return {
			kind: "allow",
			rule,
			effectiveScope: rule.scopes[0]!,
		};
	}

	public evaluateMutationSafety(opts: {
		channel: string;
		actorBindingId: string;
		opsClass: string;
		nowMs?: number;
	}): OpsSafetyDecision {
		if (!this.#policy.ops.mutations_enabled) {
			return { kind: "deny", reason: "mutations_disabled_global" };
		}

		const channel = ChannelSchema.safeParse(opts.channel);
		if (!channel.success) {
			return { kind: "deny", reason: "mutations_disabled_channel" };
		}

		const channelPolicy = this.#policy.ops.channels[channel.data];
		if (!channelPolicy || !channelPolicy.mutations_enabled) {
			return { kind: "deny", reason: "mutations_disabled_channel" };
		}

		const classPolicy = this.#policy.ops.command_classes[opts.opsClass];
		if (classPolicy && !classPolicy.mutations_enabled) {
			return { kind: "deny", reason: "mutations_disabled_class" };
		}

		const rate = this.#policy.ops.rate_limits;
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const windowStartMs = nowMs - (nowMs % rate.window_ms);
		const actorKey = `${opts.actorBindingId}:${windowStartMs}`;
		const channelKey = `${channel.data}:${windowStartMs}`;

		const actorCount = this.#actorCounters.get(actorKey) ?? 0;
		const channelCount = this.#channelCounters.get(channelKey) ?? 0;
		if (actorCount >= rate.actor_limit || channelCount >= rate.channel_limit) {
			if (rate.overflow_behavior === "defer") {
				return {
					kind: "defer",
					reason: "backpressure_deferred",
					retryAtMs: nowMs + rate.defer_ms,
				};
			}
			return { kind: "deny", reason: "backpressure_overflow" };
		}

		this.#actorCounters.set(actorKey, actorCount + 1);
		this.#channelCounters.set(channelKey, channelCount + 1);
		return { kind: "allow" };
	}

	public resetRateLimitState(): void {
		this.#actorCounters.clear();
		this.#channelCounters.clear();
	}
}

export function channelFromString(value: string): Channel | null {
	const parsed = ChannelSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
