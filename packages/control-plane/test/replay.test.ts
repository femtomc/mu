import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ControlPlaneRuntime,
	createAcceptedCommandRecord,
	type InboundEnvelope,
	transitionCommandRecord,
} from "@femtomc/mu-control-plane";
import { readJsonl } from "@femtomc/mu-core/node";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-replay-"));
}

function mkInbound(commandId: string, overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
	return {
		v: 1,
		received_at_ms: 100,
		request_id: `req-${commandId}`,
		delivery_id: `delivery-${commandId}`,
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_conversation_id: "conv-1",
		actor_id: "actor-1",
		actor_binding_id: "binding-1",
		assurance_tier: "tier_a",
		repo_root: "/repo",
		command_text: "issue close mu-123",
		scope_required: "cp.issue.write",
		scope_effective: "cp.issue.write",
		target_type: "issue",
		target_id: commandId,
		idempotency_key: `idem-${commandId}`,
		fingerprint: `fingerprint-${commandId}`,
		metadata: {},
		...overrides,
	};
}

function expectCorrelationFields(correlation: Record<string, unknown>): void {
	const required = [
		"command_id",
		"idempotency_key",
		"request_id",
		"channel",
		"channel_tenant_id",
		"channel_conversation_id",
		"actor_id",
		"actor_binding_id",
		"assurance_tier",
		"repo_root",
		"scope_required",
		"scope_effective",
		"target_type",
		"target_id",
		"attempt",
		"state",
		"error_code",
		"operator_session_id",
		"operator_turn_id",
		"cli_invocation_id",
		"cli_command_kind",
		"run_root_id",
	];
	for (const key of required) {
		expect(key in correlation).toBe(true);
	}
}

describe("ControlPlaneRuntime startup replay", () => {
	test("reconstructs deterministically and avoids duplicate side effects", async () => {
		const repoRoot = await mkTempDir();

		const seedRuntime = new ControlPlaneRuntime({ repoRoot, ownerId: "seed", nowMs: () => 100 });
		await seedRuntime.start();

		let cmdA = createAcceptedCommandRecord({ commandId: "cmd-a", inbound: mkInbound("cmd-a"), nowMs: 10 });
		await seedRuntime.journal.appendLifecycle(cmdA);
		cmdA = transitionCommandRecord(cmdA, { nextState: "queued", nowMs: 20 });
		await seedRuntime.journal.appendLifecycle(cmdA);
		cmdA = transitionCommandRecord(cmdA, { nextState: "in_progress", nowMs: 30 });
		await seedRuntime.journal.appendLifecycle(cmdA);
		await seedRuntime.journal.appendMutatingDomainEvent({
			eventType: "issue.close",
			command: cmdA,
			payload: { issue_id: "mu-a", outcome: "success" },
			state: "in_progress",
		});

		let cmdB = createAcceptedCommandRecord({ commandId: "cmd-b", inbound: mkInbound("cmd-b"), nowMs: 40 });
		await seedRuntime.journal.appendLifecycle(cmdB);
		cmdB = transitionCommandRecord(cmdB, { nextState: "queued", nowMs: 50 });
		await seedRuntime.journal.appendLifecycle(cmdB);

		let cmdC = createAcceptedCommandRecord({ commandId: "cmd-c", inbound: mkInbound("cmd-c"), nowMs: 60 });
		await seedRuntime.journal.appendLifecycle(cmdC);
		cmdC = transitionCommandRecord(cmdC, {
			nextState: "awaiting_confirmation",
			nowMs: 70,
			confirmationExpiresAtMs: 80,
		});
		await seedRuntime.journal.appendLifecycle(cmdC);

		await seedRuntime.stop();

		const replayRuntime = new ControlPlaneRuntime({ repoRoot, ownerId: "replay", nowMs: () => 200 });
		await replayRuntime.start();
		const sideEffects: string[] = [];
		const replayed = await replayRuntime.startupReplay(async (record) => {
			sideEffects.push(record.command_id);
			return {
				terminalState: "completed",
				result: { handled: true },
				mutatingEvents: [
					{
						eventType: "issue.update",
						payload: { issue_id: record.target_id, transition: "replayed" },
					},
				],
			};
		});

		expect(replayed.map((record) => record.command_id)).toEqual(["cmd-a", "cmd-b", "cmd-c"]);
		expect(sideEffects).toEqual(["cmd-b"]);

		expect(replayRuntime.journal.get("cmd-a")?.state).toBe("completed");
		expect(replayRuntime.journal.get("cmd-a")?.result).toMatchObject({
			reconciled: true,
			reason: "mutating_event_present",
		});
		expect(replayRuntime.journal.get("cmd-b")?.state).toBe("completed");
		expect(replayRuntime.journal.get("cmd-c")?.state).toBe("expired");

		const entries = (await readJsonl(join(repoRoot, ".mu", "control-plane", "commands.jsonl"))) as Record<
			string,
			unknown
		>[];
		for (const entry of entries) {
			const kind = entry.kind;
			expect(kind === "command.lifecycle" || kind === "domain.mutating").toBe(true);
			const correlation = entry.correlation as Record<string, unknown>;
			expectCorrelationFields(correlation);
		}

		await replayRuntime.stop();

		const restartRuntime = new ControlPlaneRuntime({ repoRoot, ownerId: "restart", nowMs: () => 300 });
		await restartRuntime.start();
		const sideEffectsAfterRestart: string[] = [];
		await restartRuntime.startupReplay(async (record) => {
			sideEffectsAfterRestart.push(record.command_id);
			return { terminalState: "completed" };
		});
		expect(sideEffectsAfterRestart).toEqual([]);
		await restartRuntime.stop();
	});
});
