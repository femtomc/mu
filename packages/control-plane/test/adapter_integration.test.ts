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
	slackBotToken?: string | null;
	slackFetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	telegramBotToken?: string | null;
	telegramFetchImpl?: typeof fetch;
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

function slackEventRequest(opts: {
	secret: string;
	timestampSec: number;
	body: Record<string, unknown>;
	requestId?: string;
}): Request {
	const rawBody = JSON.stringify(opts.body);
	const timestamp = String(opts.timestampSec);
	const signature = `v0=${hmac(opts.secret, `v0:${timestamp}:${rawBody}`)}`;
	const headers = new Headers({
		"content-type": "application/json",
		"x-slack-request-timestamp": timestamp,
		"x-slack-signature": signature,
	});
	if (opts.requestId) {
		headers.set("x-slack-request-id", opts.requestId);
	}
	return new Request("https://example.test/slack/events", {
		method: "POST",
		headers,
		body: rawBody,
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
	text?: string;
	caption?: string;
	document?: { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number };
	photo?: Array<{ file_id: string; file_unique_id?: string; file_size?: number; width?: number; height?: number }>;
	messageId?: number;
	chatId?: string;
	actorId?: string;
}): Request {
	const message: Record<string, unknown> = {
		message_id: opts.messageId ?? opts.updateId,
		from: { id: opts.actorId ?? "telegram-actor" },
		chat: { id: opts.chatId ?? "tg-chat-1", type: "private" },
	};
	if (typeof opts.text === "string") {
		message.text = opts.text;
	}
	if (typeof opts.caption === "string") {
		message.caption = opts.caption;
	}
	if (opts.document) {
		message.document = opts.document;
	}
	if (opts.photo) {
		message.photo = opts.photo;
	}
	const payload = {
		update_id: opts.updateId,
		message,
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
		botToken: opts.slackBotToken ?? null,
		fetchImpl: opts.slackFetchImpl as typeof fetch | undefined,
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
		botToken: opts.telegramBotToken ?? "telegram-bot-token",
		fetchImpl: opts.telegramFetchImpl,
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

	test("Slack non-/mu ingress returns guidance noop", async () => {
		const harness = await createHarness();
		const body = new URLSearchParams({
			command: "/other",
			text: "status",
			team_id: "team-1",
			channel_id: "chan-1",
			user_id: "slack-actor",
			trigger_id: "trigger-non-mu",
			response_url: "https://hooks.slack.test/response",
		}).toString();
		const timestamp = String(Math.trunc(harness.clock.now / 1000));
		const req = new Request("https://example.test/slack/commands", {
			method: "POST",
			headers: new Headers({
				"content-type": "application/x-www-form-urlencoded",
				"x-slack-request-timestamp": timestamp,
				"x-slack-signature": `v0=${hmac("slack-secret", `v0:${timestamp}:${body}`)}`,
			}),
			body,
		});
		const result = await harness.slack.ingest(req);
		expect(result.pipelineResult).toEqual({ kind: "noop", reason: "slack_command_required" });
		expect(result.outboxRecord).toBeNull();
		const ack = (await result.response.json()) as { text?: string };
		expect(ack.text).toContain("command-only");
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
		expect(first.inbound?.metadata.delivery_semantics).toBe("at_least_once");
		expect(first.inbound?.metadata.duplicate_safe).toBe(true);
		expect(first.inbound?.metadata.idempotency_scope).toBe("telegram:update_or_callback_id");
		expect(first.inbound?.idempotency_key).toBe("telegram-idem-update-100");
		const commandId = first.pipelineResult.command.command_id;

		const duplicate = await harness.telegram.ingest(submitReq());
		expect(duplicate.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (duplicate.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${duplicate.pipelineResult?.kind}`);
		}
		expect(duplicate.pipelineResult.command.command_id).toBe(commandId);
		expect(duplicate.inbound?.idempotency_key).toBe(first.inbound?.idempotency_key);
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

	test("Telegram operator requests can safely trigger run resumes with correlation", async () => {
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
		expect(slackSubmit.pipelineResult).toEqual({ kind: "noop", reason: "channel_requires_explicit_command" });
		expect(slackSubmit.outboxRecord).toBeNull();

		const discordSubmit = await harness.discord.ingest(
			discordRequest({
				secret: "discord-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				interactionId: "operator-discord-1",
				text: "please resume that run",
			}),
		);
		expect(discordSubmit.pipelineResult).toEqual({ kind: "noop", reason: "channel_requires_explicit_command" });
		expect(discordSubmit.outboxRecord).toBeNull();

		const telegramSubmit = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 300,
				text: "please resume that run",
			}),
		);

		expect(telegramSubmit.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (telegramSubmit.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${telegramSubmit.pipelineResult?.kind}`);
		}
		expect(telegramSubmit.outboxRecord).not.toBeNull();

		const telegramCommandId =
			telegramSubmit.pipelineResult?.kind === "awaiting_confirmation"
				? telegramSubmit.pipelineResult.command.command_id
				: "";

		const telegramConfirm = await harness.telegram.ingest(
			telegramCallbackRequest({
				secret: "telegram-secret",
				updateId: 301,
				callbackId: "operator-telegram-confirm",
				data: `confirm:${telegramCommandId}`,
			}),
		);

		expect(telegramConfirm.pipelineResult?.kind).toBe("completed");
		if (telegramConfirm.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${telegramConfirm.pipelineResult?.kind}`);
		}
		expect(telegramConfirm.pipelineResult.command.cli_command_kind).toBe("run_resume");
		expect(telegramConfirm.pipelineResult.command.run_root_id).toBe("mu-root-operator");
		expect(telegramConfirm.pipelineResult.command.operator_session_id).toMatch(/^operator-session-adapter-/);
		expect(telegramConfirm.pipelineResult.command.operator_turn_id).toBe("operator-turn-adapter");
		expect(telegramConfirm.outboxRecord?.envelope.correlation.cli_command_kind).toBe("run_resume");
		expect(telegramConfirm.outboxRecord?.envelope.correlation.run_root_id).toBe("mu-root-operator");
		expect(telegramConfirm.outboxRecord?.envelope.correlation.cli_invocation_id).toBe(
			telegramConfirm.pipelineResult.command.cli_invocation_id,
		);

		expect(harness.cliPlans.length).toBe(1);
		for (const plan of harness.cliPlans) {
			expect(plan.commandKind).toBe("run_resume");
			expect(plan.argv[0]).toBe("mu");
		}
	});

	test("chat-style Telegram messages route through operator with conversation session continuity", async () => {
		const backend = new QueueOperatorBackend([
			{ kind: "respond", message: "Hey — I'm your control-plane operator." },
			{ kind: "respond", message: "Still here in the same chat context." },
			{ kind: "respond", message: "This is a different conversation session." },
		]);
		const harness = await createHarness({
			operatorBackend: backend,
		});

		const first = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 810,
				text: "hey there",
				chatId: "chat-1",
			}),
		);
		const second = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 811,
				text: "can you help me?",
				chatId: "chat-1",
			}),
		);
		const third = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 812,
				text: "new room hello",
				chatId: "chat-2",
			}),
		);

		for (const entry of [first, second, third]) {
			expect(entry.pipelineResult?.kind).toBe("operator_response");
			expect(entry.outboxRecord).not.toBeNull();
		}

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

	test("Telegram document + caption routes conversationally and stores inbound attachment metadata", async () => {
		const backend = new QueueOperatorBackend([{ kind: "respond", message: "Got the file." }]);
		const harness = await createHarness({
			operatorBackend: backend,
			telegramFetchImpl: (async (input) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes("/getFile")) {
					return new Response(JSON.stringify({ ok: true, result: { file_path: "docs/file-1.pdf" } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				if (url.includes("/file/bot")) {
					return new Response(new Uint8Array([1, 2, 3]), {
						status: 200,
						headers: { "content-type": "application/pdf" },
					});
				}
				throw new Error(`unexpected fetch ${url}`);
			}) as typeof fetch,
		});

		const result = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 920,
				caption: "please summarize this",
				document: {
					file_id: "doc-file-1",
					file_unique_id: "doc-uniq-1",
					file_name: "spec.pdf",
					mime_type: "application/pdf",
					file_size: 3,
				},
			}),
		);
		expect(result.pipelineResult?.kind).toBe("operator_response");
		expect(backend.turns[0]?.inbound.command_text).toBe("please summarize this");
		expect(result.inbound?.attachments?.length).toBe(1);
		expect(result.inbound?.attachments?.[0]?.reference.source).toBe("mu-attachment:telegram");
	});

	test("Telegram file-only message creates deterministic synthetic conversational prompt", async () => {
		const backend = new QueueOperatorBackend([{ kind: "respond", message: "Acknowledged attachment." }]);
		const harness = await createHarness({
			operatorBackend: backend,
			telegramFetchImpl: (async (input) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes("/getFile")) {
					return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/image-1.jpg" } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				if (url.includes("/file/bot")) {
					return new Response(new Uint8Array([9, 8, 7]), {
						status: 200,
						headers: { "content-type": "image/jpeg" },
					});
				}
				throw new Error(`unexpected fetch ${url}`);
			}) as typeof fetch,
		});
		const result = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 921,
				photo: [{ file_id: "photo-1", file_unique_id: "photo-uniq-1", file_size: 3, width: 10, height: 10 }],
			}),
		);
		expect(result.pipelineResult?.kind).toBe("operator_response");
		expect(backend.turns[0]?.inbound.command_text).toContain("Telegram attachment message (no text/caption)");
		expect(backend.turns[0]?.inbound.command_text).toContain("type=photo");
	});

	test("Telegram attachment download failures preserve conversational turn with audit metadata", async () => {
		const backend = new QueueOperatorBackend([{ kind: "respond", message: "I could not fetch the attachment." }]);
		const harness = await createHarness({
			operatorBackend: backend,
			telegramFetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
		});
		const result = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 922,
				document: {
					file_id: "doc-fail-1",
					mime_type: "application/pdf",
					file_size: 100,
				},
			}),
		);
		expect(result.pipelineResult?.kind).toBe("operator_response");
		expect(result.inbound?.attachments ?? []).toHaveLength(0);
		const audit = backend.turns[0]?.inbound.metadata.inbound_attachment_audit as Array<Record<string, unknown>> | undefined;
		expect(audit?.[0]?.kind).toBe("download_failed");
	});

	test("Telegram operator path can kick off run starts and complete through confirmation", async () => {
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

		const submit = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 900,
				text: "please kick off a run to ship release",
			}),
		);
		expect(submit.pipelineResult?.kind).toBe("awaiting_confirmation");
		if (submit.pipelineResult?.kind !== "awaiting_confirmation") {
			throw new Error(`expected awaiting_confirmation, got ${submit.pipelineResult?.kind}`);
		}
		expect(submit.pipelineResult.command.command_args).toEqual(["ship", "release"]);

		const confirm = await harness.telegram.ingest(
			telegramCallbackRequest({
				secret: "telegram-secret",
				updateId: 901,
				callbackId: "operator-start-confirm",
				data: `confirm:${submit.pipelineResult.command.command_id}`,
			}),
		);
		expect(confirm.pipelineResult?.kind).toBe("completed");
		if (confirm.pipelineResult?.kind !== "completed") {
			throw new Error(`expected completed, got ${confirm.pipelineResult?.kind}`);
		}
		expect(confirm.pipelineResult.command.cli_command_kind).toBe("run_start");
		expect(confirm.pipelineResult.command.run_root_id).toBe("mu-root-start");
		expect(confirm.outboxRecord?.envelope.body).toContain("RESULT · COMPLETED");
		expect(confirm.outboxRecord?.envelope.body).toContain("run start");

		expect(harness.cliPlans.length).toBe(1);
		expect(harness.cliPlans[0]?.commandKind).toBe("run_start");
		expect(harness.cliPlans[0]?.argv).toEqual(["mu", "runs", "start", "ship release", "--max-steps", "20"]);
	});

	test("Slack non-command turns are deterministic no-op with guidance", async () => {
		const backend = new QueueOperatorBackend([{ kind: "respond", message: "Should not be used in Slack command-only mode." }]);
		const harness = await createHarness({
			operatorBackend: backend,
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
		expect(chat.pipelineResult).toEqual({ kind: "noop", reason: "channel_requires_explicit_command" });
		expect(chat.outboxRecord).toBeNull();
		const chatAck = (await chat.response.json()) as { text?: string };
		expect(chatAck.text).toContain("IGNORED");
		expect(backend.turns.length).toBe(0);
	});

	test("Slack event callbacks enforce explicit /mu and keep duplicates idempotent", async () => {
		const harness = await createHarness();
		const mkEventReq = () =>
			slackEventRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				requestId: "evt-req-1",
				body: {
					type: "event_callback",
					team_id: "team-1",
					event_id: "Ev123",
					event: {
						type: "message",
						channel: "chan-1",
						user: "slack-actor",
						text: "/mu status",
						event_ts: "1700000000.100",
					},
				},
			});

		const first = await harness.slack.ingest(mkEventReq());
		expect(first.pipelineResult?.kind).toBe("completed");
		const duplicate = await harness.slack.ingest(mkEventReq());
		expect(duplicate.pipelineResult?.kind).toBe("completed");
		if (first.pipelineResult?.kind !== "completed" || duplicate.pipelineResult?.kind !== "completed") {
			throw new Error("expected completed results for first+duplicate event callbacks");
		}
		expect(duplicate.pipelineResult.command.command_id).toBe(first.pipelineResult.command.command_id);

		const ignored = await harness.slack.ingest(
			slackEventRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				requestId: "evt-req-2",
				body: {
					type: "event_callback",
					team_id: "team-1",
					event_id: "Ev124",
					event: {
						type: "message",
						channel: "chan-1",
						user: "slack-actor",
						text: "status",
						event_ts: "1700000000.101",
					},
				},
			}),
		);
		expect(ignored.pipelineResult).toEqual({ kind: "noop", reason: "channel_requires_explicit_command" });
		expect(ignored.outboxRecord).toBeNull();
	});

	test("Slack file-bearing events download/store allowed attachments and tolerate download failures", async () => {
		const harness = await createHarness({
			slackBotToken: "xoxb-test",
			slackFetchImpl: async (input) => {
				const url = String(input);
				if (url.includes("file-ok")) {
					return new Response("file-body", { status: 200, headers: { "content-type": "text/plain" } });
				}
				return new Response("not-found", { status: 404 });
			},
		});

		const result = await harness.slack.ingest(
			slackEventRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(harness.clock.now / 1000),
				requestId: "evt-req-files",
				body: {
					type: "event_callback",
					team_id: "team-1",
					event_id: "Ev200",
					event: {
						type: "message",
						channel: "chan-1",
						user: "slack-actor",
						text: "/mu status",
						event_ts: "1700000000.200",
						files: [
							{
								id: "FOK",
								mimetype: "text/plain",
								size: 9,
								name: "ok.txt",
								url_private_download: "https://files.slack.test/file-ok",
							},
							{
								id: "FBAD",
								mimetype: "text/plain",
								size: 5,
								name: "bad.txt",
								url_private_download: "https://files.slack.test/file-bad",
							},
						],
					},
				},
			}),
		);
		expect(result.pipelineResult?.kind).toBe("completed");
		expect(result.inbound?.attachments?.length).toBe(1);
		expect(result.inbound?.attachments?.[0]?.reference.source).toBe("mu-attachment:slack");
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

		const fallback = await harness.telegram.ingest(
			telegramMessageRequest({
				secret: "telegram-secret",
				updateId: 991,
				text: "hello?",
			}),
		);
		expect(fallback.pipelineResult?.kind).toBe("operator_response");
		expect(fallback.outboxRecord).not.toBeNull();
		if (!fallback.outboxRecord) {
			throw new Error("expected telegram fallback outbox record");
		}
		expect(fallback.outboxRecord.envelope.body).toContain("operator_backend_error");
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
