import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildControlPlanePolicy,
	ControlPlaneCommandPipeline,
	ControlPlaneOperatorTooling,
	ControlPlaneOutbox,
	ControlPlaneOutboxDispatcher,
	ControlPlaneRuntime,
	IdentityStore,
	PolicyEngine,
	SlackControlPlaneAdapter,
} from "@femtomc/mu-control-plane";

type Harness = {
	clock: { now: number };
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
	slack: SlackControlPlaneAdapter;
};

const pipelinesToCleanup = new Set<ControlPlaneCommandPipeline>();

afterEach(async () => {
	for (const pipeline of pipelinesToCleanup) {
		await pipeline.stop();
	}
	pipelinesToCleanup.clear();
});

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-dlq-"));
}

function hmac(secret: string, input: string): string {
	return createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

function slackRequest(opts: {
	secret: string;
	timestampSec: number;
	text: string;
	triggerId: string;
	requestId?: string;
}): Request {
	const body = new URLSearchParams({
		command: "/mu",
		text: opts.text,
		team_id: "team-1",
		channel_id: "chan-1",
		user_id: "slack-actor",
		trigger_id: opts.triggerId,
		response_url: "https://hooks.slack.test/response",
	}).toString();
	const timestamp = String(opts.timestampSec);
	const signature = `v0=${hmac(opts.secret, `v0:${timestamp}:${body}`)}`;
	const headers = new Headers({
		"content-type": "application/x-www-form-urlencoded",
		"x-slack-request-timestamp": timestamp,
		"x-slack-signature": signature,
	});
	if (opts.requestId) {
		headers.set("x-slack-request-id", opts.requestId);
	}
	return new Request("https://example.test/slack/commands", {
		method: "POST",
		headers,
		body,
	});
}

async function createHarness(): Promise<Harness> {
	const repoRoot = await mkTempDir();
	const clock = { now: 20_000 };
	let commandSeq = 0;

	const runtime = new ControlPlaneRuntime({
		repoRoot,
		ownerId: "dlq-runtime",
		nowMs: () => clock.now,
	});
	const identities = new IdentityStore(runtime.paths.identitiesPath);
	const outbox = new ControlPlaneOutbox(runtime.paths.outboxPath, { nowMs: () => clock.now });
	const tooling = new ControlPlaneOperatorTooling({ runtime, outbox, nowMs: () => clock.now });
	const policy = new PolicyEngine(buildControlPlanePolicy());
	const pipeline = new ControlPlaneCommandPipeline({
		runtime,
		identityStore: identities,
		policyEngine: policy,
		nowMs: () => clock.now,
		commandIdFactory: () => `cmd-dlq-${++commandSeq}`,
		readonlyExecutor: async (record) => await tooling.executeReadonly(record),
		mutationExecutor: async (record) => await tooling.executeMutation(record),
	});
	await pipeline.start();
	pipelinesToCleanup.add(pipeline);

	await identities.link({
		bindingId: "binding-slack",
		operatorId: "op-slack",
		channel: "slack",
		channelTenantId: "team-1",
		channelActorId: "slack-actor",
		scopes: ["cp.read", "cp.issue.write", "cp.ops.admin"],
		nowMs: clock.now,
	});

	const slack = new SlackControlPlaneAdapter({
		signingSecret: "slack-secret",
		pipeline,
		outbox,
		nowMs: () => clock.now,
	});

	return { clock, pipeline, outbox, slack };
}

describe("outbox retries + operator DLQ tooling", () => {
	test("retries dead-letter, supports audit lookup, and replays DLQ preserving command correlation", async () => {
		const harness = await createHarness();

		const submit = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "status",
				triggerId: "status-1",
				requestId: "status-request",
			}),
		);
		expect(submit.pipelineResult?.kind).toBe("completed");
		if (submit.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${submit.pipelineResult?.kind}`);
		}
		const statusCommandId = submit.pipelineResult.command.command_id;
		const initialOutboxId = submit.outboxRecord?.outbox_id;
		expect(initialOutboxId).toBeDefined();
		if (!initialOutboxId) {
			throw new Error("expected initial outbox id");
		}

		const failDelivery = new ControlPlaneOutboxDispatcher({
			outbox: harness.outbox,
			nowMs: () => harness.clock.now,
			deliver: async () => ({ kind: "retry", error: "simulated_delivery_failure", retryDelayMs: 25 }),
		});

		let outcomes = await failDelivery.drainDue();
		expect(outcomes[0]?.kind).toBe("retried");
		harness.clock.now += 30;
		outcomes = await failDelivery.drainDue();
		expect(outcomes[0]?.kind).toBe("retried");
		harness.clock.now += 30;
		outcomes = await failDelivery.drainDue();
		expect(outcomes[0]?.kind).toBe("dead_letter");

		const deadLetter = harness.outbox.inspectDeadLetter(initialOutboxId);
		expect(deadLetter).not.toBeNull();
		if (!deadLetter) {
			throw new Error("expected dead-letter record");
		}
		expect(deadLetter.envelope.correlation.command_id).toBe(statusCommandId);
		expect(deadLetter.attempt_count).toBe(3);

		const auditLookup = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `audit get ${statusCommandId}`,
				triggerId: "audit-1",
				requestId: "audit-request",
			}),
		);
		expect(auditLookup.pipelineResult?.kind).toBe("completed");
		if (auditLookup.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${auditLookup.pipelineResult?.kind}`);
		}
		const auditResult = auditLookup.pipelineResult.command.result as Record<string, unknown>;
		expect(auditResult.ok).toBe(true);
		expect(auditResult.command_id).toBe(statusCommandId);
		expect(Array.isArray(auditResult.lifecycle)).toBe(true);

		const list = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "dlq list",
				triggerId: "dlq-list-1",
				requestId: "dlq-list-request",
			}),
		);
		expect(list.pipelineResult?.kind).toBe("completed");
		if (list.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${list.pipelineResult?.kind}`);
		}
		const listResult = list.pipelineResult.command.result as Record<string, unknown>;
		expect(listResult.count).toBe(1);
		const deadLetters = listResult.dead_letters as Array<Record<string, unknown>>;
		expect(deadLetters[0]?.outbox_id).toBe(initialOutboxId);

		const inspect = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `dlq inspect ${initialOutboxId}`,
				triggerId: "dlq-inspect-1",
				requestId: "dlq-inspect-request",
			}),
		);
		expect(inspect.pipelineResult?.kind).toBe("completed");
		if (inspect.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${inspect.pipelineResult?.kind}`);
		}
		const inspectResult = inspect.pipelineResult.command.result as Record<string, unknown>;
		expect(inspectResult.ok).toBe(true);
		expect(inspectResult.outbox_id).toBe(initialOutboxId);

		const replay = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `dlq replay ${initialOutboxId}`,
				triggerId: "dlq-replay-1",
				requestId: "dlq-replay-request",
			}),
		);
		expect(replay.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (replay.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${replay.pipelineResult?.kind}`);
		}

		const confirmReplay = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `confirm ${replay.pipelineResult.command.command_id}`,
				triggerId: "dlq-replay-confirm-1",
				requestId: "dlq-replay-confirm-request",
			}),
		);
		expect(confirmReplay.pipelineResult?.kind).toBe("completed");
		if (confirmReplay.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${confirmReplay.pipelineResult?.kind}`);
		}
		const replayResult = confirmReplay.pipelineResult.command.result as Record<string, unknown>;
		expect(replayResult.ok).toBe(true);
		expect(replayResult.source_outbox_id).toBe(initialOutboxId);
		const replayOutboxId = replayResult.replay_outbox_id;
		expect(typeof replayOutboxId).toBe("string");

		const replayRecord = harness.outbox.get(String(replayOutboxId));
		expect(replayRecord).not.toBeNull();
		if (!replayRecord) {
			throw new Error("expected replay outbox record");
		}
		expect(replayRecord.replay_of_outbox_id).toBe(initialOutboxId);
		expect(replayRecord.envelope.correlation.command_id).toBe(statusCommandId);

		const successDelivery = new ControlPlaneOutboxDispatcher({
			outbox: harness.outbox,
			nowMs: () => harness.clock.now,
			deliver: async () => ({ kind: "delivered" }),
		});
		const delivered = await successDelivery.drainDue();
		expect(delivered.some((entry) => entry.record.outbox_id === replayOutboxId)).toBe(true);
	});
});
