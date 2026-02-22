import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagingOperatorBackend, OperatorBackendTurnResult } from "@femtomc/mu-agent";
import {
	ControlPlaneOutbox,
	getControlPlanePaths,
	IdentityStore,
	OutboxRecordSchema,
	SlackControlPlaneAdapterSpec,
} from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG } from "../src/config.js";
import {
	bootstrapControlPlane,
	buildTelegramSendMessagePayload,
	deliverSlackOutboxRecord,
	deliverTelegramOutboxRecord,
	type BootstrapControlPlaneOpts,
	type ControlPlaneConfig,
	type ControlPlaneHandle,
	type ControlPlaneSessionLifecycle,
	containsTelegramMathNotation,
	renderSlackMarkdown,
	renderTelegramMarkdown,
	splitSlackMessageText,
	splitTelegramMessageText,
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

const TEST_SESSION_LIFECYCLE: ControlPlaneSessionLifecycle = {
	reload: async () => ({ ok: true, action: "reload", message: "test reload scheduled" }),
	update: async () => ({ ok: true, action: "update", message: "test update scheduled" }),
};

function bootstrapControlPlaneForTest(
	opts: Omit<BootstrapControlPlaneOpts, "sessionLifecycle"> & {
		sessionLifecycle?: ControlPlaneSessionLifecycle;
	},
) {
	return bootstrapControlPlane({
		...opts,
		sessionLifecycle: opts.sessionLifecycle ?? TEST_SESSION_LIFECYCLE,
	});
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

function streamFromLines(lines: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const line of lines) {
				controller.enqueue(
					encoder.encode(`${line}
`),
				);
			}
			controller.close();
		},
	});
}

