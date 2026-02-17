import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildControlPlanePolicy,
	ControlPlaneCommandPipeline,
	ControlPlaneRuntime,
	IdentityStore,
	type InboundEnvelope,
	PolicyEngine,
} from "@femtomc/mu-control-plane";
import { readJsonl } from "@femtomc/mu-core/node";

type Setup = {
	pipeline: ControlPlaneCommandPipeline;
	runtime: ControlPlaneRuntime;
	clock: { now: number };
	mkInbound: (opts: { actorId: string; bindingId: string; text: string; targetId?: string }) => InboundEnvelope;
};

const pipelinesToCleanup = new Set<ControlPlaneCommandPipeline>();

afterEach(async () => {
	for (const pipeline of pipelinesToCleanup) {
		await pipeline.stop();
	}
	pipelinesToCleanup.clear();
});

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-confirm-"));
}

async function setupPipeline(opts: { confirmationTtlMs?: number } = {}): Promise<Setup> {
	const repoRoot = await mkTempDir();
	const clock = { now: 1_000 };
	let inboundSeq = 0;
	let commandSeq = 0;

	const runtime = new ControlPlaneRuntime({
		repoRoot,
		ownerId: "test-runtime",
		nowMs: () => clock.now,
	});
	const identities = new IdentityStore(runtime.paths.identitiesPath);
	const policy = new PolicyEngine(buildControlPlanePolicy());
	const pipeline = new ControlPlaneCommandPipeline({
		runtime,
		identityStore: identities,
		policyEngine: policy,
		confirmationTtlMs: opts.confirmationTtlMs ?? 200,
		nowMs: () => clock.now,
		commandIdFactory: () => `cmd-${++commandSeq}`,
	});
	await pipeline.start();
	pipelinesToCleanup.add(pipeline);

	await identities.link({
		bindingId: "binding-a",
		operatorId: "operator-a",
		channel: "slack",
		channelTenantId: "tenant-1",
		channelActorId: "actor-a",
		scopes: ["cp.read", "cp.issue.write", "cp.forum.write"],
		nowMs: clock.now,
	});
	await identities.link({
		bindingId: "binding-b",
		operatorId: "operator-b",
		channel: "slack",
		channelTenantId: "tenant-1",
		channelActorId: "actor-b",
		scopes: ["cp.read", "cp.issue.write"],
		nowMs: clock.now,
	});

	const mkInbound = (opts2: {
		actorId: string;
		bindingId: string;
		text: string;
		targetId?: string;
	}): InboundEnvelope => {
		inboundSeq += 1;
		return {
			v: 1,
			received_at_ms: clock.now,
			request_id: `req-${inboundSeq}`,
			delivery_id: `delivery-${inboundSeq}`,
			channel: "slack",
			channel_tenant_id: "tenant-1",
			channel_conversation_id: "conv-1",
			actor_id: opts2.actorId,
			actor_binding_id: opts2.bindingId,
			assurance_tier: "tier_a",
			repo_root: repoRoot,
			command_text: opts2.text,
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "issue",
			target_id: opts2.targetId ?? "target-1",
			idempotency_key: `idem-${inboundSeq}`,
			fingerprint: `fp-${inboundSeq}`,
			metadata: {},
		};
	};

	return { pipeline, runtime, clock, mkInbound };
}

function expectLifecycleStates(rows: Record<string, unknown>[], commandId: string): string[] {
	return rows
		.filter((row) => row.kind === "command.lifecycle")
		.filter((row) => (row.command as Record<string, unknown>).command_id === commandId)
		.map((row) => ((row.command as Record<string, unknown>).state as string) ?? "");
}

describe("mutation confirmation lifecycle", () => {
	test("confirm succeeds and reaches completed", async () => {
		const { pipeline, runtime, mkInbound } = await setupPipeline();

		const submit = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-a",
				bindingId: "binding-a",
				text: "mu! issue close mu-123",
				targetId: "mu-123",
			}),
		);
		expect(submit.kind).toBe("awaiting_confirmation");
		if (submit.kind !== "awaiting_confirmation") {
			throw new Error("expected awaiting_confirmation");
		}

		const confirm = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-a",
				bindingId: "binding-a",
				text: `mu! confirm ${submit.command.command_id}`,
			}),
		);
		expect(confirm.kind).toBe("completed");
		if (confirm.kind !== "completed") {
			throw new Error(`expected completed, got ${confirm.kind}`);
		}
		expect(confirm.command.state).toBe("completed");

		const rows = (await readJsonl(runtime.paths.commandsPath)) as Record<string, unknown>[];
		expect(expectLifecycleStates(rows, submit.command.command_id)).toEqual([
			"accepted",
			"awaiting_confirmation",
			"queued",
			"in_progress",
			"completed",
		]);
	});

	test("cancel transitions awaiting confirmation to cancelled", async () => {
		const { pipeline, mkInbound } = await setupPipeline();

		const submit = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-a",
				bindingId: "binding-a",
				text: "mu! forum post hello",
			}),
		);
		expect(submit.kind).toBe("awaiting_confirmation");
		if (submit.kind !== "awaiting_confirmation") {
			throw new Error("expected awaiting_confirmation");
		}

		const cancel = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-a",
				bindingId: "binding-a",
				text: `mu! cancel ${submit.command.command_id}`,
			}),
		);
		expect(cancel.kind).toBe("cancelled");
		if (cancel.kind !== "cancelled") {
			throw new Error(`expected cancelled, got ${cancel.kind}`);
		}
		expect(cancel.command.state).toBe("cancelled");
	});

	test("confirm after timeout expires pending command", async () => {
		const { pipeline, clock, mkInbound } = await setupPipeline({ confirmationTtlMs: 30 });

		const submit = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-a",
				bindingId: "binding-a",
				text: "mu! issue close mu-9",
				targetId: "mu-9",
			}),
		);
		expect(submit.kind).toBe("awaiting_confirmation");
		if (submit.kind !== "awaiting_confirmation") {
			throw new Error("expected awaiting_confirmation");
		}

		clock.now += 50;
		const confirm = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-a",
				bindingId: "binding-a",
				text: `mu! confirm ${submit.command.command_id}`,
			}),
		);
		expect(confirm.kind).toBe("expired");
		if (confirm.kind !== "expired") {
			throw new Error(`expected expired, got ${confirm.kind}`);
		}
		expect(confirm.command.state).toBe("expired");
	});

	test("invalid actor cannot confirm someone else's pending mutation", async () => {
		const { pipeline, runtime, mkInbound } = await setupPipeline();

		const submit = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-a",
				bindingId: "binding-a",
				text: "mu! issue close mu-777",
				targetId: "mu-777",
			}),
		);
		expect(submit.kind).toBe("awaiting_confirmation");
		if (submit.kind !== "awaiting_confirmation") {
			throw new Error("expected awaiting_confirmation");
		}

		const invalidConfirm = await pipeline.handleInbound(
			mkInbound({
				actorId: "actor-b",
				bindingId: "binding-b",
				text: `mu! confirm ${submit.command.command_id}`,
			}),
		);
		expect(invalidConfirm).toEqual({ kind: "denied", reason: "confirmation_invalid_actor" });

		const persisted = runtime.journal.get(submit.command.command_id);
		expect(persisted?.state).toBe("awaiting_confirmation");
	});
});
