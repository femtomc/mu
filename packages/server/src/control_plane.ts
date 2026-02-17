import {
	ApprovedCommandBroker,
	CommandContextResolver,
	type MessagingOperatorBackend,
	MessagingOperatorRuntime,
	PiMessagingOperatorBackend,
	serveExtensionPaths,
} from "@femtomc/mu-agent";
import {
	type Channel,
	type ControlPlaneAdapter,
	ControlPlaneCommandPipeline,
	ControlPlaneOutbox,
	ControlPlaneOutboxDispatcher,
	ControlPlaneRuntime,
	DiscordControlPlaneAdapter,
	getControlPlanePaths,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
	SlackControlPlaneAdapter,
	TelegramControlPlaneAdapter,
} from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG, type MuConfig } from "./config.js";

export type ActiveAdapter = {
	name: Channel;
	route: string;
};

export type ControlPlaneHandle = {
	activeAdapters: ActiveAdapter[];
	handleWebhook(path: string, req: Request): Promise<Response | null>;
	stop(): Promise<void>;
};

export type ControlPlaneConfig = MuConfig["control_plane"];

type DetectedAdapter =
	| { name: "slack"; signingSecret: string }
	| { name: "discord"; signingSecret: string }
	| {
			name: "telegram";
			webhookSecret: string;
			botToken: string | null;
			botUsername: string | null;
	  };

export function detectAdapters(config: ControlPlaneConfig): DetectedAdapter[] {
	const adapters: DetectedAdapter[] = [];

	const slackSecret = config.adapters.slack.signing_secret;
	if (slackSecret) {
		adapters.push({ name: "slack", signingSecret: slackSecret });
	}

	const discordSecret = config.adapters.discord.signing_secret;
	if (discordSecret) {
		adapters.push({ name: "discord", signingSecret: discordSecret });
	}

	const telegramSecret = config.adapters.telegram.webhook_secret;
	if (telegramSecret) {
		adapters.push({
			name: "telegram",
			webhookSecret: telegramSecret,
			botToken: config.adapters.telegram.bot_token,
			botUsername: config.adapters.telegram.bot_username,
		});
	}

	return adapters;
}

export type TelegramSendMessagePayload = {
	chat_id: string;
	text: string;
	parse_mode?: "Markdown";
	disable_web_page_preview?: boolean;
};

/**
 * Telegram supports a markdown dialect that uses single markers for emphasis.
 * Normalize the most common LLM/GitHub-style markers (`**bold**`, `__italic__`, headings)
 * while preserving fenced code blocks verbatim.
 */
export function renderTelegramMarkdown(text: string): string {
	const normalized = text.replaceAll("\r\n", "\n");
	const lines = normalized.split("\n");
	const out: string[] = [];
	let inFence = false;

	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		let next = line;
		next = next.replace(/^#{1,6}\s+(.+)$/, "*$1*");
		next = next.replace(/\*\*(.+?)\*\*/g, "*$1*");
		next = next.replace(/__(.+?)__/g, "_$1_");
		out.push(next);
	}

	return out.join("\n");
}

export function buildTelegramSendMessagePayload(opts: {
	chatId: string;
	text: string;
	richFormatting: boolean;
}): TelegramSendMessagePayload {
	if (!opts.richFormatting) {
		return {
			chat_id: opts.chatId,
			text: opts.text,
		};
	}

	return {
		chat_id: opts.chatId,
		text: renderTelegramMarkdown(opts.text),
		parse_mode: "Markdown",
		disable_web_page_preview: true,
	};
}