async function waitFor<T>(
	fn: () => T | Promise<T>,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 2_000;
	const intervalMs = opts.intervalMs ?? 20;
	const startedAt = Date.now();
	while (true) {
		const value = await fn();
		if (value) {
			return value;
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("timeout waiting for condition");
		}
		await Bun.sleep(intervalMs);
	}
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

class DelayedOperatorBackend implements MessagingOperatorBackend {
	readonly #delayMs: number;
	readonly #result: OperatorBackendTurnResult;

	public constructor(delayMs: number, result: OperatorBackendTurnResult) {
		this.#delayMs = Math.max(0, Math.trunc(delayMs));
		this.#result = result;
	}

	public async runTurn(): Promise<OperatorBackendTurnResult> {
		if (this.#delayMs > 0) {
			await Bun.sleep(this.#delayMs);
		}
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
	slackBotToken?: string | null;
	neovimSecret?: string | null;
	telegramSecret?: string | null;
	telegramBotToken?: string | null;
	telegramBotUsername?: string | null;
	operatorEnabled?: boolean;
}): ControlPlaneConfig {
	const base = JSON.parse(JSON.stringify(DEFAULT_MU_CONFIG.control_plane)) as ControlPlaneConfig;
	base.adapters.slack.signing_secret = opts.slackSecret ?? null;
	base.adapters.slack.bot_token = opts.slackBotToken ?? null;
	base.adapters.neovim.shared_secret = opts.neovimSecret ?? null;
	base.adapters.telegram.webhook_secret = opts.telegramSecret ?? null;
	base.adapters.telegram.bot_token = opts.telegramBotToken ?? null;
	base.adapters.telegram.bot_username = opts.telegramBotUsername ?? null;
	if (typeof opts.operatorEnabled === "boolean") {
		base.operator.enabled = opts.operatorEnabled;
	}
	return base;
}

function mkTelegramOutboxRecord(opts: {
	body?: string;
	attachments?: Array<Record<string, unknown>>;
	metadata?: Record<string, unknown>;
}) {
	return OutboxRecordSchema.parse({
		outbox_id: "out-test-1",
		dedupe_key: "dedupe-test-1",
		state: "pending",
		envelope: {
			v: 1,
			ts_ms: 1_000,
			channel: "telegram",
			channel_tenant_id: "telegram-bot",
			channel_conversation_id: "tg-chat-1",
			request_id: "req-1",
			response_id: "resp-1",
			kind: "result",
			body: opts.body ?? "hello telegram",
			attachments: opts.attachments,
			correlation: {
				command_id: "cmd-1",
				idempotency_key: "idem-1",
				request_id: "req-1",
				channel: "telegram",
				channel_tenant_id: "telegram-bot",
				channel_conversation_id: "tg-chat-1",
				actor_id: "telegram-actor",
				actor_binding_id: "binding-telegram",
				assurance_tier: "tier_b",
				repo_root: "/tmp/repo",
				scope_required: "cp.read",
				scope_effective: "cp.read",
				target_type: "status",
				target_id: "tg-chat-1",
				attempt: 1,
				state: "completed",
				error_code: null,
				operator_session_id: null,
				operator_turn_id: null,
				cli_invocation_id: null,
				cli_command_kind: null,
			},
			metadata: opts.metadata ?? {},
		},
		created_at_ms: 1_000,
		updated_at_ms: 1_000,
		next_attempt_at_ms: 1_000,
		attempt_count: 0,
		max_attempts: 3,
		last_error: null,
		dead_letter_reason: null,
		replay_of_outbox_id: null,
		replay_requested_by_command_id: null,
	});
}

function mkSlackOutboxRecord(opts: {
	body?: string;
	attachments?: Array<Record<string, unknown>>;
	metadata?: Record<string, unknown>;
}) {
	return OutboxRecordSchema.parse({
		outbox_id: "out-slack-test-1",
		dedupe_key: "dedupe-slack-test-1",
		state: "pending",
		envelope: {
			v: 1,
			ts_ms: 1_000,
			channel: "slack",
			channel_tenant_id: "team-1",
			channel_conversation_id: "chan-1",
			request_id: "req-1",
			response_id: "resp-1",
			kind: "result",
			body: opts.body ?? "hello slack",
			attachments: opts.attachments,
			correlation: {
				command_id: "cmd-1",
				idempotency_key: "idem-1",
				request_id: "req-1",
				channel: "slack",
				channel_tenant_id: "team-1",
				channel_conversation_id: "chan-1",
				actor_id: "slack-actor",
				actor_binding_id: "binding-slack",
				assurance_tier: "tier_a",
				repo_root: "/tmp/repo",
				scope_required: "cp.read",
				scope_effective: "cp.read",
				target_type: "status",
				target_id: "chan-1",
				attempt: 1,
				state: "completed",
				error_code: null,
				operator_session_id: null,
				operator_turn_id: null,
				cli_invocation_id: null,
				cli_command_kind: null,
			},
			metadata: opts.metadata ?? {},
		},
		created_at_ms: 1_000,
		updated_at_ms: 1_000,
		next_attempt_at_ms: 1_000,
		attempt_count: 0,
		max_attempts: 3,
		last_error: null,
		dead_letter_reason: null,
		replay_of_outbox_id: null,
		replay_requested_by_command_id: null,
	});
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

async function linkDiscordIdentity(repoRoot: string, scopes: string[]): Promise<void> {
	const paths = getControlPlanePaths(repoRoot);
	const identities = new IdentityStore(paths.identitiesPath);
	await identities.load();
	await identities.link({
		bindingId: "binding-discord",
		operatorId: "op-discord",
		channel: "discord",
		channelTenantId: "guild-1",
		channelActorId: "discord-actor",
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

async function linkNeovimIdentity(repoRoot: string, scopes: string[]): Promise<void> {
	const paths = getControlPlanePaths(repoRoot);
	const identities = new IdentityStore(paths.identitiesPath);
	await identities.load();
	await identities.link({
		bindingId: "binding-neovim",
		operatorId: "op-neovim",
		channel: "neovim",
		channelTenantId: "workspace-1",
		channelActorId: "neovim-actor",
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

	test("renderSlackMarkdown normalizes headings while preserving fenced code blocks", () => {
		const input = [
			"### Capability summary",
			"Operator says **all good** and __ready__.",
			"```md",
			"### keep as-is",
			"```",
		].join("\n");

		const rendered = renderSlackMarkdown(input);
		expect(rendered).toContain("*Capability summary*");
		expect(rendered).toContain("Operator says *all good* and _ready_.");
		expect(rendered).toContain("### keep as-is");
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

	test("splitTelegramMessageText uses deterministic boundaries", () => {
		const text = `alpha\n${"x".repeat(20)}\nomega`;
		const chunksA = splitTelegramMessageText(text, 16);
		const chunksB = splitTelegramMessageText(text, 16);
		expect(chunksA).toEqual(chunksB);
		expect(chunksA.every((chunk) => chunk.length <= 16)).toBe(true);
		expect(chunksA.join("")).toBe(text);
	});
});

describe("telegram outbound media delivery", () => {
	test("sends PDF/SVG attachments via sendDocument", async () => {
		const calls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			if (url === "https://example.invalid/report.pdf") {
				return new Response(new Uint8Array([1, 2, 3, 4]), {
					status: 200,
					headers: { "content-type": "application/pdf" },
				});
			}
			if (url.includes("/sendDocument")) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url} / ${String(init?.method ?? "GET")}`);
		}) as typeof fetch;

		try {
			const record = mkTelegramOutboxRecord({
				attachments: [
					{
						type: "document",
						filename: "report.pdf",
						mime_type: "application/pdf",
						reference: { source: "artifact", url: "https://example.invalid/report.pdf" },
					},
				],
			});
			const result = await deliverTelegramOutboxRecord({
				botToken: "telegram-token",
				record,
			});
			expect(result.kind).toBe("delivered");
			expect(calls.some((url) => url.includes("/sendDocument"))).toBe(true);
			expect(calls.some((url) => url.includes("/sendPhoto"))).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("routes SVG attachments through sendDocument instead of sendPhoto", async () => {
		const calls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			if (url.includes("/sendDocument")) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			const record = mkTelegramOutboxRecord({
				attachments: [
					{
						type: "image",
						filename: "diagram.svg",
						mime_type: "image/svg+xml",
						reference: { source: "telegram", file_id: "file-svg-1" },
					},
				],
			});
			const result = await deliverTelegramOutboxRecord({
				botToken: "telegram-token",
				record,
			});
			expect(result.kind).toBe("delivered");
			expect(calls.some((url) => url.includes("/sendDocument"))).toBe(true);
			expect(calls.some((url) => url.includes("/sendPhoto"))).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("falls back to text sendMessage when media API rejects attachment", async () => {
		const calls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			if (url.includes("/sendPhoto")) {
				return new Response(JSON.stringify({ ok: false, description: "Bad Request: PHOTO_INVALID" }), {
					status: 400,
				});
			}
			if (url.includes("/sendMessage")) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			const record = mkTelegramOutboxRecord({
				attachments: [
					{
						type: "image",
						filename: "plot.png",
						mime_type: "image/png",
						reference: { source: "telegram", file_id: "file-123" },
					},
				],
			});
			const result = await deliverTelegramOutboxRecord({
				botToken: "telegram-token",
				record,
			});
			expect(result.kind).toBe("delivered");
			expect(calls.some((url) => url.includes("/sendPhoto"))).toBe(true);
			expect(calls.some((url) => url.includes("/sendMessage"))).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("preserves text-only sendMessage behavior when attachments are omitted", async () => {
		const calls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			if (url.includes("/sendMessage")) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			const record = mkTelegramOutboxRecord({ body: "plain text response", attachments: undefined });
			const result = await deliverTelegramOutboxRecord({
				botToken: "telegram-token",
				record,
			});
			expect(result.kind).toBe("delivered");
			expect(calls.some((url) => url.includes("/sendMessage"))).toBe(true);
			expect(calls.some((url) => url.includes("/sendDocument"))).toBe(false);
			expect(calls.some((url) => url.includes("/sendPhoto"))).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("markdown fallback retries without parse_mode on Telegram sendMessage 400", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (!url.includes("/sendMessage")) {
				throw new Error(`unexpected fetch: ${url}`);
			}
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			payloads.push(body);
			if (body.parse_mode === "Markdown") {
				return new Response(JSON.stringify({ ok: false, description: "Bad Request: cannot parse entities" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const record = mkTelegramOutboxRecord({
				body: "Hello **world**",
				metadata: { telegram_reply_to_message_id: 55 },
			});
			const result = await deliverTelegramOutboxRecord({
				botToken: "telegram-token",
				record,
			});
			expect(result.kind).toBe("delivered");
			expect(payloads).toHaveLength(2);
			expect(payloads[0]?.parse_mode).toBe("Markdown");
			expect(payloads[1]?.parse_mode).toBeUndefined();
			expect(payloads[1]?.disable_web_page_preview).toBeUndefined();
			expect(payloads[1]?.reply_to_message_id).toBe(55);
			expect(payloads[1]?.allow_sending_without_reply).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("normalizes markdown headings before Slack chat.postMessage delivery", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url !== "https://slack.com/api/chat.postMessage") {
				throw new Error(`unexpected fetch: ${url}`);
			}
			payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify({ ok: true, ts: "10.02a" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const result = await deliverSlackOutboxRecord({
				botToken: "xoxb-test-token",
				record: mkSlackOutboxRecord({ body: "### Heading\n- one\n- two" }),
			});
			expect(result.kind).toBe("delivered");
			expect(payloads).toHaveLength(1);
			expect(payloads[0]?.text).toBe("*Heading*\n- one\n- two");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("anchors Slack text delivery to thread_ts when metadata is present", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url !== "https://slack.com/api/chat.postMessage") {
				throw new Error(`unexpected fetch: ${url}`);
			}
			payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify({ ok: true, ts: "10.02" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const result = await deliverSlackOutboxRecord({
				botToken: "xoxb-test-token",
				record: mkSlackOutboxRecord({ body: "anchored", metadata: { slack_thread_ts: "171.0002" } }),
			});
			expect(result.kind).toBe("delivered");
			expect(payloads).toHaveLength(1);
			expect(payloads[0]?.thread_ts).toBe("171.0002");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("updates Slack in-thread status card when slack_status_message_ts metadata is present", async () => {
		const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url !== "https://slack.com/api/chat.update" && url !== "https://slack.com/api/chat.postMessage") {
				throw new Error(`unexpected fetch: ${url}`);
			}
			const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			calls.push({ url, payload });
			return new Response(JSON.stringify({ ok: true, ts: "10.20" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const result = await deliverSlackOutboxRecord({
				botToken: "xoxb-test-token",
				record: mkSlackOutboxRecord({
					body: "final output",
					metadata: {
						slack_thread_ts: "171.0002",
						slack_status_message_ts: "171.0003",
					},
				}),
			});
			expect(result.kind).toBe("delivered");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("https://slack.com/api/chat.update");
			expect(calls[0]?.payload.ts).toBe("171.0003");
			expect(calls[0]?.payload.text).toBe("final output");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("splits long Slack text into deterministic ordered chunks", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const body = `${"A".repeat(3_490)}\n${"B".repeat(3_490)}\n${"C".repeat(300)}`;
		const expected = splitSlackMessageText(body);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url !== "https://slack.com/api/chat.postMessage") {
				throw new Error(`unexpected fetch: ${url}`);
			}
			payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify({ ok: true, ts: "10.03" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const result = await deliverSlackOutboxRecord({ botToken: "xoxb-test-token", record: mkSlackOutboxRecord({ body }) });
			expect(result.kind).toBe("delivered");
			expect(payloads.map((entry) => entry.text)).toEqual(expected);
			expect(expected.length).toBeGreaterThan(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("anchors Telegram text delivery to source message when metadata is present", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/sendMessage")) {
				payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch;
		try {
			const record = mkTelegramOutboxRecord({ body: "anchored response", metadata: { telegram_reply_to_message_id: "77" } });
			const result = await deliverTelegramOutboxRecord({ botToken: "telegram-token", record });
			expect(result.kind).toBe("delivered");
			expect(payloads).toHaveLength(1);
			expect(payloads[0]?.reply_to_message_id).toBe(77);
			expect(payloads[0]?.allow_sending_without_reply).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("invalid Telegram reply anchor metadata gracefully falls back to non-anchored sendMessage", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/sendMessage")) {
				payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch;
		try {
			const record = mkTelegramOutboxRecord({
				body: "invalid anchor fallback",
				metadata: { telegram_reply_to_message_id: "not-an-int" },
			});
			const result = await deliverTelegramOutboxRecord({ botToken: "telegram-token", record });
			expect(result.kind).toBe("delivered");
			expect(payloads).toHaveLength(1);
			expect(payloads[0]?.reply_to_message_id).toBeUndefined();
			expect(payloads[0]?.allow_sending_without_reply).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("splits long Telegram text into ordered sendMessage chunks", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/sendMessage")) {
				payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch;
		try {
			const body = `${"x".repeat(4_500)}\n${"y".repeat(300)}`;
			const record = mkTelegramOutboxRecord({ body, metadata: { telegram_reply_to_message_id: 9 } });
			const result = await deliverTelegramOutboxRecord({ botToken: "telegram-token", record });
			expect(result.kind).toBe("delivered");
			expect(payloads.length).toBeGreaterThan(1);
			expect(String(payloads[0]?.text ?? "").length).toBeLessThanOrEqual(4_096);
			expect(payloads[0]?.reply_to_message_id).toBe(9);
			expect(payloads[1]?.reply_to_message_id).toBeUndefined();
			expect(payloads.map((entry) => String(entry.text ?? "")).join("")).toBe(body);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("bootstrapControlPlane operator wiring", () => {
	test("active adapter routes come from adapter specs", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read"]);

		const handle = await bootstrapControlPlaneForTest({
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

	test("neovim adapter accepts shared-secret ingress and returns structured interaction payload", async () => {
		const repoRoot = await mkRepoRoot();
		await linkNeovimIdentity(repoRoot, ["cp.read", "cp.issue.write"]);

		const handle = await bootstrapControlPlaneForTest({
			repoRoot,
			config: configWith({ neovimSecret: "neovim-secret" }),
			operatorBackend: new StaticOperatorBackend({
				kind: "respond",
				message: "Neovim operator response.",
			}),
		});
		expect(handle).not.toBeNull();
		if (!handle) {
			throw new Error("expected control plane handle");
		}
		handlesToCleanup.add(handle);

		const response = await handle.handleWebhook(
			"/webhooks/neovim",
			new Request("http://localhost/webhooks/neovim", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-mu-neovim-secret": "neovim-secret",
				},
				body: JSON.stringify({
					tenant_id: "workspace-1",
					conversation_id: "buffer:core/xx/src/runtime.zig",
					actor_id: "neovim-actor",
					text: "status",
					client_context: {
						file: "core/xx/src/runtime.zig",
						selection: "const x = y + 1;",
					},
				}),
			}),
		);
		expect(response).not.toBeNull();
		if (!response) {
			throw new Error("expected webhook response");
		}
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			accepted: boolean;
			ack: string;
			interaction: { payload?: Record<string, unknown> };
			result: { kind: string };
		};
		expect(payload.ok).toBe(true);
		expect(payload.accepted).toBe(true);
		expect(payload.result.kind).toBe("operator_response");
		expect(payload.ack.length).toBeGreaterThan(0);
		expect(payload.interaction.payload).toBeDefined();
		const interactionPayload = payload.interaction.payload ?? {};
		expect(typeof interactionPayload.message).toBe("string");
	});

	test("notifyOperators fans out across mixed bindings and skips unsupported/unconfigured channels deterministically", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.ops.admin"]);
		await linkDiscordIdentity(repoRoot, ["cp.ops.admin"]);
		await linkTelegramIdentity(repoRoot, ["cp.ops.admin"]);

		const handle = await bootstrapControlPlaneForTest({
			repoRoot,
			config: configWith({
				telegramSecret: "telegram-secret",
				telegramBotToken: null,
			}),
		});
		expect(handle).not.toBeNull();
		if (!handle) {
			throw new Error("expected control plane handle");
		}
		handlesToCleanup.add(handle);

		expect(typeof handle.notifyOperators).toBe("function");
		if (!handle.notifyOperators) {
			throw new Error("expected notifyOperators implementation");
		}
		const delivery = await handle.notifyOperators({
			message: "Wake: mixed-channel safety check",
			dedupeKey: "wake:mixed:1",
			wake: {
				wakeId: "wake-mixed-1",
				wakeSource: "heartbeat_program",
				programId: "hb-1",
				sourceTsMs: 11,
			},
		});

		expect(delivery.queued).toBe(0);
		expect(delivery.duplicate).toBe(0);
		expect(delivery.skipped).toBe(3);
		expect(delivery.decisions).toHaveLength(3);

		const byBinding = new Map(delivery.decisions.map((entry) => [entry.binding_id, entry]));
		expect(byBinding.get("binding-slack")?.state).toBe("skipped");
		expect(byBinding.get("binding-slack")?.reason_code).toBe("slack_bot_token_missing");
		expect(byBinding.get("binding-discord")?.state).toBe("skipped");
		expect(byBinding.get("binding-discord")?.reason_code).toBe("channel_delivery_unsupported");
		expect(byBinding.get("binding-telegram")?.state).toBe("skipped");
		expect(byBinding.get("binding-telegram")?.reason_code).toBe("telegram_bot_token_missing");
	});

	test("notifyOperators preserves wake dedupe/no-spam semantics per binding/channel", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.ops.admin"]);
		await linkDiscordIdentity(repoRoot, ["cp.ops.admin"]);
		await linkTelegramIdentity(repoRoot, ["cp.ops.admin"]);

		const telegramApiCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
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
			return await originalFetch(input as any, init);
		}) as typeof fetch;

		try {
			const handle = await bootstrapControlPlaneForTest({
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
			if (!handle.notifyOperators) {
				throw new Error("expected notifyOperators implementation");
			}

			const first = await handle.notifyOperators({
				message: "Wake: dedupe check",
				dedupeKey: "wake:dedupe:1",
				wake: {
					wakeId: "wake-dedupe-1",
					wakeSource: "cron_program",
					programId: "cron-1",
					sourceTsMs: 22,
				},
			});
			expect(first.queued).toBe(1);
			expect(first.duplicate).toBe(0);
			expect(first.skipped).toBe(2);
			const firstTelegram = first.decisions.find((entry) => entry.binding_id === "binding-telegram");
			expect(firstTelegram?.state).toBe("queued");
			expect(firstTelegram?.dedupe_key).toContain(":telegram:binding-telegram");
			if (!firstTelegram || !firstTelegram.dedupe_key) {
				throw new Error("expected first telegram dedupe key");
			}

			const second = await handle.notifyOperators({
				message: "Wake: dedupe check",
				dedupeKey: "wake:dedupe:1",
				wake: {
					wakeId: "wake-dedupe-1",
					wakeSource: "cron_program",
					programId: "cron-1",
					sourceTsMs: 22,
				},
			});
			expect(second.queued).toBe(0);
			expect(second.duplicate).toBe(1);
			expect(second.skipped).toBe(2);
			const secondTelegram = second.decisions.find((entry) => entry.binding_id === "binding-telegram");
			expect(secondTelegram?.state).toBe("duplicate");
			expect(secondTelegram?.outbox_id).toBe(firstTelegram?.outbox_id ?? null);

			for (let attempt = 0; attempt < 50 && telegramApiCalls.length === 0; attempt++) {
				await Bun.sleep(20);
			}
			expect(telegramApiCalls).toHaveLength(1);

			const outbox = new ControlPlaneOutbox(getControlPlanePaths(repoRoot).outboxPath);
			await outbox.load();
			const wakeRecords = outbox
				.records()
				.filter(
					(record) => record.envelope.metadata.wake_delivery === true && record.envelope.channel === "telegram",
				);
			expect(wakeRecords).toHaveLength(1);
			expect(wakeRecords[0]?.dedupe_key).toBe(firstTelegram.dedupe_key);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("Slack webhook chat messages route through operator for linked actors", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read"]);

		const backend = new StaticOperatorBackend({
			kind: "respond",
			message: "Hello from the messaging operator.",
		});
		const handle = await bootstrapControlPlaneForTest({
			repoRoot,
			config: configWith({ slackSecret: "slack-secret" }),
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
				triggerId: "chat-1",
			}),
		);
		expect(response).not.toBeNull();
		if (!response) {
			throw new Error("expected webhook response");
		}
		expect(response.status).toBe(200);

		const body = (await response.json()) as { text?: string };
		expect(body.text).toContain("Operator · CHAT · RESPONDED");
		expect(backend.turns).toBe(1);
	});

	test("Slack outbound delivery retries when bot token is missing", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read"]);

		const handle = await bootstrapControlPlaneForTest({
			repoRoot,
			config: configWith({ slackSecret: "slack-secret", slackBotToken: null }),
			operatorBackend: new StaticOperatorBackend({
				kind: "respond",
				message: "status response",
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
				text: "status",
				triggerId: "slack-no-token",
			}),
		);
		expect(response?.status).toBe(200);

		await Bun.sleep(150);
		const outbox = new ControlPlaneOutbox(getControlPlanePaths(repoRoot).outboxPath);
		await outbox.load();
		const dead = outbox.records({ state: "dead_letter" });
		expect(dead.length).toBe(0);
		const pending = outbox.records({ state: "pending" });
		expect(pending.length).toBeGreaterThan(0);
		expect(pending[0]?.last_error).toContain("slack bot token not configured");
	});

	test("Slack outbound delivery uploads media attachments via Slack Web API", async () => {
		const calls: Array<{ url: string; auth: string | null; threadTs?: string | null }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://artifact.test/report.pdf") {
				return new Response(new Uint8Array([37, 80, 68, 70, 45]), {
					status: 200,
					headers: { "content-type": "application/pdf" },
				});
			}
			if (url === "https://slack.com/api/files.upload") {
				const form = init?.body;
				calls.push({
					url,
					auth: new Headers(init?.headers).get("authorization"),
					threadTs: form instanceof FormData ? (form.get("thread_ts") as string | null) : null,
				});
				return new Response(JSON.stringify({ ok: true, file: { id: "F123" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "https://slack.com/api/chat.postMessage") {
				calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
				return new Response(JSON.stringify({ ok: true, ts: "1.23" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return await originalFetch(input as any, init);
		}) as typeof fetch;

		try {
			const result = await deliverSlackOutboxRecord({
				botToken: "xoxb-test-token",
				record: {
					outbox_id: "outbox-slack-media-1",
					dedupe_key: "slack-media-1",
					state: "pending",
					attempt_count: 0,
					next_attempt_at_ms: Date.now(),
					last_error: null,
					created_at_ms: Date.now(),
					updated_at_ms: Date.now(),
					max_attempts: 6,
					dead_letter_reason: null,
					replay_of_outbox_id: null,
					replay_requested_by_command_id: null,
					envelope: {
						v: 1,
						ts_ms: Date.now(),
						channel: "slack",
						channel_tenant_id: "team-1",
						channel_conversation_id: "chan-1",
						request_id: "req-media-1",
						response_id: "resp-media-1",
						kind: "result",
						body: "Here is your report",
						attachments: [
							{
								type: "document",
								filename: "report.pdf",
								mime_type: "application/pdf",
								size_bytes: 5,
								reference: { source: "artifact-store", url: "https://artifact.test/report.pdf" },
								metadata: {},
							},
						],
						correlation: {
							command_id: "cmd-media-1",
							idempotency_key: "idem-media-1",
							request_id: "req-media-1",
							channel: "slack",
							channel_tenant_id: "team-1",
							channel_conversation_id: "chan-1",
							actor_id: "slack-actor",
							actor_binding_id: "binding-slack",
							assurance_tier: "tier_a",
							repo_root: "/repo",
							scope_required: "cp.read",
							scope_effective: "cp.read",
							target_type: "status",
							target_id: "chan-1",
							attempt: 1,
							state: "completed",
							error_code: null,
							operator_session_id: null,
							operator_turn_id: null,
							cli_invocation_id: null,
							cli_command_kind: null,
						},
						metadata: { slack_thread_ts: "171.9900" },
					},
				},
			});

			expect(result.kind).toBe("delivered");
			expect(calls.some((entry) => entry.url.endsWith("/files.upload"))).toBe(true);
			expect(calls.some((entry) => entry.auth === "Bearer xoxb-test-token")).toBe(true);
			expect(calls.find((entry) => entry.url.endsWith("/files.upload"))?.threadTs).toBe("171.9900");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("Telegram webhook drains outbox immediately for low-latency delivery", async () => {
		const repoRoot = await mkRepoRoot();
		await linkTelegramIdentity(repoRoot, ["cp.read"]);

		const telegramApiCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
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
			return await originalFetch(input as any, init);
		}) as typeof fetch;

		try {
			const handle = await bootstrapControlPlaneForTest({
				repoRoot,
				config: configWith({
					telegramSecret: "telegram-secret",
					telegramBotToken: "telegram-token",
					operatorEnabled: false,
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
			expect(telegramApiCalls[0]?.body?.reply_to_message_id).toBe(101);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("Telegram deferred ingress returns typing ack before slow operator turn completes", async () => {
		const repoRoot = await mkRepoRoot();
		await linkTelegramIdentity(repoRoot, ["cp.read"]);

		const telegramApiCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
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
			return await originalFetch(input as any, init);
		}) as typeof fetch;

		try {
			const handle = await bootstrapControlPlaneForTest({
				repoRoot,
				config: configWith({
					telegramSecret: "telegram-secret",
					telegramBotToken: "telegram-token",
				}),
				operatorBackend: new DelayedOperatorBackend(250, {
					kind: "respond",
					message: "slow operator response",
				}),
			});
			expect(handle).not.toBeNull();
			if (!handle) {
				throw new Error("expected control plane handle");
			}
			handlesToCleanup.add(handle);

			const startedAtMs = Date.now();
			const response = await handle.handleWebhook(
				"/webhooks/telegram",
				telegramRequest({
					secret: "telegram-secret",
					updateId: 202,
					text: "hello operator",
				}),
			);
			const ackElapsedMs = Date.now() - startedAtMs;
			expect(response).not.toBeNull();
			if (!response) {
				throw new Error("expected webhook response");
			}
			expect(response.status).toBe(200);
			expect(ackElapsedMs).toBeLessThan(150);
			const ack = (await response.json()) as { method?: string; chat_id?: string; action?: string };
			expect(ack.method).toBe("sendChatAction");
			expect(ack.chat_id).toBe("tg-chat-1");
			expect(ack.action).toBe("typing");

			for (let attempt = 0; attempt < 80 && telegramApiCalls.length === 0; attempt++) {
				await Bun.sleep(10);
			}
			expect(telegramApiCalls.length).toBeGreaterThan(0);
			expect(telegramApiCalls[0]?.body?.text).toContain("slow operator response");
			expect(telegramApiCalls[0]?.body?.reply_to_message_id).toBe(202);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("Telegram deferred ingress still delivers denied responses through outbox", async () => {
		const repoRoot = await mkRepoRoot();
		const telegramApiCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
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
			return await originalFetch(input as any, init);
		}) as typeof fetch;

		try {
			const handle = await bootstrapControlPlaneForTest({
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
					updateId: 303,
					text: "/mu status",
				}),
			);
			expect(response).not.toBeNull();
			if (!response) {
				throw new Error("expected webhook response");
			}
			const ack = (await response.json()) as { method?: string; chat_id?: string; action?: string };
			expect(ack.method).toBe("sendChatAction");
			expect(ack.chat_id).toBe("tg-chat-1");
			expect(ack.action).toBe("typing");

			for (let attempt = 0; attempt < 80 && telegramApiCalls.length === 0; attempt++) {
				await Bun.sleep(10);
			}
			expect(telegramApiCalls.length).toBeGreaterThan(0);
			expect(telegramApiCalls[0]?.body?.text).toContain("ERROR · DENIED");
			expect(telegramApiCalls[0]?.body?.text).toContain("identity_not_linked");
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

		const handle = await bootstrapControlPlaneForTest({
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
		expect(body.text).toContain("operator_unavailable");
		expect(body.text).not.toContain("Operator · CHAT");
		expect(backend.turns).toBe(0);
	});

	test("unsupported operator command proposals degrade to safe backend-error responses", async () => {
		const repoRoot = await mkRepoRoot();
		await linkTelegramIdentity(repoRoot, ["cp.read"]);

		const handle = await bootstrapControlPlaneForTest({
			repoRoot,
			config: configWith({
				telegramSecret: "telegram-secret",
			}),
			operatorBackend: new StaticOperatorBackend({
				kind: "command",
				command: { kind: "unsupported_action", payload: "mu-root-1234" },
			} as unknown as OperatorBackendTurnResult),
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
				updateId: 404,
				text: "please do that unsupported action",
			}),
		);
		expect(response).not.toBeNull();
		if (!response) {
			throw new Error("expected webhook response");
		}
		expect(response.status).toBe(200);
		const body = (await response.json()) as { method?: string; chat_id?: string; action?: string };
		expect(body.method).toBe("sendChatAction");
		expect(body.chat_id).toBe("tg-chat-1");

		const outbox = new ControlPlaneOutbox(getControlPlanePaths(repoRoot).outboxPath);
		let responseBody = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			await outbox.load();
			const record = outbox.records().find((entry) => entry.envelope.channel === "telegram");
			if (typeof record?.envelope.body === "string" && record.envelope.body.length > 0) {
				responseBody = record.envelope.body;
				break;
			}
			await Bun.sleep(10);
		}
		expect(responseBody).toContain("operator_backend_error");
	});

	test("freeform slack text without operator routing is deterministically denied as operator unavailable", async () => {
		const repoRoot = await mkRepoRoot();
		await linkSlackIdentity(repoRoot, ["cp.read"]);

		const handle = await bootstrapControlPlaneForTest({
			repoRoot,
			config: configWith({ slackSecret: "slack-secret", operatorEnabled: false }),
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
				text: "please do this workflow action now",
				triggerId: "slack-freeform-ignored",
			}),
		);
		expect(response).not.toBeNull();
		if (!response) {
			throw new Error("expected webhook response");
		}
		expect(response.status).toBe(200);
		const ignoredBody = (await response.json()) as { text?: string };
		expect(ignoredBody.text).toContain("DENIED");
		expect(ignoredBody.text).toContain("operator_unavailable");

	});

	test("bootstrap cleanup releases writer lock when startup fails", async () => {
		const repoRoot = await mkRepoRoot();
		const paths = getControlPlanePaths(repoRoot);
		const identitiesPath = paths.identitiesPath;
		await mkdir(identitiesPath, { recursive: true });

		await expect(
			bootstrapControlPlaneForTest({
				repoRoot,
				config: configWith({
					slackSecret: "slack-secret",
				}),
			}),
		).rejects.toThrow();

		const writerLockPath = paths.writerLockPath;
		expect(await Bun.file(writerLockPath).exists()).toBe(false);
	});
});
