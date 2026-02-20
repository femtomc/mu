import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MU_CONFIG, type MuConfig } from "../src/config.js";
import {
	bootstrapControlPlane,
	type BootstrapControlPlaneOpts,
	type ControlPlaneHandle,
	type ControlPlaneSessionLifecycle,
	type TelegramGenerationSwapHooks,
} from "../src/control_plane.js";
import { composeServerRuntime, createServerFromRuntime } from "../src/server.js";

const dirsToCleanup = new Set<string>();
const stopFns = new Set<() => Promise<void>>();

afterEach(async () => {
	for (const stop of stopFns) {
		await stop().catch(() => {});
	}
	stopFns.clear();
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

async function createServerForTest(opts: {
	repoRoot: string;
	controlPlane: ControlPlaneHandle;
	serverOptions?: Parameters<typeof createServerFromRuntime>[1];
}) {
	const runtime = await composeServerRuntime({
		repoRoot: opts.repoRoot,
		controlPlane: opts.controlPlane,
	});
	const server = createServerFromRuntime(runtime, opts.serverOptions);
	stopFns.add(async () => {
		await server.controlPlane?.stop?.();
	});
	return server;
}

async function mkRepoRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mu-server-telegram-generation-"));
	dirsToCleanup.add(root);
	await mkdir(join(root, ".mu"), { recursive: true });
	await Bun.write(join(root, ".mu", "issues.jsonl"), "");
	await Bun.write(join(root, ".mu", "forum.jsonl"), "");
	await Bun.write(join(root, ".mu", "events.jsonl"), "");
	return root;
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
	return new Request("http://localhost/webhooks/telegram", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": opts.secret,
		},
		body: JSON.stringify(payload),
	});
}

function reloadRequest(reason: string): Request {
	return new Request("http://localhost/api/control-plane/reload", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ reason }),
	});
}