async function postTelegramMessage(botToken: string, payload: TelegramSendMessagePayload): Promise<Response> {
	return await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

function buildMessagingOperatorRuntime(opts: {
	repoRoot: string;
	config: ControlPlaneConfig;
	backend?: MessagingOperatorBackend;
}): MessagingOperatorRuntime | null {
	if (!opts.config.operator.enabled) {
		return null;
	}

	const backend =
		opts.backend ??
		new PiMessagingOperatorBackend({
			provider: opts.config.operator.provider ?? undefined,
			model: opts.config.operator.model ?? undefined,
			extensionPaths: serveExtensionPaths,
		});

	return new MessagingOperatorRuntime({
		backend,
		broker: new ApprovedCommandBroker({
			runTriggersEnabled: opts.config.operator.run_triggers_enabled,
			contextResolver: new CommandContextResolver({ allowedRepoRoots: [opts.repoRoot] }),
		}),
		enabled: true,
	});
}

export type BootstrapControlPlaneOpts = {
	repoRoot: string;
	config?: ControlPlaneConfig;
	operatorRuntime?: MessagingOperatorRuntime | null;
	operatorBackend?: MessagingOperatorBackend;
};

export async function bootstrapControlPlane(opts: BootstrapControlPlaneOpts): Promise<ControlPlaneHandle | null> {
	const controlPlaneConfig = opts.config ?? DEFAULT_MU_CONFIG.control_plane;
	const detected = detectAdapters(controlPlaneConfig);

	if (detected.length === 0) {
		return null;
	}

	const paths = getControlPlanePaths(opts.repoRoot);

	const runtime = new ControlPlaneRuntime({ repoRoot: opts.repoRoot });
	let pipeline: ControlPlaneCommandPipeline | null = null;
	let drainInterval: ReturnType<typeof setInterval> | null = null;

	try {
		await runtime.start();

		const operator =
			opts.operatorRuntime !== undefined
				? opts.operatorRuntime
				: buildMessagingOperatorRuntime({
						repoRoot: opts.repoRoot,
						config: controlPlaneConfig,
						backend: opts.operatorBackend,
					});

		pipeline = new ControlPlaneCommandPipeline({ runtime, operator });
		await pipeline.start();

		const outbox = new ControlPlaneOutbox(paths.outboxPath);
		await outbox.load();

		let telegramBotToken: string | null = null;
		const adapterMap = new Map<string, { adapter: ControlPlaneAdapter; info: ActiveAdapter }>();

		for (const d of detected) {
			let adapter: ControlPlaneAdapter;

			switch (d.name) {
				case "slack":
					adapter = new SlackControlPlaneAdapter({
						pipeline,
						outbox,
						signingSecret: d.signingSecret,
					});
					break;
				case "discord":
					adapter = new DiscordControlPlaneAdapter({
						pipeline,
						outbox,
						signingSecret: d.signingSecret,
					});
					break;
				case "telegram":
					adapter = new TelegramControlPlaneAdapter({
						pipeline,
						outbox,
						webhookSecret: d.webhookSecret,
						botUsername: d.botUsername ?? undefined,
					});
					if (d.botToken) {
						telegramBotToken = d.botToken;
					}
					break;
			}

			const route = adapter.spec.route;
			if (adapterMap.has(route)) {
				throw new Error(`duplicate control-plane webhook route: ${route}`);
			}
			adapterMap.set(route, {
				adapter,
				info: {
					name: adapter.spec.channel,
					route,
				},
			});
		}

		const deliver = async (record: OutboxRecord): Promise<undefined | OutboxDeliveryHandlerResult> => {
			const { envelope } = record;

			if (envelope.channel === "telegram") {
				if (!telegramBotToken) {
					return { kind: "retry", error: "telegram bot token not configured in .mu/config.json" };
				}

				const richPayload = buildTelegramSendMessagePayload({
					chatId: envelope.channel_conversation_id,
					text: envelope.body,
					richFormatting: true,
				});
				let res = await postTelegramMessage(telegramBotToken, richPayload);

				// Fallback: if Telegram rejects markdown entities, retry as plain text.
				if (!res.ok && res.status === 400 && richPayload.parse_mode) {
					const plainPayload = buildTelegramSendMessagePayload({
						chatId: envelope.channel_conversation_id,
						text: envelope.body,
						richFormatting: false,
					});
					res = await postTelegramMessage(telegramBotToken, plainPayload);
				}

				if (res.ok) {
					return { kind: "delivered" };
				}

				const responseBody = await res.text().catch(() => "");
				if (res.status === 429 || res.status >= 500) {
					const retryAfter = res.headers.get("retry-after");
					const retryDelayMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : undefined;
					return {
						kind: "retry",
						error: `telegram sendMessage ${res.status}: ${responseBody}`,
						retryDelayMs: retryDelayMs && Number.isFinite(retryDelayMs) ? retryDelayMs : undefined,
					};
				}

				return {
					kind: "retry",
					error: `telegram sendMessage ${res.status}: ${responseBody}`,
				};
			}

			return undefined;
		};

		const dispatcher = new ControlPlaneOutboxDispatcher({ outbox, deliver });

		drainInterval = setInterval(async () => {
			try {
				await dispatcher.drainDue();
			} catch {
				// Swallow errors — the dispatcher already handles retries internally.
			}
		}, 2_000);

		return {
			activeAdapters: [...adapterMap.values()].map((v) => v.info),

			async handleWebhook(path: string, req: Request): Promise<Response | null> {
				const entry = adapterMap.get(path);
				if (!entry) return null;
				const result = await entry.adapter.ingest(req);
				return result.response;
			},

			async stop(): Promise<void> {
				if (drainInterval) {
					clearInterval(drainInterval);
					drainInterval = null;
				}
				try {
					await pipeline?.stop();
				} finally {
					await runtime.stop();
				}
			},
		};
	} catch (err) {
		if (drainInterval) {
			clearInterval(drainInterval);
			drainInterval = null;
		}
		try {
			await pipeline?.stop();
		} catch {
			// Best effort cleanup.
		}
		try {
			await runtime.stop();
		} catch {
			// Best effort cleanup.
		}
		throw err;
	}
}
