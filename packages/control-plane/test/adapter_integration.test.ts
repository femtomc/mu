import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApprovedCommandBroker,
	CommandContextResolver,
	type MessagingOperatorBackend,
	MessagingOperatorRuntime,
	type OperatorBackendTurnInput,
	type OperatorBackendTurnResult,
} from "@femtomc/mu-agent";
import {
	buildControlPlanePolicy,
	ControlPlaneCommandPipeline,
	ControlPlaneInteractionMessageSchema,
	ControlPlaneOperatorTooling,
	ControlPlaneOutbox,
	ControlPlaneOutboxDispatcher,
	type ControlPlanePolicyOverrides,
	ControlPlaneRuntime,
	DiscordControlPlaneAdapter,
	IdentityStore,
	type MuCliInvocationPlan,
	type MuCliRunResult,
	PolicyEngine,
	SlackControlPlaneAdapter,
	TelegramControlPlaneAdapter,
} from "@femtomc/mu-control-plane";

type Harness = {
	clock: { now: number };
	pipeline: ControlPlaneCommandPipeline;
	identities: IdentityStore;
	outbox: ControlPlaneOutbox;
	tooling: ControlPlaneOperatorTooling;
	slack: SlackControlPlaneAdapter;
	discord: DiscordControlPlaneAdapter;
	telegram: TelegramControlPlaneAdapter;
	dispatcher: ControlPlaneOutboxDispatcher;
	deliveries: Array<{ channel: string; body: string; commandId: string }>;
	cliPlans: MuCliInvocationPlan[];
};

type HarnessOpts = {
	slackScopes?: string[];
	discordScopes?: string[];
	telegramScopes?: string[];
	policyOverrides?: ControlPlanePolicyOverrides;
	operatorResult?: OperatorBackendTurnResult;
	operatorBackend?: MessagingOperatorBackend;
	cliRunResult?: MuCliRunResult;
	cliRunResultForPlan?: (plan: MuCliInvocationPlan) => MuCliRunResult | Promise<MuCliRunResult>;
};

const pipelinesToCleanup = new Set<ControlPlaneCommandPipeline>();

afterEach(async () => {
	for (const pipeline of pipelinesToCleanup) {
		await pipeline.stop();
	}
	pipelinesToCleanup.clear();
});

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-adapter-"));
}

function hmac(secret: string, input: string): string {
	const hasher = new Bun.CryptoHasher("sha256", secret);
	hasher.update(input);
	return hasher.digest("hex");
}