function rollbackRequest(): Request {
	return new Request("http://localhost/api/control-plane/rollback", {
		method: "POST",
	});
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function configWithTelegram(opts: { secret: string; botToken: string; botUsername?: string | null }): MuConfig {
	const next = JSON.parse(JSON.stringify(DEFAULT_MU_CONFIG)) as MuConfig;
	next.control_plane.adapters.telegram.webhook_secret = opts.secret;
	next.control_plane.adapters.telegram.bot_token = opts.botToken;
	next.control_plane.adapters.telegram.bot_username = opts.botUsername ?? null;
	next.control_plane.adapters.slack.signing_secret = null;
	next.control_plane.adapters.discord.signing_secret = null;
	return next;
}

describe("telegram blue/green generation reload", () => {
	test("dual-generation overlap keeps /webhooks/telegram live during drain", async () => {
		const repoRoot = await mkRepoRoot();
		let config = configWithTelegram({
			secret: "telegram-secret-v1",
			botToken: "telegram-token-v1",
			botUsername: "mu_bot",
		});
		const drainStarted = deferred<void>();
		const releaseDrain = deferred<void>();
		const hooks: TelegramGenerationSwapHooks = {
			onDrain: async () => {
				drainStarted.resolve(undefined);
				await releaseDrain.promise;
			},
		};

		const controlPlane = await bootstrapControlPlaneForTest({
			repoRoot,
			config: config.control_plane,
			telegramGenerationHooks: hooks,
		});
		expect(controlPlane).not.toBeNull();
		if (!controlPlane) {
			throw new Error("expected control plane");
		}
		stopFns.add(async () => await controlPlane.stop());

		const server = await createServerForTest({
			repoRoot,
			controlPlane,
			serverOptions: {
				configReader: async () => config,
			},
		});

		config = configWithTelegram({
			secret: "telegram-secret-v2",
			botToken: "telegram-token-v2",
			botUsername: "mu_bot_v2",
		});

		const reload = server.fetch(reloadRequest("telegram_overlap"));
		await drainStarted.promise;

		const webhook = await server.fetch(
			telegramRequest({
				secret: "telegram-secret-v2",
				updateId: 501,
				text: "/mu status",
			}),
		);
		expect(webhook.status).toBe(200);
		const ack = (await webhook.json()) as { method?: string; action?: string };
		expect(ack.method).toBe("sendChatAction");
		expect(ack.action).toBe("typing");

		releaseDrain.resolve(undefined);
		const reloadResponse = await reload;
		expect(reloadResponse.status).toBe(200);
		const payload = (await reloadResponse.json()) as {
			ok: boolean;
			telegram_generation?: {
				handled: boolean;
				ok: boolean;
				drain: { forced_stop: boolean } | null;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.telegram_generation?.handled).toBe(true);
		expect(payload.telegram_generation?.ok).toBe(true);
		expect(payload.telegram_generation?.drain?.forced_stop).toBe(false);
	});

	test("warmup and cutover failures surface rollback triggers", async () => {
		const repoRoot = await mkRepoRoot();
		let config = configWithTelegram({
			secret: "telegram-secret-v1",
			botToken: "telegram-token-v1",
		});
		const hooks: TelegramGenerationSwapHooks = {
			onWarmup: async (ctx) => {
				if (ctx.reason === "warmup_fail") {
					throw new Error("warmup exploded");
				}
			},
			onCutover: async (ctx) => {
				if (ctx.reason === "cutover_fail") {
					throw new Error("cutover exploded");
				}
			},
		};

		const controlPlane = await bootstrapControlPlaneForTest({
			repoRoot,
			config: config.control_plane,
			telegramGenerationHooks: hooks,
		});
		expect(controlPlane).not.toBeNull();
		if (!controlPlane) {
			throw new Error("expected control plane");
		}
		stopFns.add(async () => await controlPlane.stop());

		const server = await createServerForTest({
			repoRoot,
			controlPlane,
			serverOptions: {
				configReader: async () => config,
			},
		});

		config = configWithTelegram({
			secret: "telegram-secret-v2",
			botToken: "telegram-token-v2",
		});

		const warmupFailure = await server.fetch(reloadRequest("warmup_fail"));
		expect(warmupFailure.status).toBe(500);
		const warmupPayload = (await warmupFailure.json()) as {
			ok: boolean;
			telegram_generation?: {
				rollback: { trigger: string | null };
			};
		};
		expect(warmupPayload.ok).toBe(false);
		expect(warmupPayload.telegram_generation?.rollback.trigger).toBe("warmup_failed");

		const cutoverFailure = await server.fetch(reloadRequest("cutover_fail"));
		expect(cutoverFailure.status).toBe(500);
		const cutoverPayload = (await cutoverFailure.json()) as {
			ok: boolean;
			telegram_generation?: {
				rollback: { trigger: string | null; attempted: boolean };
			};
		};
		expect(cutoverPayload.ok).toBe(false);
		expect(cutoverPayload.telegram_generation?.rollback.trigger).toBe("cutover_failed");
		expect(cutoverPayload.telegram_generation?.rollback.attempted).toBe(true);
	});

	test("drain failure forces stop but keeps cutover successful", async () => {
		const repoRoot = await mkRepoRoot();
		let config = configWithTelegram({
			secret: "telegram-secret-v1",
			botToken: "telegram-token-v1",
		});
		const hooks: TelegramGenerationSwapHooks = {
			onDrain: async (ctx) => {
				if (ctx.reason === "drain_fail") {
					throw new Error("drain exploded");
				}
			},
		};

		const controlPlane = await bootstrapControlPlaneForTest({
			repoRoot,
			config: config.control_plane,
			telegramGenerationHooks: hooks,
		});
		expect(controlPlane).not.toBeNull();
		if (!controlPlane) {
			throw new Error("expected control plane");
		}
		stopFns.add(async () => await controlPlane.stop());

		const server = await createServerForTest({
			repoRoot,
			controlPlane,
			serverOptions: {
				configReader: async () => config,
			},
		});

		config = configWithTelegram({
			secret: "telegram-secret-v2",
			botToken: "telegram-token-v2",
		});

		const response = await server.fetch(reloadRequest("drain_fail"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			telegram_generation?: {
				drain: {
					ok: boolean;
					forced_stop: boolean;
				};
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.telegram_generation?.drain?.ok).toBe(false);
		expect(payload.telegram_generation?.drain?.forced_stop).toBe(true);
	});

	test("one-command rollback endpoint reverts telegram generation", async () => {
		const repoRoot = await mkRepoRoot();
		let config = configWithTelegram({
			secret: "telegram-secret-v1",
			botToken: "telegram-token-v1",
		});

		const controlPlane = await bootstrapControlPlaneForTest({
			repoRoot,
			config: config.control_plane,
		});
		expect(controlPlane).not.toBeNull();
		if (!controlPlane) {
			throw new Error("expected control plane");
		}
		stopFns.add(async () => await controlPlane.stop());

		const server = await createServerForTest({
			repoRoot,
			controlPlane,
			serverOptions: {
				configReader: async () => config,
			},
		});

		config = configWithTelegram({
			secret: "telegram-secret-v2",
			botToken: "telegram-token-v2",
		});
		const firstReload = await server.fetch(reloadRequest("telegram_upgrade"));
		expect(firstReload.status).toBe(200);

		const rollback = await server.fetch(rollbackRequest());
		expect(rollback.status).toBe(200);
		const payload = (await rollback.json()) as {
			ok: boolean;
			reason: string;
			telegram_generation?: {
				rollback: { requested: boolean; trigger: string | null };
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.reason).toBe("rollback");
		expect(payload.telegram_generation?.rollback.requested).toBe(true);
		expect(payload.telegram_generation?.rollback.trigger).toBe("manual");

		const webhook = await server.fetch(
			telegramRequest({
				secret: "telegram-secret-v1",
				updateId: 900,
				text: "/mu status",
			}),
		);
		expect(webhook.status).toBe(200);
	});
});
