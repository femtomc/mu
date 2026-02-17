import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagingOperatorBackend, OperatorBackendTurnResult } from "@femtomc/mu-agent";
import { getControlPlanePaths, IdentityStore, SlackControlPlaneAdapterSpec } from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG } from "../src/config.js";
import {
	bootstrapControlPlane,
	buildTelegramSendMessagePayload,
	containsTelegramMathNotation,
	renderTelegramMarkdown,
	type ControlPlaneConfig,
	type ControlPlaneHandle,
} from "../src/control_plane.js";

const handlesToCleanup = new Set<ControlPlaneHandle>();
const dirsToCleanup = new Set<string>();

afterEach(async () => {
	for (const handle of handlesToCleanup) {
		await handle.stop();
	}
	handlesToCleanup.clear();

	for (const dir of dirsToCleanup) {
		await rm(dir, { recursive: true, force: true });
	}
	dirsToCleanup.clear();
});

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
	return new Request("https://example.test/slack/commands", {
		method: "POST",
		headers,
		body,
	});
}

function telegramRequest(opts: {
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

class StaticOperatorBackend implements MessagingOperatorBackend {
	readonly #result: OperatorBackendTurnResult;
	public turns = 0;

	public constructor(result: OperatorBackendTurnResult) {
		this.#result = result;
	}

	public async runTurn(): Promise<OperatorBackendTurnResult> {
		this.turns += 1;
		return this.#result;
	}
}

async function mkRepoRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mu-server-control-plane-"));
	dirsToCleanup.add(root);
	return root;
}

function configWith(opts: {
	slackSecret?: string | null;
	telegramSecret?: string | null;
	telegramBotToken?: string | null;
	telegramBotUsername?: string | null;
	operatorEnabled?: boolean;
	runTriggersEnabled?: boolean;
}): ControlPlaneConfig {
	const base = JSON.parse(JSON.stringify(DEFAULT_MU_CONFIG.control_plane)) as ControlPlaneConfig;
	base.adapters.slack.signing_secret = opts.slackSecret ?? null;
	base.adapters.telegram.webhook_secret = opts.telegramSecret ?? null;
	base.adapters.telegram.bot_token = opts.telegramBotToken ?? null;
	base.adapters.telegram.bot_username = opts.telegramBotUsername ?? null;
	if (typeof opts.operatorEnabled === "boolean") {
		base.operator.enabled = opts.operatorEnabled;
	}
	if (typeof opts.runTriggersEnabled === "boolean") {
		base.operator.run_triggers_enabled = opts.runTriggersEnabled;
	}
	return base;
}

async function linkSlackIdentity(repoRoot: string, scopes: string[]): Promise<void> {
	const paths = getControlPlanePaths(repoRoot);
	const identities = new IdentityStore(paths.identitiesPath);
	await identities.load();
	await identities.link({
		bindingId: "binding-slack",
		operatorId: "op-slack",
		channel: "slack",
		channelTenantId: "team-1",
		channelActorId: "slack-actor",
		scopes,
		nowMs: 1_000,
	});
}

async function linkTelegramIdentity(repoRoot: string, scopes: string[]): Promise<void> {
	const paths = getControlPlanePaths(repoRoot);
	const identities = new IdentityStore(paths.identitiesPath);
	await identities.load();
	await identities.link({
		bindingId: "binding-telegram",
		operatorId: "op-telegram",
		channel: "telegram",
		channelTenantId: "telegram-bot",
		channelActorId: "telegram-actor",
		scopes,
		nowMs: 1_000,
	});
}

describe("telegram markdown rendering", () => {
	test("normalizes common markdown markers while preserving fenced code blocks", () => {
		const input = [
			"# Status update",
			"Operator says **all good** and __ready__.",
			"```ts",
			'const raw = "**not-bold**";',
			"```",
		].join("\n");

		const rendered = renderTelegramMarkdown(input);
		expect(rendered).toContain("*Status update*");
		expect(rendered).toContain("Operator says *all good* and _ready_.");
		expect(rendered).toContain('const raw = "**not-bold**";');
	});

	test("buildTelegramSendMessagePayload toggles parse_mode for rich formatting", () => {
		const rich = buildTelegramSendMessagePayload({
			chatId: "123",
			text: "Hello **world**",
			richFormatting: true,
		});
		expect(rich.chat_id).toBe("123");
		expect(rich.text).toBe("Hello *world*");
		expect(rich.parse_mode).toBe("Markdown");
		expect(rich.disable_web_page_preview).toBe(true);

		const plain = buildTelegramSendMessagePayload({
			chatId: "123",
			text: "Hello **world**",
			richFormatting: false,
		});
		expect(plain.chat_id).toBe("123");
		expect(plain.text).toBe("Hello **world**");
		expect(plain.parse_mode).toBeUndefined();
		expect(plain.disable_web_page_preview).toBeUndefined();
	});

	test("math-like markdown falls back to plain text payload", () => {
		const text = "The estimate is $x_t = x_{t-1} + \\epsilon$ and $$\\sum_i x_i$$.";
		expect(containsTelegramMathNotation(text)).toBe(true);

		const payload = buildTelegramSendMessagePayload({
			chatId: "123",
			text,
			richFormatting: true,
		});
		expect(payload.chat_id).toBe("123");
		expect(payload.text).toBe(text);
		expect(payload.parse_mode).toBeUndefined();
		expect(payload.disable_web_page_preview).toBeUndefined();
	});
});

describe("bootstrapControlPlane operator wiring", () => {
	test("active adapter routes come from adapter specs", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read"]);

		const handle = await bootstrapControlPlane({
			repoRoot,
			config: configWith({ slackSecret: "slack-secret" }),
		});
		expect(handle).not.toBeNull();
		if (!handle) {
			throw new Error("expected control plane handle");
		}
		handlesToCleanup.add(handle);

		expect(handle.activeAdapters).toContainEqual({
			name: "slack",
			route: SlackControlPlaneAdapterSpec.route,
		});
	});

	test("Slack webhook chat messages are routed through injected operator backend", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read"]);

		const handle = await bootstrapControlPlane({
			repoRoot,
			config: configWith({ slackSecret: "slack-secret" }),
			operatorBackend: new StaticOperatorBackend({
				kind: "respond",
				message: "Hello from the messaging operator.",
			}),
		});
		expect(handle).not.toBeNull();
		if (!handle) {
			throw new Error("expected control plane handle");
		}
		handlesToCleanup.add(handle);

		const response = await handle.handleWebhook(
			"/webhooks/slack",
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(Date.now() / 1000),
				text: "hey operator",
				triggerId: "chat-1",
			}),
		);
		expect(response).not.toBeNull();
		if (!response) {
			throw new Error("expected webhook response");
		}
		expect(response.status).toBe(200);

		const body = (await response.json()) as { text?: string };
		expect(body.text).toContain("Operator · CHAT");
	});

	test("Telegram webhook drains outbox immediately for low-latency delivery", async () => {
		const repoRoot = await mkRepoRoot();
		await linkTelegramIdentity(repoRoot, ["cp.read"]);

		const telegramApiCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.startsWith("https://api.telegram.org/bot")) {
				const parsedBody =
					typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				telegramApiCalls.push({ url, body: parsedBody });
				return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return await originalFetch(input as RequestInfo | URL, init);
		}) as typeof fetch;

		try {
			const handle = await bootstrapControlPlane({
				repoRoot,
				config: configWith({
					telegramSecret: "telegram-secret",
					telegramBotToken: "telegram-token",
				}),
			});
			expect(handle).not.toBeNull();
			if (!handle) {
				throw new Error("expected control plane handle");
			}
			handlesToCleanup.add(handle);

			const response = await handle.handleWebhook(
				"/webhooks/telegram",
				telegramRequest({
					secret: "telegram-secret",
					updateId: 101,
					text: "/mu status",
				}),
			);
			expect(response).not.toBeNull();
			if (!response) {
				throw new Error("expected webhook response");
			}
			expect(response.status).toBe(200);
			const ack = (await response.json()) as { method?: string; chat_id?: string; action?: string };
			expect(ack.method).toBe("sendChatAction");
			expect(ack.chat_id).toBe("tg-chat-1");
			expect(ack.action).toBe("typing");

			for (let attempt = 0; attempt < 40 && telegramApiCalls.length === 0; attempt++) {
				await Bun.sleep(10);
			}
			expect(telegramApiCalls.length).toBeGreaterThan(0);
			expect(telegramApiCalls[0]?.body?.chat_id).toBe("tg-chat-1");
			expect(typeof telegramApiCalls[0]?.body?.text).toBe("string");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("operator.enabled=false disables operator routing by default", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read"]);
		const backend = new StaticOperatorBackend({
			kind: "respond",
			message: "This should not be used when disabled.",
		});

		const handle = await bootstrapControlPlane({
			repoRoot,
			config: configWith({
				slackSecret: "slack-secret",
				operatorEnabled: false,
			}),
			operatorBackend: backend,
		});
		expect(handle).not.toBeNull();
		if (!handle) {
			throw new Error("expected control plane handle");
		}
		handlesToCleanup.add(handle);

		const response = await handle.handleWebhook(
			"/webhooks/slack",
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(Date.now() / 1000),
				text: "hey operator",
				triggerId: "chat-disabled",
			}),
		);
		expect(response).not.toBeNull();
		if (!response) {
			throw new Error("expected webhook response");
		}
		expect(response.status).toBe(200);
		const body = (await response.json()) as { text?: string };
		expect(body.text).toContain("unmapped_command");
		expect(body.text).not.toContain("Operator · CHAT");
		expect(backend.turns).toBe(0);
	});

	test("run trigger actions can be disabled on the operator bridge", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read", "cp.run.execute"]);

		const handle = await bootstrapControlPlane({
			repoRoot,
			config: configWith({
				slackSecret: "slack-secret",
				runTriggersEnabled: false,
			}),
			operatorBackend: new StaticOperatorBackend({
				kind: "command",
				command: { kind: "run_resume", root_issue_id: "mu-root-1234" },
			}),
		});
		expect(handle).not.toBeNull();
		if (!handle) {
			throw new Error("expected control plane handle");
		}
		handlesToCleanup.add(handle);

		const response = await handle.handleWebhook(
			"/webhooks/slack",
			slackRequest({
				secret: "slack-secret",
				timestampSec: Math.trunc(Date.now() / 1000),
				text: "please resume that run",
				triggerId: "chat-2",
			}),
		);
		expect(response).not.toBeNull();
		if (!response) {
			throw new Error("expected webhook response");
		}
		expect(response.status).toBe(200);
		const body = (await response.json()) as { text?: string };
		expect(body.text).toContain("ERROR · DENIED");
		expect(body.text).toContain("operator_action_disallowed");
	});

	test("bootstrap cleanup releases writer lock when startup fails", async () => {
		const repoRoot = await mkRepoRoot();
		const identitiesPath = join(repoRoot, ".mu", "control-plane", "identities.jsonl");
		await mkdir(identitiesPath, { recursive: true });

		await expect(
			bootstrapControlPlane({
				repoRoot,
				config: configWith({
					slackSecret: "slack-secret",
				}),
			}),
		).rejects.toThrow();

		const writerLockPath = join(repoRoot, ".mu", "control-plane", "writer.lock");
		expect(await Bun.file(writerLockPath).exists()).toBe(false);
	});
});
