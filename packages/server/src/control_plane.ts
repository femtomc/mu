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
	await runtime.start();

	const operator =
		opts.operatorRuntime !== undefined
			? opts.operatorRuntime
			: buildMessagingOperatorRuntime({
					repoRoot: opts.repoRoot,
					config: controlPlaneConfig,
					backend: opts.operatorBackend,
				});

	const pipeline = new ControlPlaneCommandPipeline({ runtime, operator });
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

			const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: envelope.channel_conversation_id,
					text: envelope.body,
				}),
			});

			if (res.ok) {
				return { kind: "delivered" };
			}
			if (res.status === 429 || res.status >= 500) {
				const retryAfter = res.headers.get("retry-after");
				const retryDelayMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : undefined;
				return {
					kind: "retry",
					error: `telegram sendMessage ${res.status}: ${await res.text().catch(() => "")}`,
					retryDelayMs: retryDelayMs && Number.isFinite(retryDelayMs) ? retryDelayMs : undefined,
				};
			}

			return {
				kind: "retry",
				error: `telegram sendMessage ${res.status}: ${await res.text().catch(() => "")}`,
			};
		}

		return undefined;
	};

	const dispatcher = new ControlPlaneOutboxDispatcher({ outbox, deliver });

	const drainInterval = setInterval(async () => {
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
			clearInterval(drainInterval);
			await pipeline.stop();
		},
	};
}
