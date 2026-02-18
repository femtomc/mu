import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildControlPlanePolicy,
	DEFAULT_CONTROL_PLANE_POLICY,
	type IdentityBinding,
	PolicyEngine,
} from "@femtomc/mu-control-plane";

function mkBinding(overrides: Partial<IdentityBinding> = {}): IdentityBinding {
	return {
		binding_id: "binding-1",
		operator_id: "op-1",
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_actor_id: "actor-1",
		assurance_tier: "tier_a",
		scopes: ["cp.read"],
		status: "active",
		linked_at_ms: 1,
		updated_at_ms: 1,
		unlinked_at_ms: null,
		revoked_at_ms: null,
		revoked_by_binding_id: null,
		revoke_reason: null,
		...overrides,
	};
}

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-auth-"));
}

describe("PolicyEngine authorization", () => {
	test("default-deny plus scope/assurance gating", () => {
		const policy = new PolicyEngine(DEFAULT_CONTROL_PLANE_POLICY);

		const allow = policy.authorizeCommand({
			commandKey: "issue close",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.issue.write"], assurance_tier: "tier_a" }),
		});
		expect(allow.kind).toBe("allow");

		const missingScope = policy.authorizeCommand({
			commandKey: "issue close",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.read"], assurance_tier: "tier_a" }),
		});
		expect(missingScope).toMatchObject({ kind: "deny", reason: "missing_scope" });

		const lowAssurance = policy.authorizeCommand({
			commandKey: "issue close",
			requestedMode: "auto",
			binding: mkBinding({
				channel: "telegram",
				assurance_tier: "tier_c",
				scopes: ["cp.issue.write"],
			}),
		});
		expect(lowAssurance).toMatchObject({ kind: "deny", reason: "assurance_tier_too_low" });

		const runAllowed = policy.authorizeCommand({
			commandKey: "run resume",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.run.execute"], assurance_tier: "tier_b", channel: "telegram" }),
		});
		expect(runAllowed.kind).toBe("allow");

		const runMissingScope = policy.authorizeCommand({
			commandKey: "run resume",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.read"], assurance_tier: "tier_b", channel: "telegram" }),
		});
		expect(runMissingScope).toMatchObject({ kind: "deny", reason: "missing_scope" });

		const reloadAllowed = policy.authorizeCommand({
			commandKey: "reload",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.ops.admin"], assurance_tier: "tier_a", channel: "terminal" }),
		});
		expect(reloadAllowed.kind).toBe("allow");

		const reloadMissingScope = policy.authorizeCommand({
			commandKey: "reload",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.read"], assurance_tier: "tier_a", channel: "terminal" }),
		});
		expect(reloadMissingScope).toMatchObject({ kind: "deny", reason: "missing_scope" });

		const reloadLowAssurance = policy.authorizeCommand({
			commandKey: "reload",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.ops.admin"], assurance_tier: "tier_b", channel: "terminal" }),
		});
		expect(reloadLowAssurance).toMatchObject({ kind: "deny", reason: "assurance_tier_too_low" });

		const unmapped = policy.authorizeCommand({
			commandKey: "issue blast",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.issue.write"] }),
		});
		expect(unmapped).toMatchObject({ kind: "deny", reason: "unmapped_command" });
	});

	test("first-platform channel policy is explicit to Slack/Discord/Telegram and rejects unsupported iMessage overrides", () => {
		expect(Object.keys(DEFAULT_CONTROL_PLANE_POLICY.ops.channels).sort()).toEqual(["discord", "slack", "telegram", "terminal"]);

		expect(() =>
			buildControlPlanePolicy({
				ops: {
					channels: {
						...({
							imessage: { mutations_enabled: true },
						} as Record<string, { mutations_enabled: boolean }>),
					},
				},
			}),
		).toThrow();
	});

	test("mutation safety is default-deny for channels outside explicit first-platform mapping", () => {
		const policy = new PolicyEngine(DEFAULT_CONTROL_PLANE_POLICY);
		const decision = policy.evaluateMutationSafety({
			channel: "imessage",
			actorBindingId: "binding-unsupported",
			opsClass: "issue_write",
			nowMs: 10,
		});
		expect(decision).toEqual({ kind: "deny", reason: "mutations_disabled_channel" });
	});

	test("loads policy file overrides and evaluates updated scope requirements", async () => {
		const repo = await mkTempDir();
		const policyPath = join(repo, ".mu", "control-plane", "policy.json");
		await mkdir(join(repo, ".mu", "control-plane"), { recursive: true });
		await writeFile(
			policyPath,
			`${JSON.stringify({
				version: 1,
				default_deny: true,
				commands: {
					"issue close": {
						scopes: ["cp.ops.admin"],
						mutating: true,
						confirmation_required: true,
						min_assurance_tier: "tier_b",
						ops_class: "issue_write",
					},
				},
			})}\n`,
			"utf8",
		);

		const policy = await PolicyEngine.fromFile(policyPath);
		const decision = policy.authorizeCommand({
			commandKey: "issue close",
			requestedMode: "auto",
			binding: mkBinding({ scopes: ["cp.issue.write"], assurance_tier: "tier_a" }),
		});
		expect(decision).toMatchObject({ kind: "deny", reason: "missing_scope" });
	});
});
