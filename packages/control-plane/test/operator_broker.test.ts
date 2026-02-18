import { describe, expect, test } from "bun:test";
import { ApprovedCommandBroker, CommandContextResolver } from "@femtomc/mu-agent";
import type { InboundEnvelope } from "@femtomc/mu-control-plane";

function mkInbound(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 1,
		request_id: "req-1",
		delivery_id: "delivery-1",
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_conversation_id: "conv-1",
		actor_id: "actor-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: "/repo",
		command_text: "please do the thing",
		scope_required: "cp.read",
		scope_effective: "cp.read",
		target_type: "issue",
		target_id: "mu-abcd1234",
		idempotency_key: "idem-1",
		fingerprint: "fp-1",
		metadata: {},
		...overrides,
	};
}

describe("ApprovedCommandBroker", () => {
	test("enforces allowlist and argument sanitization", () => {
		const broker = new ApprovedCommandBroker({
			contextResolver: new CommandContextResolver({ allowedRepoRoots: ["/repo"] }),
		});

		const ok = broker.approve({
			proposal: { kind: "run_resume", root_issue_id: "mu-abc12345", max_steps: 25 },
			inbound: mkInbound(),
		});
		expect(ok).toEqual({ kind: "approved", commandText: "/mu run resume mu-abc12345 25" });

		const list = broker.approve({
			proposal: { kind: "issue_list" },
			inbound: mkInbound(),
		});
		expect(list).toEqual({ kind: "approved", commandText: "/mu issue list" });

		const runList = broker.approve({
			proposal: { kind: "run_list" },
			inbound: mkInbound(),
		});
		expect(runList).toEqual({ kind: "approved", commandText: "/mu run list" });

		const runStatus = broker.approve({
			proposal: { kind: "run_status", root_issue_id: "mu-root1234" },
			inbound: mkInbound(),
		});
		expect(runStatus).toEqual({ kind: "approved", commandText: "/mu run status mu-root1234" });

		const runInterrupt = broker.approve({
			proposal: { kind: "run_interrupt", root_issue_id: "mu-root1234" },
			inbound: mkInbound(),
		});
		expect(runInterrupt).toEqual({ kind: "approved", commandText: "/mu run interrupt mu-root1234" });

		const reload = broker.approve({
			proposal: { kind: "reload" },
			inbound: mkInbound(),
		});
		expect(reload).toEqual({ kind: "approved", commandText: "/mu reload" });

		const update = broker.approve({
			proposal: { kind: "update" },
			inbound: mkInbound(),
		});
		expect(update).toEqual({ kind: "approved", commandText: "/mu update" });

		const invalidArg = broker.approve({
			proposal: { kind: "run_resume", root_issue_id: "mu-abc12345 --raw-stream" },
			inbound: mkInbound(),
		});
		expect(invalidArg).toMatchObject({ kind: "reject", reason: "cli_validation_failed" });

		const disallowed = broker.approve({
			proposal: { kind: "rm_rf" } as unknown as { kind: "status" },
			inbound: mkInbound(),
		});
		expect(disallowed).toMatchObject({ kind: "reject", reason: "operator_action_disallowed" });
	});

	test("deterministically resolves context and rejects missing/ambiguous/unauthorized requests", () => {
		const broker = new ApprovedCommandBroker({
			contextResolver: new CommandContextResolver({ allowedRepoRoots: ["/repo"] }),
		});

		const fromConversation = broker.approve({
			proposal: { kind: "issue_get" },
			inbound: mkInbound({ target_type: "issue", target_id: "mu-cafe9999" }),
		});
		expect(fromConversation).toEqual({ kind: "approved", commandText: "/mu issue get mu-cafe9999" });

		const missing = broker.approve({
			proposal: { kind: "issue_get" },
			inbound: mkInbound({ target_type: "status", target_id: "none", metadata: {} }),
		});
		expect(missing).toMatchObject({ kind: "reject", reason: "context_missing" });

		const ambiguous = broker.approve({
			proposal: { kind: "run_resume" },
			inbound: mkInbound({
				target_type: "issue",
				target_id: "mu-a1111111",
				metadata: { issue_id: "mu-b2222222" },
			}),
		});
		expect(ambiguous).toMatchObject({ kind: "reject", reason: "context_ambiguous" });

		const unauthorizedRepo = broker.approve({
			proposal: { kind: "issue_get", issue_id: "mu-ffff0000" },
			inbound: mkInbound({ repo_root: "/other-repo" }),
		});
		expect(unauthorizedRepo).toMatchObject({ kind: "reject", reason: "context_unauthorized" });
	});

	test("can hard-disable run triggers", () => {
		const broker = new ApprovedCommandBroker({
			runTriggersEnabled: false,
			contextResolver: new CommandContextResolver({ allowedRepoRoots: ["/repo"] }),
		});
		const decision = broker.approve({
			proposal: { kind: "run_resume", root_issue_id: "mu-abc99999" },
			inbound: mkInbound(),
		});
		expect(decision).toMatchObject({ kind: "reject", reason: "operator_action_disallowed" });
	});
});
