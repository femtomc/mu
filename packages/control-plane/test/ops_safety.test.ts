import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildControlPlanePolicy,
	ControlPlaneCommandPipeline,
	type ControlPlanePolicyOverrides,
	ControlPlaneRuntime,
	IdentityStore,
	type InboundEnvelope,
	PolicyEngine,
} from "@femtomc/mu-control-plane";

type Setup = {
	pipeline: ControlPlaneCommandPipeline;
	clock: { now: number };
	mkInbound: (text: string) => InboundEnvelope;
};

const pipelinesToCleanup = new Set<ControlPlaneCommandPipeline>();

afterEach(async () => {
	for (const pipeline of pipelinesToCleanup) {
		await pipeline.stop();
	}
	pipelinesToCleanup.clear();
});

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-ops-"));
}

async function setupPipeline(overrides: ControlPlanePolicyOverrides = {}): Promise<Setup> {
	const repoRoot = await mkTempDir();
	const clock = { now: 10_000 };
	let inboundSeq = 0;
	let commandSeq = 0;

	const runtime = new ControlPlaneRuntime({
		repoRoot,
		ownerId: "ops-runtime",
		nowMs: () => clock.now,
	});
	const identities = new IdentityStore(runtime.paths.identitiesPath);
	const policy = new PolicyEngine(buildControlPlanePolicy(overrides));
	const pipeline = new ControlPlaneCommandPipeline({
		runtime,
		identityStore: identities,
		policyEngine: policy,
		nowMs: () => clock.now,
		commandIdFactory: () => `cmd-ops-${++commandSeq}`,
	});
	await pipeline.start();
	pipelinesToCleanup.add(pipeline);

	await identities.link({
		bindingId: "binding-a",
		operatorId: "operator-a",
		channel: "slack",
		channelTenantId: "tenant-1",
		channelActorId: "actor-a",
		scopes: ["cp.read", "cp.issue.write"],
		nowMs: clock.now,
	});

	const mkInbound = (text: string): InboundEnvelope => {
		inboundSeq += 1;
		return {
			v: 1,
			received_at_ms: clock.now,
			request_id: `req-${inboundSeq}`,
			delivery_id: `delivery-${inboundSeq}`,
			channel: "slack",
			channel_tenant_id: "tenant-1",
			channel_conversation_id: "conv-1",
			actor_id: "actor-a",
			actor_binding_id: "binding-a",
			assurance_tier: "tier_a",
			repo_root: repoRoot,
			command_text: text,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "issue",
			target_id: "mu-1",
			idempotency_key: `idem-${inboundSeq}`,
			fingerprint: `fp-${inboundSeq}`,
			metadata: {},
		};
	};

	return { pipeline, clock, mkInbound };
}

async function submitThenConfirm(
	setup: Setup,
): Promise<Awaited<ReturnType<ControlPlaneCommandPipeline["handleInbound"]>>> {
	const submit = await setup.pipeline.handleInbound(setup.mkInbound("mu! issue close mu-1"));
	expect(submit.kind).toBe("awaiting_confirmation");
	if (submit.kind !== "awaiting_confirmation") {
		throw new Error(`expected awaiting_confirmation, got ${submit.kind}`);
	}
	return await setup.pipeline.handleInbound(setup.mkInbound(`mu! confirm ${submit.command.command_id}`));
}

describe("ops safety gates", () => {
	test("global and per-channel kill-switches deterministically fail confirmed mutations", async () => {
		const globalOff = await setupPipeline({
			ops: {
				mutations_enabled: false,
			},
		});
		const globalDecision = await submitThenConfirm(globalOff);
		expect(globalDecision.kind).toBe("failed");
		if (globalDecision.kind !== "failed") {
			throw new Error(`expected failed, got ${globalDecision.kind}`);
		}
		expect(globalDecision.reason).toBe("mutations_disabled_global");

		const channelOff = await setupPipeline({
			ops: {
				channels: {
					slack: { mutations_enabled: false },
				},
			},
		});
		const channelDecision = await submitThenConfirm(channelOff);
		expect(channelDecision.kind).toBe("failed");
		if (channelDecision.kind !== "failed") {
			throw new Error(`expected failed, got ${channelDecision.kind}`);
		}
		expect(channelDecision.reason).toBe("mutations_disabled_channel");
	});

	test("disabled command class deterministically fails confirmed mutations", async () => {
		const setup = await setupPipeline({
			ops: {
				command_classes: {
					issue_write: {
						mutations_enabled: false,
					},
				},
			},
		});
		const decision = await submitThenConfirm(setup);
		expect(decision.kind).toBe("failed");
		if (decision.kind !== "failed") {
			throw new Error(`expected failed, got ${decision.kind}`);
		}
		expect(decision.reason).toBe("mutations_disabled_class");
	});

	test("rate-limit overflow can deterministically defer", async () => {
		const setup = await setupPipeline({
			ops: {
				rate_limits: {
					window_ms: 1_000,
					actor_limit: 0,
					channel_limit: 0,
					overflow_behavior: "defer",
					defer_ms: 250,
				},
			},
		});
		const decision = await submitThenConfirm(setup);
		expect(decision.kind).toBe("deferred");
		if (decision.kind !== "deferred") {
			throw new Error(`expected deferred, got ${decision.kind}`);
		}
		expect(decision.command.state).toBe("deferred");
		expect(decision.command.retry_at_ms).toBe(setup.clock.now + 250);
		expect(decision.command.error_code).toBe("backpressure_deferred");
	});

	test("rate-limit overflow can deterministically fail", async () => {
		const setup = await setupPipeline({
			ops: {
				rate_limits: {
					window_ms: 1_000,
					actor_limit: 0,
					channel_limit: 0,
					overflow_behavior: "fail",
					defer_ms: 0,
				},
			},
		});
		const decision = await submitThenConfirm(setup);
		expect(decision.kind).toBe("failed");
		if (decision.kind !== "failed") {
			throw new Error(`expected failed, got ${decision.kind}`);
		}
		expect(decision.reason).toBe("backpressure_overflow");
		expect(decision.command.error_code).toBe("backpressure_overflow");
	});
});
