import {
	ApprovedCommandBroker,
	CommandContextResolver,
	type MessagingOperatorBackend,
	MessagingOperatorRuntime,
	PiMessagingOperatorBackend,
	operatorExtensionPaths,
} from "@femtomc/mu-agent";
import {
	type Channel,
	type CommandRecord,
	type ControlPlaneAdapter,
	ControlPlaneCommandPipeline,
	ControlPlaneOutbox,
	ControlPlaneOutboxDispatcher,
	correlationFromCommandRecord,
	ControlPlaneRuntime,
	DiscordControlPlaneAdapter,
	getControlPlanePaths,
	type MutationCommandExecutionResult,
	type OutboundEnvelope,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
	SlackControlPlaneAdapter,
	TelegramControlPlaneAdapter,
} from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG, type MuConfig } from "./config.js";
import {
	ControlPlaneRunSupervisor,
	type ControlPlaneRunEvent,
	type ControlPlaneRunHeartbeatResult,
	type ControlPlaneRunInterruptResult,
	type ControlPlaneRunSnapshot,
	type ControlPlaneRunStatus,
	type ControlPlaneRunTrace,
} from "./run_supervisor.js";
import type { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";

export type ActiveAdapter = {
	name: Channel;
	route: string;
};

export type ControlPlaneHandle = {
	activeAdapters: ActiveAdapter[];
	handleWebhook(path: string, req: Request): Promise<Response | null>;
	listRuns?(opts?: { status?: string; limit?: number }): Promise<ControlPlaneRunSnapshot[]>;
	getRun?(idOrRoot: string): Promise<ControlPlaneRunSnapshot | null>;
	startRun?(opts: { prompt: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot>;
	resumeRun?(opts: { rootIssueId: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot>;
	interruptRun?(opts: { jobId?: string | null; rootIssueId?: string | null }): Promise<ControlPlaneRunInterruptResult>;
	heartbeatRun?(opts: {
		jobId?: string | null;
		rootIssueId?: string | null;
		reason?: string | null;
	}): Promise<ControlPlaneRunHeartbeatResult>;
	traceRun?(opts: { idOrRoot: string; limit?: number }): Promise<ControlPlaneRunTrace | null>;
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

function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

function outboxKindForRunEvent(kind: ControlPlaneRunEvent["kind"]): OutboundEnvelope["kind"] {
	switch (kind) {
		case "run_completed":
			return "result";
		case "run_failed":
			return "error";
		default:
			return "lifecycle";
	}
}

async function enqueueRunEventOutbox(opts: {
	outbox: ControlPlaneOutbox;
	event: ControlPlaneRunEvent;
	nowMs: number;
}): Promise<OutboxRecord | null> {
	const command = opts.event.command;
	if (!command) {
		return null;
	}

	const baseCorrelation = correlationFromCommandRecord(command);
	const correlation = {
		...baseCorrelation,
		run_root_id: opts.event.run.root_issue_id ?? baseCorrelation.run_root_id,
	};
	const envelope: OutboundEnvelope = {
		v: 1,
		ts_ms: opts.nowMs,
		channel: command.channel,
		channel_tenant_id: command.channel_tenant_id,
		channel_conversation_id: command.channel_conversation_id,
		request_id: command.request_id,
		response_id: `resp-${sha256Hex(`run-event:${opts.event.run.job_id}:${opts.event.seq}:${opts.nowMs}`).slice(0, 20)}`,
		kind: outboxKindForRunEvent(opts.event.kind),
		body: opts.event.message,
		correlation,
		metadata: {
			async_run: true,
			run_event_kind: opts.event.kind,
			run_event_seq: opts.event.seq,
			run: opts.event.run,
		},
	};

	const decision = await opts.outbox.enqueue({
		dedupeKey: `run-event:${opts.event.run.job_id}:${opts.event.seq}`,
		envelope,
		nowMs: opts.nowMs,
		maxAttempts: 6,
	});
	return decision.record;
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

const TELEGRAM_MATH_PATTERNS: readonly RegExp[] = [
	/\$\$[\s\S]+?\$\$/m,
	/(^|[^\\])\$[^$\n]+\$/m,
	/\\\([\s\S]+?\\\)/m,
	/\\\[[\s\S]+?\\\]/m,
];

export function containsTelegramMathNotation(text: string): boolean {
	if (text.trim().length === 0) {
		return false;
	}
	return TELEGRAM_MATH_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildTelegramSendMessagePayload(opts: {
	chatId: string;
	text: string;
	richFormatting: boolean;
}): TelegramSendMessagePayload {
	if (!opts.richFormatting || containsTelegramMathNotation(opts.text)) {
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

const OUTBOX_DRAIN_INTERVAL_MS = 500;

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
			extensionPaths: operatorExtensionPaths,
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
	heartbeatScheduler?: ActivityHeartbeatScheduler;
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
	let runSupervisor: ControlPlaneRunSupervisor | null = null;
	let drainInterval: ReturnType<typeof setInterval> | null = null;
	const adapterMap = new Map<string, { adapter: ControlPlaneAdapter; info: ActiveAdapter }>();

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

		const outbox = new ControlPlaneOutbox(paths.outboxPath);
		await outbox.load();

		let scheduleOutboxDrainRef: (() => void) | null = null;
		runSupervisor = new ControlPlaneRunSupervisor({
			repoRoot: opts.repoRoot,
			heartbeatScheduler: opts.heartbeatScheduler,
			onEvent: async (event) => {
				const outboxRecord = await enqueueRunEventOutbox({
					outbox,
					event,
					nowMs: Math.trunc(Date.now()),
				});
				if (outboxRecord) {
					scheduleOutboxDrainRef?.();
				}
			},
		});

		pipeline = new ControlPlaneCommandPipeline({
			runtime,
			operator,
			mutationExecutor: async (record): Promise<MutationCommandExecutionResult | null> => {
				if (record.target_type === "run start" || record.target_type === "run resume") {
					try {
						const launched = await runSupervisor?.startFromCommand(record);
						if (!launched) {
							return null;
						}
						return {
							terminalState: "completed",
							result: {
								ok: true,
								async_run: true,
								run_job_id: launched.job_id,
								run_root_id: launched.root_issue_id,
								run_status: launched.status,
								run_mode: launched.mode,
								run_source: launched.source,
							},
							trace: {
								cliCommandKind: launched.mode,
								runRootId: launched.root_issue_id,
							},
							mutatingEvents: [
								{
									eventType: "run.supervisor.start",
									payload: {
										run_job_id: launched.job_id,
										run_mode: launched.mode,
										run_root_id: launched.root_issue_id,
										run_source: launched.source,
									},
								},
							],
						};
					} catch (err) {
						return {
							terminalState: "failed",
							errorCode: err instanceof Error && err.message ? err.message : "run_supervisor_start_failed",
							trace: {
								cliCommandKind: record.target_type.replaceAll(" ", "_"),
								runRootId: record.target_id,
							},
						};
					}
				}

				if (record.target_type === "run interrupt") {
					const result = runSupervisor?.interrupt({
						rootIssueId: record.target_id,
					}) ?? { ok: false, reason: "not_found", run: null };

					if (!result.ok) {
						return {
							terminalState: "failed",
							errorCode: result.reason ?? "run_interrupt_failed",
							trace: {
								cliCommandKind: "run_interrupt",
								runRootId: result.run?.root_issue_id ?? record.target_id,
							},
							mutatingEvents: [
								{
									eventType: "run.supervisor.interrupt.failed",
									payload: {
										reason: result.reason,
										target: record.target_id,
									},
								},
							],
						};
					}

					return {
						terminalState: "completed",
						result: {
							ok: true,
							async_run: true,
							interrupted: true,
							run: result.run,
						},
						trace: {
							cliCommandKind: "run_interrupt",
							runRootId: result.run?.root_issue_id ?? record.target_id,
						},
						mutatingEvents: [
							{
								eventType: "run.supervisor.interrupt",
								payload: {
									target: record.target_id,
									run: result.run,
								},
							},
						],
					};
				}

				return null;
			},
		});
		await pipeline.start();

		let telegramBotToken: string | null = null;

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
						deferredIngress: true,
						onOutboxEnqueued: () => {
							scheduleOutboxDrainRef?.();
						},
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

		let drainingOutbox = false;
		let drainRequested = false;

		const drainOutboxNow = async (): Promise<void> => {
			if (drainingOutbox) {
				drainRequested = true;
				return;
			}
			drainingOutbox = true;
			try {
				do {
					drainRequested = false;
					await dispatcher.drainDue();
				} while (drainRequested);
			} catch {
				// Swallow errors — the dispatcher handles retries internally.
			} finally {
				drainingOutbox = false;
			}
		};

		const scheduleOutboxDrain = (): void => {
			queueMicrotask(() => {
				void drainOutboxNow();
			});
		};
		scheduleOutboxDrainRef = scheduleOutboxDrain;

		drainInterval = setInterval(() => {
			scheduleOutboxDrain();
		}, OUTBOX_DRAIN_INTERVAL_MS);
		scheduleOutboxDrain();

		return {
			activeAdapters: [...adapterMap.values()].map((v) => v.info),

			async handleWebhook(path: string, req: Request): Promise<Response | null> {
				const entry = adapterMap.get(path);
				if (!entry) return null;
				const result = await entry.adapter.ingest(req);
				if (result.outboxRecord) {
					scheduleOutboxDrain();
				}
				return result.response;
			},

			async listRuns(opts = {}): Promise<ControlPlaneRunSnapshot[]> {
				return (
					runSupervisor?.list({
						status: opts.status as ControlPlaneRunStatus | undefined,
						limit: opts.limit,
					}) ?? []
				);
			},

			async getRun(idOrRoot: string): Promise<ControlPlaneRunSnapshot | null> {
				return runSupervisor?.get(idOrRoot) ?? null;
			},

			async startRun(startOpts: { prompt: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot> {
				const run = await runSupervisor?.launchStart({
					prompt: startOpts.prompt,
					maxSteps: startOpts.maxSteps,
					source: "api",
				});
				if (!run) {
					throw new Error("run_supervisor_unavailable");
				}
				return run;
			},

			async resumeRun(resumeOpts: { rootIssueId: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot> {
				const run = await runSupervisor?.launchResume({
					rootIssueId: resumeOpts.rootIssueId,
					maxSteps: resumeOpts.maxSteps,
					source: "api",
				});
				if (!run) {
					throw new Error("run_supervisor_unavailable");
				}
				return run;
			},

			async interruptRun(interruptOpts): Promise<ControlPlaneRunInterruptResult> {
				return runSupervisor?.interrupt(interruptOpts) ?? { ok: false, reason: "not_found", run: null };
			},

			async heartbeatRun(heartbeatOpts): Promise<ControlPlaneRunHeartbeatResult> {
				return runSupervisor?.heartbeat(heartbeatOpts) ?? { ok: false, reason: "not_found", run: null };
			},

			async traceRun(traceOpts: { idOrRoot: string; limit?: number }): Promise<ControlPlaneRunTrace | null> {
				return (await runSupervisor?.trace(traceOpts.idOrRoot, { limit: traceOpts.limit })) ?? null;
			},

			async stop(): Promise<void> {
				if (drainInterval) {
					clearInterval(drainInterval);
					drainInterval = null;
				}
				for (const { adapter } of adapterMap.values()) {
					try {
						await adapter.stop?.();
					} catch {
						// Best effort adapter cleanup.
					}
				}
				await runSupervisor?.stop();
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
		for (const { adapter } of adapterMap.values()) {
			try {
				await adapter.stop?.();
			} catch {
				// Best effort cleanup.
			}
		}
		try {
			await runSupervisor?.stop();
		} catch {
			// Best effort cleanup.
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