function slackRequest(opts: {
	secret: string;
	timestampSec: number;
	text: string;
	triggerId: string;
	teamId?: string;
	channelId?: string;
	actorId?: string;
	requestId?: string;
}): Request {
	const body = new URLSearchParams({
		command: "/mu",
		text: opts.text,
		team_id: opts.teamId ?? "team-1",
		channel_id: opts.channelId ?? "chan-1",
		user_id: opts.actorId ?? "slack-actor",
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

function discordRequest(opts: {
	secret: string;
	timestampSec: number;
	interactionId: string;
	text: string;
	guildId?: string;
	channelId?: string;
	actorId?: string;
}): Request {
	const payload = {
		type: 2,
		id: opts.interactionId,
		guild_id: opts.guildId ?? "guild-1",
		channel_id: opts.channelId ?? "discord-chan",
		member: { user: { id: opts.actorId ?? "discord-actor" } },
		data: {
			name: "mu",
			text: opts.text,
		},
		token: "interaction-token",
	};
	const body = JSON.stringify(payload);
	const timestamp = String(opts.timestampSec);
	const signature = `v1=${hmac(opts.secret, `v1:${timestamp}:${body}`)}`;
	const headers = new Headers({
		"content-type": "application/json",
		"x-discord-request-timestamp": timestamp,
		"x-discord-signature": signature,
	});
	return new Request("https://example.test/discord/interactions", {
		method: "POST",
		headers,
		body,
	});
}

function telegramMessageRequest(opts: {
	secret: string;
	updateId: number;
	text: string;
	messageId?: number;
	chatId?: string;
	actorId?: string;
}): Request {
	const payload = {
		update_id: opts.updateId,
		message: {
			message_id: opts.messageId ?? opts.updateId,
			from: { id: opts.actorId ?? "telegram-actor" },
			chat: { id: opts.chatId ?? "tg-chat-1", type: "private" },
			text: opts.text,
		},
	};
	return new Request("https://example.test/telegram/webhook", {
		method: "POST",
		headers: new Headers({
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": opts.secret,
		}),
		body: JSON.stringify(payload),
	});
}

function telegramCallbackRequest(opts: {
	secret: string;
	updateId: number;
	callbackId: string;
	data: string;
	messageId?: number;
	chatId?: string;
	actorId?: string;
}): Request {
	const payload = {
		update_id: opts.updateId,
		callback_query: {
			id: opts.callbackId,
			from: { id: opts.actorId ?? "telegram-actor" },
			message: {
				message_id: opts.messageId ?? opts.updateId,
				chat: {
					id: opts.chatId ?? "tg-chat-1",
					type: "private",
				},
			},
			data: opts.data,
		},
	};
	return new Request("https://example.test/telegram/webhook", {
		method: "POST",
		headers: new Headers({
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": opts.secret,
		}),
		body: JSON.stringify(payload),
	});
}

class StaticOperatorBackend implements MessagingOperatorBackend {
	readonly #result: OperatorBackendTurnResult;

	public constructor(result: OperatorBackendTurnResult) {
		this.#result = result;
	}

	public async runTurn(): Promise<OperatorBackendTurnResult> {
		return this.#result;
	}
}

class QueueOperatorBackend implements MessagingOperatorBackend {
	readonly #results: OperatorBackendTurnResult[];
	readonly turns: OperatorBackendTurnInput[] = [];

	public constructor(results: OperatorBackendTurnResult[]) {
		this.#results = [...results];
	}

	public async runTurn(input: OperatorBackendTurnInput): Promise<OperatorBackendTurnResult> {
		this.turns.push(input);
		const next = this.#results.shift();
		if (!next) {
			return {
				kind: "respond",
				message: "No scripted response available.",
			};
		}
		return next;
	}
}

class ThrowingOperatorBackend implements MessagingOperatorBackend {
	public async runTurn(): Promise<OperatorBackendTurnResult> {
		throw new Error("backend exploded");
	}
}

async function createHarness(opts: HarnessOpts = {}): Promise<Harness> {
	const repoRoot = await mkTempDir();
	const clock = { now: 10_000 };
	let commandSeq = 0;
	let cliSeq = 0;
	let operatorSessionSeq = 0;

	const runtime = new ControlPlaneRuntime({
		repoRoot,
		ownerId: "adapter-runtime",
		nowMs: () => clock.now,
	});
	const identities = new IdentityStore(runtime.paths.identitiesPath);
	const outbox = new ControlPlaneOutbox(runtime.paths.outboxPath, { nowMs: () => clock.now });
	const tooling = new ControlPlaneOperatorTooling({ runtime, outbox, nowMs: () => clock.now });
	const policy = new PolicyEngine(buildControlPlanePolicy(opts.policyOverrides ?? {}));

	const cliPlans: MuCliInvocationPlan[] = [];
	const cliRunResult: MuCliRunResult = opts.cliRunResult ?? {
		kind: "completed",
		stdout: '{"ok":true}',
		stderr: "",
		exitCode: 0,
		runRootId: "mu-root-operator",
	};

	const resolvedOperatorBackend =
		opts.operatorBackend ?? (opts.operatorResult ? new StaticOperatorBackend(opts.operatorResult) : null);
	const operator =
		resolvedOperatorBackend == null
			? null
			: new MessagingOperatorRuntime({
					backend: resolvedOperatorBackend,
					broker: new ApprovedCommandBroker({
						contextResolver: new CommandContextResolver({ allowedRepoRoots: [repoRoot] }),
					}),
					sessionIdFactory: () => `operator-session-adapter-${++operatorSessionSeq}`,
					turnIdFactory: () => "operator-turn-adapter",
				});

	const pipeline = new ControlPlaneCommandPipeline({
		runtime,
		identityStore: identities,
		policyEngine: policy,
		nowMs: () => clock.now,
		commandIdFactory: () => `cmd-adapter-${++commandSeq}`,
		cliInvocationIdFactory: () => `cli-adapter-${++cliSeq}`,
		readonlyExecutor: async (record) => await tooling.executeReadonly(record),
		mutationExecutor: async (record) => await tooling.executeMutation(record),
		operator,
		cliRunner: {
			run: async ({ plan }) => {
				cliPlans.push(plan);
				if (opts.cliRunResultForPlan) {
					return await opts.cliRunResultForPlan(plan);
				}
				return cliRunResult;
			},
		},
	});
	await pipeline.start();
	pipelinesToCleanup.add(pipeline);

	await identities.link({
		bindingId: "binding-slack",
		operatorId: "op-slack",
		channel: "slack",
		channelTenantId: "team-1",
		channelActorId: "slack-actor",
		scopes: opts.slackScopes ?? ["cp.read", "cp.issue.write", "cp.ops.admin", "cp.run.execute"],
		nowMs: clock.now,
	});
	await identities.link({
		bindingId: "binding-discord",
		operatorId: "op-discord",
		channel: "discord",
		channelTenantId: "guild-1",
		channelActorId: "discord-actor",
		scopes: opts.discordScopes ?? ["cp.read", "cp.issue.write", "cp.ops.admin", "cp.run.execute"],
		nowMs: clock.now,
	});
	await identities.link({
		bindingId: "binding-telegram",
		operatorId: "op-telegram",
		channel: "telegram",
		channelTenantId: "telegram-bot",
		channelActorId: "telegram-actor",
		scopes: opts.telegramScopes ?? ["cp.read", "cp.issue.write", "cp.ops.admin", "cp.run.execute"],
		nowMs: clock.now,
	});

	const slack = new SlackControlPlaneAdapter({
		signingSecret: "slack-secret",
		pipeline,
		outbox,
		nowMs: () => clock.now,
	});
	const discord = new DiscordControlPlaneAdapter({
		signingSecret: "discord-secret",
		pipeline,
		outbox,
		nowMs: () => clock.now,
	});
	const telegram = new TelegramControlPlaneAdapter({
		webhookSecret: "telegram-secret",
		tenantId: "telegram-bot",
		botUsername: "mu_bot",
		pipeline,
		outbox,
		nowMs: () => clock.now,
	});

	const deliveries: Array<{ channel: string; body: string; commandId: string }> = [];
	const dispatcher = new ControlPlaneOutboxDispatcher({
		outbox,
		nowMs: () => clock.now,
		deliver: async (record) => {
			deliveries.push({
				channel: record.envelope.channel,
				body: record.envelope.body,
				commandId: record.envelope.correlation.command_id,
			});
			return { kind: "delivered" };
		},
	});

	return {
		clock,
		pipeline,
		identities,
		outbox,
		tooling,
		slack,
		discord,
		telegram,
		dispatcher,
		deliveries,
		cliPlans,
	};
}

describe("channel adapters integrated with control-plane", () => {
	test("Slack duplicate delivery is idempotent and completion is deferred through outbox", async () => {
		const harness = await createHarness();

		const submitReq = () =>
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "issue close mu-100",
				triggerId: "trigger-1",
				requestId: "req-1",
			});
		const first = await harness.slack.ingest(submitReq());
		expect(first.accepted).toBe(true);
		expect(first.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (first.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${first.pipelineResult?.kind}`);
		}
		const commandId = first.pipelineResult.command.command_id;
		if (!first.outboxRecord) {
			throw new Error("expected outbox record");
		}
		const firstInteraction = ControlPlaneInteractionMessageSchema.parse(
			first.outboxRecord.envelope.metadata.interaction_message,
		);
		expect(firstInteraction.state).toBe("awaiting_confirmation");
		expect(first.outboxRecord.envelope.metadata.interaction_contract_version).toBe(1);
		expect(first.outboxRecord.envelope.body).toContain(firstInteraction.summary);

		const duplicate = await harness.slack.ingest(submitReq());
		expect(duplicate.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (duplicate.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${duplicate.pipelineResult?.kind}`);
		}
		expect(duplicate.pipelineResult.command.command_id).toBe(commandId);

		const pendingAfterDuplicate = harness.outbox.records({ state: "pending" });
		expect(pendingAfterDuplicate.length).toBe(1);

		await harness.dispatcher.drainDue();
		expect(harness.deliveries.length).toBe(1);
		expect(harness.deliveries[0]?.commandId).toBe(commandId);
		expect(harness.deliveries[0]?.body).toContain("LIFECYCLE · AWAITING CONFIRMATION");

		const confirmReq = slackRequest({
			secret: "slack-secret",
			timestampSec: Math.trunc(harness.clock.now / 1000),
			text: `confirm ${commandId}`,
			triggerId: "trigger-2",
			requestId: "req-2",
		});
		const confirm = await harness.slack.ingest(confirmReq);
		expect(confirm.pipelineResult?.kind).toBe("completed");
		if (confirm.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${confirm.pipelineResult?.kind}`);
		}

		await harness.dispatcher.drainDue();
		expect(harness.deliveries.length).toBe(2);
		expect(harness.deliveries[1]?.commandId).toBe(commandId);
		expect(harness.deliveries[1]?.body).toContain("RESULT · COMPLETED");
	});

	test("Slack guarded writes deny unauthorized scope with explicit visibility", async () => {
		const harness = await createHarness({
			slackScopes: ["cp.read"],
		});

		const denied = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "issue close mu-unauthorized",
				triggerId: "trigger-unauthorized",
				requestId: "req-unauthorized",
			}),
		);
		expect(denied.accepted).toBe(true);
		expect(denied.pipelineResult).toEqual({ kind: "denied", reason: "missing_scope" });
		expect(denied.outboxRecord).toBeNull();

		const deniedBody = (await denied.response.json()) as { text?: string };
		expect(deniedBody.text).toContain("ERROR · DENIED");
		expect(deniedBody.text).toContain("missing_scope");

		await harness.dispatcher.drainDue();
		expect(harness.deliveries.length).toBe(0);
	});

	test("Slack kill-switch failures are visible with explicit failed lifecycle output", async () => {
		const harness = await createHarness({
			policyOverrides: {
				ops: {
					mutations_enabled: false,
				},
			},
		});

		const submit = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "issue close mu-kill-switch",
				triggerId: "trigger-kill-switch-submit",
				requestId: "req-kill-switch-submit",
			}),
		);
		expect(submit.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (submit.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${submit.pipelineResult?.kind}`);
		}

		await harness.dispatcher.drainDue();
		expect(harness.deliveries.length).toBe(1);
		expect(harness.deliveries[0]?.body).toContain("LIFECYCLE · AWAITING CONFIRMATION");

		const confirm = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `confirm ${submit.pipelineResult.command.command_id}`,
				triggerId: "trigger-kill-switch-confirm",
				requestId: "req-kill-switch-confirm",
			}),
		);
		expect(confirm.pipelineResult?.kind).toBe("failed");
		if (confirm.pipelineResult?.kind !== "failed") {
			throw new Error(`expected failed, got ${confirm.pipelineResult?.kind}`);
		}
		expect(confirm.pipelineResult.reason).toBe("mutations_disabled_global");

		await harness.dispatcher.drainDue();
		expect(harness.deliveries.length).toBe(2);
		expect(harness.deliveries[1]?.body).toContain("ERROR · FAILED");
		expect(harness.deliveries[1]?.body).toContain("mutations_disabled_global");
	});

	test("Discord adapter has read parity and guarded writes through confirmation", async () => {
		const harness = await createHarness();

		const readReq = discordRequest({
			secret: "discord-secret",
			timestampSec: Math.trunc(harness.clock.now / 1000),
			interactionId: "interaction-read-1",
			text: "status",
		});
		const read = await harness.discord.ingest(readReq);
		expect(read.accepted).toBe(true);
		expect(read.pipelineResult?.kind).toBe("completed");

		const writeReq = () =>
			discordRequest({
				secret: "discord-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				interactionId: "interaction-write-1",
				text: "issue close mu-200",
			});
		const write = await harness.discord.ingest(writeReq());
		expect(write.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (write.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${write.pipelineResult?.kind}`);
		}

		const duplicateWrite = await harness.discord.ingest(writeReq());
		expect(duplicateWrite.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (duplicateWrite.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${duplicateWrite.pipelineResult?.kind}`);
		}
		expect(duplicateWrite.pipelineResult.command.command_id).toBe(write.pipelineResult.command.command_id);
		expect(duplicateWrite.outboxRecord?.outbox_id).toBe(write.outboxRecord?.outbox_id);

		const confirmReq = discordRequest({
			secret: "discord-secret",
			timestampSec: Math.trunc(harness.clock.now / 1000),
			interactionId: "interaction-confirm-1",
			text: `confirm ${write.pipelineResult.command.command_id}`,
		});
		const confirmed = await harness.discord.ingest(confirmReq);
		expect(confirmed.pipelineResult?.kind).toBe("completed");
		if (confirmed.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${confirmed.pipelineResult?.kind}`);
		}
		expect(confirmed.pipelineResult.command.state).toBe("completed");
	});

	test("Telegram adapter matches duplicate-delivery idempotency and outbox retry guarantees", async () => {
		const harness = await createHarness();

		const submitReq = () =>
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 100,
				text: "/mu issue close mu-300",
			});

		const first = await harness.telegram.ingest(submitReq());
		expect(first.accepted).toBe(true);
		expect(first.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (first.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${first.pipelineResult?.kind}`);
		}
		if (!first.outboxRecord) {
			throw new Error("expected outbox record");
		}
		const commandId = first.pipelineResult.command.command_id;

		const duplicate = await harness.telegram.ingest(submitReq());
		expect(duplicate.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (duplicate.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${duplicate.pipelineResult?.kind}`);
		}
		expect(duplicate.pipelineResult.command.command_id).toBe(commandId);
		expect(duplicate.outboxRecord?.outbox_id).toBe(first.outboxRecord.outbox_id);

		let retriedOnce = false;
		const retryingDispatcher = new ControlPlaneOutboxDispatcher({
			outbox: harness.outbox,
			nowMs: () => harness.clock.now,
			deliver: async (record) => {
				if (!retriedOnce && record.outbox_id === first.outboxRecord?.outbox_id) {
					retriedOnce = true;
					return { kind: "retry", error: "telegram_transient", retryDelayMs: 200 };
				}
				harness.deliveries.push({
					channel: record.envelope.channel,
					body: record.envelope.body,
					commandId: record.envelope.correlation.command_id,
				});
				return { kind: "delivered" };
			},
		});

		const firstDrain = await retryingDispatcher.drainDue();
		expect(firstDrain[0]?.kind).toBe("retried");
		const retriedRecord = harness.outbox.get(first.outboxRecord.outbox_id);
		expect(retriedRecord?.state).toBe("pending");
		expect(retriedRecord?.attempt_count).toBe(1);
		expect(retriedRecord?.last_error).toBe("telegram_transient");
		expect(harness.deliveries.length).toBe(0);

		harness.clock.now += 200;
		const secondDrain = await retryingDispatcher.drainDue();
		expect(secondDrain[0]?.kind).toBe("delivered");
		expect(harness.deliveries.length).toBe(1);
		expect(harness.deliveries[0]?.channel).toBe("telegram");
		expect(harness.deliveries[0]?.commandId).toBe(commandId);

		const confirmReq = () =>
			telegramCallbackRequest({
				secret: "telegram-secret",
				updateId: 101,
				callbackId: "cb-1",
				data: `confirm:${commandId}`,
			});
		const confirm = await harness.telegram.ingest(confirmReq());
		expect(confirm.pipelineResult?.kind).toBe("completed");
		if (confirm.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${confirm.pipelineResult?.kind}`);
		}
		const confirmAck = (await confirm.response.json()) as {
			method?: string;
			callback_query_id?: string;
			text?: string;
		};
		expect(confirmAck.method).toBe("answerCallbackQuery");
		expect(confirmAck.callback_query_id).toBe("cb-1");
		expect(confirmAck.text).toBe("Processing…");

		const confirmDuplicate = await harness.telegram.ingest(confirmReq());
		expect(confirmDuplicate.pipelineResult).toEqual({ kind: "denied", reason: "confirmation_invalid_state" });
		expect(confirmDuplicate.outboxRecord).toBeNull();
		const confirmDuplicateAck = (await confirmDuplicate.response.json()) as {
			method?: string;
			callback_query_id?: string;
			text?: string;
		};
		expect(confirmDuplicateAck.method).toBe("answerCallbackQuery");
		expect(confirmDuplicateAck.callback_query_id).toBe("cb-1");
		expect(confirmDuplicateAck.text).toContain("ERROR · DENIED");

		await retryingDispatcher.drainDue();
		expect(harness.deliveries.length).toBe(2);
		expect(harness.deliveries[1]?.commandId).toBe(commandId);
		expect(harness.deliveries[1]?.body).toContain("RESULT · COMPLETED");
	});

	test("Slack/Discord/Telegram operator requests can safely trigger run resumes with correlation", async () => {
		const harness = await createHarness({
			operatorResult: {
				kind: "command",
				command: { kind: "run_resume", root_issue_id: "mu-root-operator" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: '{"status":"ok"}',
				stderr: "",
				exitCode: 0,
				runRootId: "mu-root-operator",
			},
		});

		const slackSubmit = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "please resume that run",
				triggerId: "operator-slack-1",
				requestId: "operator-slack-req-1",
			}),
		);
		const discordSubmit = await harness.discord.ingest(
			discordRequest({
				secret: "discord-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				interactionId: "operator-discord-1",
				text: "please resume that run",
			}),
		);
		const telegramSubmit = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 300,
				text: "please resume that run",
			}),
		);

		for (const entry of [slackSubmit, discordSubmit, telegramSubmit]) {
			expect(entry.pipelineResult?.kind).toBe("awaiting_confirmation");
			if (entry.pipelineResult?.kind !== "awaiting_confirmation") {
				throw new Error(`expected awaiting_confirmation, got ${entry.pipelineResult?.kind}`);
			}
			expect(entry.outboxRecord).not.toBeNull();
		}

		const slackCommandId =
			slackSubmit.pipelineResult?.kind === "awaiting_confirmation"
				? slackSubmit.pipelineResult.command.command_id
				: "";
		const discordCommandId =
			discordSubmit.pipelineResult?.kind === "awaiting_confirmation"
				? discordSubmit.pipelineResult.command.command_id
				: "";
		const telegramCommandId =
			telegramSubmit.pipelineResult?.kind === "awaiting_confirmation"
				? telegramSubmit.pipelineResult.command.command_id
				: "";

		const slackConfirm = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `confirm ${slackCommandId}`,
				triggerId: "operator-slack-confirm",
				requestId: "operator-slack-req-2",
			}),
		);
		const discordConfirm = await harness.discord.ingest(
			discordRequest({
				secret: "discord-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				interactionId: "operator-discord-confirm",
				text: `confirm ${discordCommandId}`,
			}),
		);
		const telegramConfirm = await harness.telegram.ingest(
			telegramCallbackRequest({
				secret: "telegram-secret",
				updateId: 301,
				callbackId: "operator-telegram-confirm",
				data: `confirm:${telegramCommandId}`,
			}),
		);

		for (const entry of [slackConfirm, discordConfirm, telegramConfirm]) {
			expect(entry.pipelineResult?.kind).toBe("completed");
			if (entry.pipelineResult?.kind !== "completed") {
				throw new Error(`expected completed, got ${entry.pipelineResult?.kind}`);
			}
			expect(entry.pipelineResult.command.cli_command_kind).toBe("run_resume");
			expect(entry.pipelineResult.command.run_root_id).toBe("mu-root-operator");
			expect(entry.pipelineResult.command.operator_session_id).toMatch(/^operator-session-adapter-/);
			expect(entry.pipelineResult.command.operator_turn_id).toBe("operator-turn-adapter");
			expect(entry.outboxRecord?.envelope.correlation.cli_command_kind).toBe("run_resume");
			expect(entry.outboxRecord?.envelope.correlation.run_root_id).toBe("mu-root-operator");
			expect(entry.outboxRecord?.envelope.correlation.cli_invocation_id).toBe(
				entry.pipelineResult.command.cli_invocation_id,
			);
		}

		expect(harness.cliPlans.length).toBe(3);
		for (const plan of harness.cliPlans) {
			expect(plan.commandKind).toBe("run_resume");
			expect(plan.argv[0]).toBe("mu");
		}
	});

	test("chat-style Slack messages route through operator with conversation session continuity", async () => {
		const backend = new QueueOperatorBackend([
			{ kind: "respond", message: "Hey — I'm your control-plane operator." },
			{ kind: "respond", message: "Still here in the same chat context." },
			{ kind: "respond", message: "This is a different conversation session." },
		]);
		const harness = await createHarness({
			operatorBackend: backend,
		});

		const first = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "hey there",
				channelId: "chat-1",
				triggerId: "operator-chat-1",
				requestId: "operator-chat-req-1",
			}),
		);
		const second = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "can you help me?",
				channelId: "chat-1",
				triggerId: "operator-chat-2",
				requestId: "operator-chat-req-2",
			}),
		);
		const third = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "new room hello",
				channelId: "chat-2",
				triggerId: "operator-chat-3",
				requestId: "operator-chat-req-3",
			}),
		);

		for (const entry of [first, second, third]) {
			expect(entry.pipelineResult?.kind).toBe("operator_response");
			expect(entry.outboxRecord).toBeNull();
		}

		const firstBody = (await first.response.json()) as { text?: string };
		expect(firstBody.text).toContain("Operator · CHAT");
		expect(backend.turns.length).toBe(3);
		expect(backend.turns[0]?.sessionId).toBe(backend.turns[1]?.sessionId);
		expect(backend.turns[0]?.sessionId).not.toBe(backend.turns[2]?.sessionId);
	});

	test("chat-style Telegram messages are delivered through outbox as plain operator chat", async () => {
		const backend = new QueueOperatorBackend([{ kind: "respond", message: "Hey from Telegram operator." }]);
		const harness = await createHarness({
			operatorBackend: backend,
		});

		const chat = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 700,
				text: "hello operator",
			}),
		);
		expect(chat.pipelineResult?.kind).toBe("operator_response");
		if (chat.pipelineResult?.kind !== "operator_response") {
			throw new Error(`expected operator_response, got ${chat.pipelineResult?.kind}`);
		}
		expect(chat.outboxRecord).not.toBeNull();
		if (!chat.outboxRecord) {
			throw new Error("expected telegram operator chat outbox record");
		}
		expect(chat.outboxRecord.envelope.channel).toBe("telegram");
		expect(chat.outboxRecord.envelope.body).toBe("Hey from Telegram operator.");
		expect(chat.outboxRecord.envelope.metadata.interaction_render_mode).toBe("chat_plain");

		const chatAck = (await chat.response.json()) as { method?: string; chat_id?: string; action?: string };
		expect(chatAck.method).toBe("sendChatAction");
		expect(chatAck.chat_id).toBe("tg-chat-1");
		expect(chatAck.action).toBe("typing");

		await harness.dispatcher.drainDue();
		expect(harness.deliveries.length).toBe(1);
		expect(harness.deliveries[0]?.channel).toBe("telegram");
		expect(harness.deliveries[0]?.body).toBe("Hey from Telegram operator.");
	});

	test("Slack operator path can kick off run starts and complete through confirmation", async () => {
		const harness = await createHarness({
			operatorResult: {
				kind: "command",
				command: { kind: "run_start", prompt: "ship release" },
			},
			cliRunResult: {
				kind: "completed",
				stdout: '{"status":"ok"}',
				stderr: "",
				exitCode: 0,
				runRootId: "mu-root-start",
			},
		});

		const submit = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "please kick off a run to ship release",
				triggerId: "operator-start-1",
				requestId: "operator-start-req-1",
			}),
		);
		expect(submit.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (submit.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${submit.pipelineResult?.kind}`);
		}
		expect(submit.pipelineResult.command.command_args).toEqual(["ship", "release"]);

		const confirm = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `confirm ${submit.pipelineResult.command.command_id}`,
				triggerId: "operator-start-2",
				requestId: "operator-start-req-2",
			}),
		);
		expect(confirm.pipelineResult?.kind).toBe("completed");
		if (confirm.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${confirm.pipelineResult?.kind}`);
		}
		expect(confirm.pipelineResult.command.cli_command_kind).toBe("run_start");
		expect(confirm.pipelineResult.command.run_root_id).toBe("mu-root-start");
		expect(confirm.outboxRecord?.envelope.body).toContain("RESULT · COMPLETED");
		expect(confirm.outboxRecord?.envelope.body).toContain("run_start");

		expect(harness.cliPlans.length).toBe(1);
		expect(harness.cliPlans[0]?.commandKind).toBe("run_start");
		expect(harness.cliPlans[0]?.argv).toEqual(["mu", "run", "ship release", "--max-steps", "20", "--json"]);
	});

	test("scripted Slack chat journey validates status introspection + run kickoff + run follow-up management", async () => {
		const backend = new QueueOperatorBackend([
			{ kind: "respond", message: "Hey — I can help with control-plane tasks." },
			{ kind: "command", command: { kind: "status" } },
			{ kind: "command", command: { kind: "run_start", prompt: "ship release" } },
			{ kind: "command", command: { kind: "run_resume", root_issue_id: "mu-root-flow" } },
		]);
		const harness = await createHarness({
			operatorBackend: backend,
			cliRunResultForPlan: async (plan) => {
				switch (plan.commandKind) {
					case "run_start":
						return {
							kind: "completed",
							stdout: '{"root":"mu-root-flow"}',
							stderr: "",
							exitCode: 0,
							runRootId: "mu-root-flow",
						};
					case "run_resume":
						return {
							kind: "completed",
							stdout: '{"status":"resumed"}',
							stderr: "",
							exitCode: 0,
							runRootId: "mu-root-flow",
						};
					default:
						return {
							kind: "completed",
							stdout: '{"ok":true}',
							stderr: "",
							exitCode: 0,
							runRootId: null,
						};
				}
			},
		});

		const chat = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "hey there",
				channelId: "journey-room",
				triggerId: "journey-1",
				requestId: "journey-req-1",
			}),
		);
		expect(chat.pipelineResult?.kind).toBe("operator_response");
		expect(chat.outboxRecord).toBeNull();
		const chatAck = (await chat.response.json()) as { text?: string };
		expect(chatAck.text).toContain("Operator · CHAT");

		const status = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "what is mu status right now?",
				channelId: "journey-room",
				triggerId: "journey-2",
				requestId: "journey-req-2",
			}),
		);
		expect(status.pipelineResult?.kind).toBe("completed");
		if (status.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${status.pipelineResult?.kind}`);
		}
		expect(status.pipelineResult.command.target_type).toBe("status");
		const statusAck = (await status.response.json()) as { text?: string };
		expect(statusAck.text).toContain("RESULT · COMPLETED");
		expect(status.outboxRecord?.envelope.body).toContain("Payload (structured; can be collapsed in rich clients):");

		const kickoff = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "kick off a run to ship release",
				channelId: "journey-room",
				triggerId: "journey-3",
				requestId: "journey-req-3",
			}),
		);
		expect(kickoff.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (kickoff.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${kickoff.pipelineResult?.kind}`);
		}
		const kickoffId = kickoff.pipelineResult.command.command_id;
		const kickoffAck = (await kickoff.response.json()) as { text?: string };
		expect(kickoffAck.text).toContain("LIFECYCLE · AWAITING CONFIRMATION");
		expect(kickoffAck.text).toContain(`/mu confirm ${kickoffId}`);

		const kickoffConfirm = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `confirm ${kickoffId}`,
				channelId: "journey-room",
				triggerId: "journey-4",
				requestId: "journey-req-4",
			}),
		);
		expect(kickoffConfirm.pipelineResult?.kind).toBe("completed");
		if (kickoffConfirm.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${kickoffConfirm.pipelineResult?.kind}`);
		}
		expect(kickoffConfirm.pipelineResult.command.cli_command_kind).toBe("run_start");
		expect(kickoffConfirm.pipelineResult.command.run_root_id).toBe("mu-root-flow");
		expect(kickoffConfirm.outboxRecord?.envelope.body).toContain("run_start");

		const followUp = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "resume that run",
				channelId: "journey-room",
				triggerId: "journey-5",
				requestId: "journey-req-5",
			}),
		);
		expect(followUp.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (followUp.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${followUp.pipelineResult?.kind}`);
		}
		const followUpId = followUp.pipelineResult.command.command_id;
		const followUpAck = (await followUp.response.json()) as { text?: string };
		expect(followUpAck.text).toContain("LIFECYCLE · AWAITING CONFIRMATION");

		const followUpConfirm = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: `confirm ${followUpId}`,
				channelId: "journey-room",
				triggerId: "journey-6",
				requestId: "journey-req-6",
			}),
		);
		expect(followUpConfirm.pipelineResult?.kind).toBe("completed");
		if (followUpConfirm.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${followUpConfirm.pipelineResult?.kind}`);
		}
		expect(followUpConfirm.pipelineResult.command.cli_command_kind).toBe("run_resume");
		expect(followUpConfirm.pipelineResult.command.run_root_id).toBe("mu-root-flow");
		expect(followUpConfirm.outboxRecord?.envelope.body).toContain("run_resume");

		expect(backend.turns.length).toBe(4);
		expect(backend.turns.every((turn) => turn.sessionId === backend.turns[0]?.sessionId)).toBe(true);
		expect(harness.cliPlans.map((plan) => plan.commandKind)).toEqual(["status", "run_start", "run_resume"]);
		expect(harness.cliPlans[0]?.argv).toEqual(["mu", "status", "--json"]);
		expect(harness.cliPlans[1]?.argv).toEqual(["mu", "run", "ship release", "--max-steps", "20", "--json"]);
		expect(harness.cliPlans[2]?.argv).toEqual(["mu", "resume", "mu-root-flow", "--max-steps", "20", "--json"]);
	});

	test("compact + detailed interaction formatting is consistent across Slack/Discord/Telegram surfaces", async () => {
		const harness = await createHarness();

		const slack = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "status",
				triggerId: "fmt-slack-1",
				requestId: "fmt-slack-req-1",
			}),
		);
		const discord = await harness.discord.ingest(
			discordRequest({
				secret: "discord-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				interactionId: "fmt-discord-1",
				text: "status",
			}),
		);
		const telegram = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 410,
				text: "/mu status",
			}),
		);

		const slackAck = (await slack.response.json()) as { text?: string };
		const discordAck = (await discord.response.json()) as { data?: { content?: string } };
		const telegramAck = (await telegram.response.json()) as {
			method?: string;
			chat_id?: string;
			action?: string;
		};

		for (const text of [slackAck.text, discordAck.data?.content]) {
			expect(text).toContain("RESULT · COMPLETED");
			expect(text).toContain("Key details:");
		}
		expect(telegramAck.method).toBe("sendChatAction");
		expect(telegramAck.chat_id).toBe("tg-chat-1");
		expect(telegramAck.action).toBe("typing");

		const expectedByChannel = {
			slack: "detailed",
			discord: "detailed",
			telegram: "compact",
		} as const;

		for (const entry of [slack, discord, telegram]) {
			const outbox = entry.outboxRecord;
			expect(outbox).not.toBeNull();
			if (!outbox) {
				throw new Error("expected outbox record");
			}
			const interaction = ControlPlaneInteractionMessageSchema.parse(outbox.envelope.metadata.interaction_message);
			expect(interaction.intent).toBe("result");
			expect(outbox.envelope.metadata.interaction_contract_version).toBe(1);
			expect(outbox.envelope.channel in expectedByChannel).toBe(true);
			expect(outbox.envelope.metadata.interaction_render_mode).toBe(
				expectedByChannel[outbox.envelope.channel as keyof typeof expectedByChannel],
			);
			expect(outbox.envelope.body).toContain(interaction.summary);

			if (outbox.envelope.channel === "telegram") {
				expect(outbox.envelope.body).not.toContain("Payload (structured; can be collapsed in rich clients):");
			} else {
				expect(outbox.envelope.body).toContain("Payload (structured; can be collapsed in rich clients):");
			}
		}
	});

	test("operator backend failures degrade to safe operator chat response", async () => {
		const harness = await createHarness({
			operatorBackend: new ThrowingOperatorBackend(),
		});

		const fallback = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "hello?",
				triggerId: "operator-fail-1",
				requestId: "operator-fail-req-1",
			}),
		);
		expect(fallback.pipelineResult?.kind).toBe("operator_response");
		expect(fallback.outboxRecord).toBeNull();
		const body = (await fallback.response.json()) as { text?: string };
		expect(body.text).toContain("Operator · CHAT");
		expect(body.text).toContain("operator_backend_error");
	});

	test("command_id/request_id/channel are preserved end-to-end across adapters", async () => {
		const harness = await createHarness();

		const slack = await harness.slack.ingest(
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				text: "status",
				triggerId: "cross-1",
				requestId: "cross-slack",
			}),
		);
		const discord = await harness.discord.ingest(
			discordRequest({
				secret: "discord-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				interactionId: "cross-discord",
				text: "status",
			}),
		);
		const telegram = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 200,
				text: "/mu@mu_bot status",
			}),
		);

		for (const entry of [slack, discord, telegram]) {
			expect(entry.pipelineResult?.kind).toBe("completed");
			if (entry.pipelineResult?.kind !== "completed") {
				throw new Error(`expected completed, got ${entry.pipelineResult?.kind}`);
			}
			const command = entry.pipelineResult.command;
			const outbox = entry.outboxRecord;
			expect(outbox).not.toBeNull();
			if (!outbox) {
				throw new Error("expected outbox record");
			}
			expect(outbox.envelope.request_id).toBe(command.request_id);
			expect(outbox.envelope.channel).toBe(command.channel);
			expect(outbox.envelope.correlation.command_id).toBe(command.command_id);
			expect(outbox.envelope.correlation.request_id).toBe(command.request_id);
			expect(outbox.envelope.correlation.channel).toBe(command.channel);
		}
	});
});
