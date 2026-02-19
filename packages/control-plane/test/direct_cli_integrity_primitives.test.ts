import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildControlPlanePolicy,
	CommandJournal,
	ControlPlaneCommandPipeline,
	ControlPlaneRuntime,
	createAcceptedCommandRecord,
	IdentityStore,
	type InboundEnvelope,
	type MuCliInvocationPlan,
	PolicyEngine,
	transitionCommandRecord,
	WriterLockBusyError,
} from "@femtomc/mu-control-plane";
import { readJsonl } from "@femtomc/mu-core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-direct-cli-integrity-"));
}

function mkInbound(repoRoot: string, overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 100,
		request_id: "req-1",
		delivery_id: "delivery-1",
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_conversation_id: "conv-1",
		actor_id: "actor-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: repoRoot,
		command_text: "/mu status",
		scope_required: "cp.read",
		scope_effective: "cp.read",
		target_type: "status",
		target_id: "status",
		idempotency_key: "idem-1",
		fingerprint: "fp-1",
		metadata: {},
		...overrides,
	};
}

describe("direct CLI integrity primitives", () => {
	test("serialized mutation execution is transactional and writer-lock guarded", async () => {
		const repoRoot = await mkTempDir();
		const runtime = new ControlPlaneRuntime({
			repoRoot,
			ownerId: "tx-owner-1",
			nowMs: () => 100,
		});

		await runtime.start();
		try {
			const competingRuntime = new ControlPlaneRuntime({
				repoRoot,
				ownerId: "tx-owner-2",
				nowMs: () => 101,
			});
			await expect(competingRuntime.start()).rejects.toBeInstanceOf(WriterLockBusyError);

			let active = 0;
			let maxActive = 0;
			const order: string[] = [];

			const results = await Promise.all(
				Array.from({ length: 4 }, (_, idx) =>
					runtime.executeSerializedMutation(async () => {
						active += 1;
						maxActive = Math.max(maxActive, active);
						order.push(`start-${idx}`);
						await Bun.sleep(2);
						order.push(`end-${idx}`);
						active -= 1;
						return idx;
					}),
				),
			);

			expect(results).toEqual([0, 1, 2, 3]);
			expect(maxActive).toBe(1);
			expect(order).toEqual([
				"start-0",
				"end-0",
				"start-1",
				"end-1",
				"start-2",
				"end-2",
				"start-3",
				"end-3",
			]);
		} finally {
			await runtime.stop();
		}
	});

	test("command journal stays append-only for lifecycle + mutating audit trails", async () => {
		const repoRoot = await mkTempDir();
		const journalPath = join(repoRoot, ".mu", "control-plane", "commands.jsonl");
		const journal = new CommandJournal(journalPath);
		await journal.load();

		let record = createAcceptedCommandRecord({
			commandId: "cmd-audit-1",
			inbound: mkInbound(repoRoot, {
				idempotency_key: "idem-audit-1",
				fingerprint: "fp-audit-1",
			}),
			nowMs: 10,
		});
		await journal.appendLifecycle(record);
		record = transitionCommandRecord(record, { nextState: "queued", nowMs: 20 });
		await journal.appendLifecycle(record);

		const before = (await readJsonl(journalPath)) as Array<Record<string, unknown>>;

		record = transitionCommandRecord(record, { nextState: "in_progress", nowMs: 30 });
		await journal.appendLifecycle(record);
		await journal.appendMutatingDomainEvent({
			eventType: "cli.invocation.completed",
			command: record,
			state: "in_progress",
			payload: { exit_code: 0 },
		});
		record = transitionCommandRecord(record, {
			nextState: "completed",
			nowMs: 40,
			result: { ok: true },
			errorCode: null,
		});
		await journal.appendLifecycle(record);

		const after = (await readJsonl(journalPath)) as Array<Record<string, unknown>>;

		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.length).toBe(before.length + 3);
		expect(after.map((entry) => entry.kind)).toEqual([
			"command.lifecycle",
			"command.lifecycle",
			"command.lifecycle",
			"domain.mutating",
			"command.lifecycle",
		]);
	});

	test("idempotency guards prevent duplicate/conflicting direct-CLI execution", async () => {
		const repoRoot = await mkTempDir();
		let commandSeq = 0;
		let cliSeq = 0;
		const cliPlans: MuCliInvocationPlan[] = [];

		const runtime = new ControlPlaneRuntime({
			repoRoot,
			ownerId: "idem-owner",
			nowMs: () => 100,
		});
		const identities = new IdentityStore(runtime.paths.identitiesPath);
		const policy = new PolicyEngine(buildControlPlanePolicy());
		const pipeline = new ControlPlaneCommandPipeline({
			runtime,
			identityStore: identities,
			policyEngine: policy,
			commandIdFactory: () => `cmd-idem-${++commandSeq}`,
			cliInvocationIdFactory: () => `cli-idem-${++cliSeq}`,
			cliRunner: {
				run: async ({ plan }) => {
					cliPlans.push(plan);
					return {
						kind: "completed",
						stdout: '{"status":"ok"}',
						stderr: "",
						exitCode: 0,
						runRootId: null,
					};
				},
			},
		});

		await pipeline.start();
		try {
			await identities.link({
				bindingId: "binding-1",
				operatorId: "operator-1",
				channel: "slack",
				channelTenantId: "tenant-1",
				channelActorId: "actor-1",
				scopes: ["cp.read", "cp.run.execute"],
				nowMs: 100,
			});

			const first = await pipeline.handleInbound(
				mkInbound(repoRoot, {
					command_text: "/mu run resume mu-root-idem",
				}),
			);
			expect(first.kind).toBe("awaiting_confirmation");
			if (first.kind !== "awaiting_confirmation") {
				throw new Error(`expected awaiting_confirmation, got ${first.kind}`);
			}

			const duplicate = await pipeline.handleInbound(
				mkInbound(repoRoot, {
					request_id: "req-2",
					delivery_id: "delivery-2",
					received_at_ms: 101,
					command_text: "/mu run resume mu-root-idem",
				}),
			);
			expect(duplicate.kind).toBe("awaiting_confirmation");
			if (duplicate.kind !== "awaiting_confirmation") {
				throw new Error(`expected awaiting_confirmation, got ${duplicate.kind}`);
			}
			expect(duplicate.command.command_id).toBe(first.command.command_id);
			expect(cliPlans).toHaveLength(0);

			const confirmed = await pipeline.handleInbound(
				mkInbound(repoRoot, {
					request_id: "req-confirm",
					delivery_id: "delivery-confirm",
					received_at_ms: 102,
					idempotency_key: "idem-confirm-1",
					fingerprint: "fp-confirm-1",
					command_text: `mu! confirm ${first.command.command_id}`,
				}),
			);
			expect(confirmed.kind).toBe("completed");
			if (confirmed.kind !== "completed") {
				throw new Error(`expected completed, got ${confirmed.kind}`);
			}
			expect(cliPlans).toHaveLength(1);
			expect(cliPlans[0]?.commandKind).toBe("run_resume");

			const conflict = await pipeline.handleInbound(
				mkInbound(repoRoot, {
					request_id: "req-3",
					delivery_id: "delivery-3",
					received_at_ms: 103,
					command_text: "/mu run list",
				}),
			);
			expect(conflict).toEqual({ kind: "denied", reason: "idempotency_conflict" });
			expect(cliPlans).toHaveLength(1);
		} finally {
			await pipeline.stop();
		}
	});
});
