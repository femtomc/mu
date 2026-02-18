import type { MessagingOperatorBackend, MessagingOperatorRuntime } from "@femtomc/mu-agent";
import {
	type AdapterIngressResult,
	type CommandPipelineResult,
	type ControlPlaneAdapter,
	ControlPlaneCommandPipeline,
	ControlPlaneOutbox,
	ControlPlaneRuntime,
	type ControlPlaneSignalObserver,
	DiscordControlPlaneAdapter,
	type GenerationTelemetryRecorder,
	getControlPlanePaths,
	type MutationCommandExecutionResult,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
	SlackControlPlaneAdapter,
	TelegramControlPlaneAdapterSpec,
} from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG } from "./config.js";
import type {
	ActiveAdapter,
	ControlPlaneConfig,
	ControlPlaneGenerationContext,
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
	TelegramGenerationReloadResult,
	TelegramGenerationRollbackTrigger,
	TelegramGenerationSwapHooks,
} from "./control_plane_contract.js";
import type { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";
import {
	type ControlPlaneRunHeartbeatResult,
	type ControlPlaneRunInterruptResult,
	type ControlPlaneRunSnapshot,
	type ControlPlaneRunStatus,
	ControlPlaneRunSupervisor,
	type ControlPlaneRunSupervisorOpts,
	type ControlPlaneRunTrace,
} from "./run_supervisor.js";
import {
	buildMessagingOperatorRuntime,
	createOutboxDrainLoop,
} from "./control_plane_bootstrap_helpers.js";
import { enqueueRunEventOutbox } from "./control_plane_run_outbox.js";
import { TelegramAdapterGenerationManager } from "./control_plane_telegram_generation.js";

export type {
	ActiveAdapter,
	ControlPlaneConfig,
	ControlPlaneGenerationContext,
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
	ControlPlaneSessionMutationAction,
	ControlPlaneSessionMutationResult,
	TelegramGenerationReloadResult,
	TelegramGenerationRollbackTrigger,
	TelegramGenerationSwapHooks,
} from "./control_plane_contract.js";

function generationTags(
	generation: ControlPlaneGenerationContext,
	component: string,
): {
	generation_id: string;
	generation_seq: number;
	supervisor: string;
	component: string;
} {
	return {
		generation_id: generation.generation_id,
		generation_seq: generation.generation_seq,
		supervisor: "control_plane",
		component,
	};
}

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

export type BootstrapControlPlaneOpts = {
	repoRoot: string;
	config?: ControlPlaneConfig;
	operatorRuntime?: MessagingOperatorRuntime | null;
	operatorBackend?: MessagingOperatorBackend;
	heartbeatScheduler?: ActivityHeartbeatScheduler;
	runSupervisorSpawnProcess?: ControlPlaneRunSupervisorOpts["spawnProcess"];
	runSupervisorHeartbeatIntervalMs?: number;
	sessionLifecycle: ControlPlaneSessionLifecycle;
	generation?: ControlPlaneGenerationContext;
	telemetry?: GenerationTelemetryRecorder | null;
	telegramGenerationHooks?: TelegramGenerationSwapHooks;
	terminalEnabled?: boolean;
};

export async function bootstrapControlPlane(opts: BootstrapControlPlaneOpts): Promise<ControlPlaneHandle | null> {
	const controlPlaneConfig = opts.config ?? DEFAULT_MU_CONFIG.control_plane;
	const detected = detectAdapters(controlPlaneConfig);
	const generation: ControlPlaneGenerationContext = opts.generation ?? {
		generation_id: "control-plane-gen-0",
		generation_seq: 0,
	};
	const telemetry = opts.telemetry ?? null;
	const signalObserver: ControlPlaneSignalObserver | undefined = telemetry
		? {
				onDuplicateSignal: (signal) => {
					telemetry.recordDuplicateSignal(generationTags(generation, `control_plane.${signal.source}`), signal);
				},
				onDropSignal: (signal) => {
					telemetry.recordDropSignal(generationTags(generation, `control_plane.${signal.source}`), signal);
				},
			}
		: undefined;

	if (detected.length === 0 && !opts.terminalEnabled) {
		return null;
	}

	const paths = getControlPlanePaths(opts.repoRoot);

	const runtime = new ControlPlaneRuntime({ repoRoot: opts.repoRoot });
	let pipeline: ControlPlaneCommandPipeline | null = null;
	let runSupervisor: ControlPlaneRunSupervisor | null = null;
	let outboxDrainLoop: ReturnType<typeof createOutboxDrainLoop> | null = null;
	const adapterMap = new Map<
		string,
		{
			adapter: ControlPlaneAdapter;
			info: ActiveAdapter;
			isActive: () => boolean;
		}
	>();

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

		const outbox = new ControlPlaneOutbox(paths.outboxPath, {
			signalObserver,
		});
		await outbox.load();

		let scheduleOutboxDrainRef: (() => void) | null = null;
		runSupervisor = new ControlPlaneRunSupervisor({
			repoRoot: opts.repoRoot,
			heartbeatScheduler: opts.heartbeatScheduler,
			heartbeatIntervalMs: opts.runSupervisorHeartbeatIntervalMs,
			spawnProcess: opts.runSupervisorSpawnProcess,
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
				if (record.target_type === "reload" || record.target_type === "update") {
					if (record.command_args.length > 0) {
						return {
							terminalState: "failed",
							errorCode: "cli_validation_failed",
							trace: {
								cliCommandKind: record.target_type,
								runRootId: null,
							},
							mutatingEvents: [
								{
									eventType: "session.lifecycle.command.failed",
									payload: {
										action: record.target_type,
										reason: "unexpected_args",
										args: record.command_args,
									},
								},
							],
						};
					}

					const action = record.target_type;
					const executeLifecycleAction =
						action === "reload" ? opts.sessionLifecycle.reload : opts.sessionLifecycle.update;

					try {
						const lifecycle = await executeLifecycleAction();
						if (!lifecycle.ok) {
							return {
								terminalState: "failed",
								errorCode: "session_lifecycle_failed",
								trace: {
									cliCommandKind: action,
									runRootId: null,
								},
								mutatingEvents: [
									{
										eventType: "session.lifecycle.command.failed",
										payload: {
											action,
											reason: lifecycle.message,
											details: lifecycle.details ?? null,
										},
									},
								],
							};
						}
						return {
							terminalState: "completed",
							result: {
								ok: true,
								action,
								message: lifecycle.message,
								details: lifecycle.details ?? null,
							},
							trace: {
								cliCommandKind: action,
								runRootId: null,
							},
							mutatingEvents: [
								{
									eventType: `session.lifecycle.command.${action}`,
									payload: {
										action,
										message: lifecycle.message,
										details: lifecycle.details ?? null,
									},
								},
							],
						};
					} catch (err) {
						return {
							terminalState: "failed",
							errorCode: err instanceof Error && err.message ? err.message : "session_lifecycle_failed",
							trace: {
								cliCommandKind: action,
								runRootId: null,
							},
							mutatingEvents: [
								{
									eventType: "session.lifecycle.command.failed",
									payload: {
										action,
										reason: err instanceof Error && err.message ? err.message : "session_lifecycle_failed",
									},
								},
							],
						};
					}
				}

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

		const telegramManager = new TelegramAdapterGenerationManager({
			pipeline,
			outbox,
			initialConfig: controlPlaneConfig,
			onOutboxEnqueued: () => {
				scheduleOutboxDrainRef?.();
			},
			signalObserver,
			hooks: opts.telegramGenerationHooks,
		});
		await telegramManager.initialize();

		for (const d of detected) {
			if (d.name === "telegram") {
				continue;
			}

			const adapter: ControlPlaneAdapter =
				d.name === "slack"
					? new SlackControlPlaneAdapter({
							pipeline,
							outbox,
							signingSecret: d.signingSecret,
						})
					: new DiscordControlPlaneAdapter({
							pipeline,
							outbox,
							signingSecret: d.signingSecret,
						});

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
				isActive: () => true,
			});
		}

		const telegramProxy: ControlPlaneAdapter = {
			spec: TelegramControlPlaneAdapterSpec,
			async ingest(req: Request): Promise<AdapterIngressResult> {
				const active = telegramManager.activeAdapter();
				if (!active) {
					return {
						channel: "telegram",
						accepted: false,
						reason: "telegram_not_configured",
						response: new Response("telegram_not_configured", { status: 404 }),
						inbound: null,
						pipelineResult: null,
						outboxRecord: null,
						auditEntry: null,
					};
				}
				return await active.ingest(req);
			},
			async stop(): Promise<void> {
				await telegramManager.stop();
			},
		};

		if (adapterMap.has(TelegramControlPlaneAdapterSpec.route)) {
			throw new Error(`duplicate control-plane webhook route: ${TelegramControlPlaneAdapterSpec.route}`);
		}
		adapterMap.set(TelegramControlPlaneAdapterSpec.route, {
			adapter: telegramProxy,
			info: {
				name: "telegram",
				route: TelegramControlPlaneAdapterSpec.route,
			},
			isActive: () => telegramManager.hasActiveGeneration(),
		});

		const deliver = async (record: OutboxRecord): Promise<undefined | OutboxDeliveryHandlerResult> => {
			const { envelope } = record;

			if (envelope.channel === "telegram") {
				const telegramBotToken = telegramManager.activeBotToken();
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

		const outboxDrain = createOutboxDrainLoop({ outbox, deliver });
		const scheduleOutboxDrain = outboxDrain.scheduleOutboxDrain;
		scheduleOutboxDrainRef = scheduleOutboxDrain;
		outboxDrainLoop = outboxDrain;

		return {
			get activeAdapters(): ActiveAdapter[] {
				return [...adapterMap.values()].filter((entry) => entry.isActive()).map((v) => v.info);
			},

			async handleWebhook(path: string, req: Request): Promise<Response | null> {
				const entry = adapterMap.get(path);
				if (!entry || !entry.isActive()) return null;
				const result = await entry.adapter.ingest(req);
				if (result.outboxRecord) {
					scheduleOutboxDrain();
				}
				return result.response;
			},

			async reloadTelegramGeneration(reloadOpts: {
				config: ControlPlaneConfig;
				reason: string;
			}): Promise<TelegramGenerationReloadResult> {
				const result = await telegramManager.reload({
					config: reloadOpts.config,
					reason: reloadOpts.reason,
				});
				if (result.handled && result.ok) {
					scheduleOutboxDrain();
				}
				return result;
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

			async submitTerminalCommand(terminalOpts: {
				commandText: string;
				repoRoot: string;
				requestId?: string;
			}): Promise<CommandPipelineResult> {
				if (!pipeline) {
					throw new Error("control_plane_pipeline_unavailable");
				}
				return await pipeline.handleTerminalInbound(terminalOpts);
			},

			async stop(): Promise<void> {
				if (outboxDrainLoop) {
					outboxDrainLoop.stop();
					outboxDrainLoop = null;
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
		if (outboxDrainLoop) {
			outboxDrainLoop.stop();
			outboxDrainLoop = null;
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
