import type { MessagingOperatorBackend, MessagingOperatorRuntime } from "@femtomc/mu-agent";
import {
	type AdapterIngressResult,
	type CommandPipelineResult,
	type ControlPlaneAdapter,
	type Channel,
	ControlPlaneCommandPipeline,
	ControlPlaneOutbox,
	ControlPlaneRuntime,
	type ControlPlaneSignalObserver,
	type GenerationTelemetryRecorder,
	getControlPlanePaths,
	type MutationCommandExecutionResult,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
	TelegramControlPlaneAdapterSpec,
} from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG } from "./config.js";
import {
	DEFAULT_INTER_ROOT_QUEUE_POLICY,
	normalizeInterRootQueuePolicy,
	type ActiveAdapter,
	type ControlPlaneConfig,
	type ControlPlaneGenerationContext,
	type ControlPlaneHandle,
	type ControlPlaneSessionLifecycle,
	type InterRootQueuePolicy,
	type NotifyOperatorsOpts,
	type NotifyOperatorsResult,
	type TelegramGenerationReloadResult,
	type TelegramGenerationSwapHooks,
	type WakeDeliveryObserver,
} from "./control_plane_contract.js";
import {
	type ControlPlaneRunInterruptResult,
	type ControlPlaneRunSnapshot,
	ControlPlaneRunSupervisor,
	type ControlPlaneRunSupervisorOpts,
	type ControlPlaneRunTrace,
} from "./run_supervisor.js";
import { DurableRunQueue, queueStatesForRunStatusFilter, runSnapshotFromQueueSnapshot } from "./run_queue.js";
import { buildMessagingOperatorRuntime, createOutboxDrainLoop } from "./control_plane_bootstrap_helpers.js";
import { ControlPlaneRunQueueCoordinator } from "./control_plane_run_queue_coordinator.js";
import { enqueueRunEventOutbox } from "./control_plane_run_outbox.js";
import {
	buildWakeOutboundEnvelope,
	resolveWakeFanoutCapability,
	wakeDeliveryMetadataFromOutboxRecord,
	wakeDispatchReasonCode,
	wakeFanoutDedupeKey,
} from "./control_plane_wake_delivery.js";
import {
	createStaticAdaptersFromDetected,
	detectAdapters,
} from "./control_plane_adapter_registry.js";
import { OutboundDeliveryRouter } from "./outbound_delivery_router.js";
import { TelegramAdapterGenerationManager } from "./control_plane_telegram_generation.js";

export type {
	ActiveAdapter,
	ControlPlaneConfig,
	ControlPlaneGenerationContext,
	ControlPlaneHandle,
	ControlPlaneSessionLifecycle,
	ControlPlaneSessionMutationAction,
	ControlPlaneSessionMutationResult,
	NotifyOperatorsOpts,
	NotifyOperatorsResult,
	TelegramGenerationReloadResult,
	TelegramGenerationRollbackTrigger,
	TelegramGenerationSwapHooks,
	WakeDeliveryEvent,
	WakeDeliveryObserver,
	WakeNotifyContext,
	WakeNotifyDecision,
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

const WAKE_OUTBOX_MAX_ATTEMPTS = 6;

function emptyNotifyOperatorsResult(): NotifyOperatorsResult {
	return {
		queued: 0,
		duplicate: 0,
		skipped: 0,
		decisions: [],
	};
}

function normalizeIssueId(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!/^mu-[a-z0-9][a-z0-9-]*$/i.test(trimmed)) {
		return null;
	}
	return trimmed.toLowerCase();
}

export { detectAdapters };

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
	runSupervisorSpawnProcess?: ControlPlaneRunSupervisorOpts["spawnProcess"];
	sessionLifecycle: ControlPlaneSessionLifecycle;
	generation?: ControlPlaneGenerationContext;
	telemetry?: GenerationTelemetryRecorder | null;
	telegramGenerationHooks?: TelegramGenerationSwapHooks;
	wakeDeliveryObserver?: WakeDeliveryObserver | null;
	terminalEnabled?: boolean;
	interRootQueuePolicy?: InterRootQueuePolicy;
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
	let wakeDeliveryObserver: WakeDeliveryObserver | null = opts.wakeDeliveryObserver ?? null;
	const outboundDeliveryChannels = new Set<Channel>();
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
		const runQueue = new DurableRunQueue({ repoRoot: opts.repoRoot });
		const interRootQueuePolicy = normalizeInterRootQueuePolicy(
			opts.interRootQueuePolicy ?? DEFAULT_INTER_ROOT_QUEUE_POLICY,
		);
		const runQueueCoordinator = new ControlPlaneRunQueueCoordinator({
			runQueue,
			interRootQueuePolicy,
			getRunSupervisor: () => runSupervisor,
		});

		runSupervisor = new ControlPlaneRunSupervisor({
			repoRoot: opts.repoRoot,
			spawnProcess: opts.runSupervisorSpawnProcess,
			onEvent: async (event) => {
				await runQueueCoordinator.onRunEvent(event);
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
		await runQueueCoordinator.scheduleReconcile("bootstrap");

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
						const launched = await runQueueCoordinator.launchQueuedRunFromCommand(record);
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
										queue_id: launched.queue_id ?? null,
										queue_state: launched.queue_state ?? null,
									},
								},
							],
						};
					} catch (err) {
						return {
							terminalState: "failed",
							errorCode: err instanceof Error && err.message ? err.message : "run_queue_start_failed",
							trace: {
								cliCommandKind: record.target_type.replaceAll(" ", "_"),
								runRootId: record.target_id,
							},
						};
					}
				}

				if (record.target_type === "run interrupt") {
					const result = await runQueueCoordinator.interruptQueuedRun({
						rootIssueId: record.target_id,
					});

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

		for (const adapter of createStaticAdaptersFromDetected({
			detected,
			pipeline,
			outbox,
		})) {
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

		const deliveryRouter = new OutboundDeliveryRouter([
			{
				channel: "telegram",
				deliver: async (record: OutboxRecord): Promise<OutboxDeliveryHandlerResult> => {
					const telegramBotToken = telegramManager.activeBotToken();
					if (!telegramBotToken) {
						return { kind: "retry", error: "telegram bot token not configured in mu workspace config" };
					}

					const richPayload = buildTelegramSendMessagePayload({
						chatId: record.envelope.channel_conversation_id,
						text: record.envelope.body,
						richFormatting: true,
					});
					let res = await postTelegramMessage(telegramBotToken, richPayload);

					// Fallback: if Telegram rejects markdown entities, retry as plain text.
					if (!res.ok && res.status === 400 && richPayload.parse_mode) {
						const plainPayload = buildTelegramSendMessagePayload({
							chatId: record.envelope.channel_conversation_id,
							text: record.envelope.body,
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
				},
			},
		]);
		for (const channel of deliveryRouter.supportedChannels()) {
			outboundDeliveryChannels.add(channel);
		}

		const notifyOperators = async (notifyOpts: NotifyOperatorsOpts): Promise<NotifyOperatorsResult> => {
			if (!pipeline) {
				return emptyNotifyOperatorsResult();
			}
			const message = notifyOpts.message.trim();
			const dedupeKey = notifyOpts.dedupeKey.trim();
			if (!message || !dedupeKey) {
				return emptyNotifyOperatorsResult();
			}

			const wakeSource = typeof notifyOpts.wake?.wakeSource === "string" ? notifyOpts.wake.wakeSource.trim() : "";
			const wakeProgramId = typeof notifyOpts.wake?.programId === "string" ? notifyOpts.wake.programId.trim() : "";
			const wakeSourceTsMsRaw = notifyOpts.wake?.sourceTsMs;
			const wakeSourceTsMs =
				typeof wakeSourceTsMsRaw === "number" && Number.isFinite(wakeSourceTsMsRaw)
					? Math.trunc(wakeSourceTsMsRaw)
					: null;
			const wakeId =
				typeof notifyOpts.wake?.wakeId === "string" && notifyOpts.wake.wakeId.trim().length > 0
					? notifyOpts.wake.wakeId.trim()
					: `wake-${(() => {
							const hasher = new Bun.CryptoHasher("sha256");
							hasher.update(`${dedupeKey}:${message}`);
							return hasher.digest("hex").slice(0, 16);
						})()}`;

			const context = {
				wakeId,
				dedupeKey,
				wakeSource: wakeSource || null,
				programId: wakeProgramId || null,
				sourceTsMs: wakeSourceTsMs,
			};

			const nowMs = Math.trunc(Date.now());
			const telegramBotToken = telegramManager.activeBotToken();
			const bindings = pipeline.identities
				.listBindings({ includeInactive: false })
				.filter((binding) => binding.scopes.includes("cp.ops.admin"));

			const result = emptyNotifyOperatorsResult();
			for (const binding of bindings) {
				const bindingDedupeKey = wakeFanoutDedupeKey({
					dedupeKey,
					wakeId,
					binding,
				});
				const capability = resolveWakeFanoutCapability({
					binding,
					isChannelDeliverySupported: (channel) => outboundDeliveryChannels.has(channel),
					telegramBotToken,
				});
				if (!capability.ok) {
					result.skipped += 1;
					result.decisions.push({
						state: "skipped",
						reason_code: capability.reasonCode,
						binding_id: binding.binding_id,
						channel: binding.channel,
						dedupe_key: bindingDedupeKey,
						outbox_id: null,
					});
					continue;
				}

				const envelope = buildWakeOutboundEnvelope({
					repoRoot: opts.repoRoot,
					nowMs,
					message,
					binding,
					context,
					metadata: notifyOpts.metadata,
				});
				const enqueueDecision = await outbox.enqueue({
					dedupeKey: bindingDedupeKey,
					envelope,
					nowMs,
					maxAttempts: WAKE_OUTBOX_MAX_ATTEMPTS,
				});
				if (enqueueDecision.kind === "enqueued") {
					result.queued += 1;
					scheduleOutboxDrainRef?.();
					result.decisions.push({
						state: "queued",
						reason_code: "outbox_enqueued",
						binding_id: binding.binding_id,
						channel: binding.channel,
						dedupe_key: bindingDedupeKey,
						outbox_id: enqueueDecision.record.outbox_id,
					});
				} else {
					result.duplicate += 1;
					result.decisions.push({
						state: "duplicate",
						reason_code: "outbox_duplicate",
						binding_id: binding.binding_id,
						channel: binding.channel,
						dedupe_key: bindingDedupeKey,
						outbox_id: enqueueDecision.record.outbox_id,
					});
				}
			}

			return result;
		};

		const deliver = async (record: OutboxRecord): Promise<undefined | OutboxDeliveryHandlerResult> => {
			return await deliveryRouter.deliver(record);
		};

		const outboxDrain = createOutboxDrainLoop({
			outbox,
			deliver,
			onOutcome: async (outcome) => {
				if (!wakeDeliveryObserver) {
					return;
				}
				const metadata = wakeDeliveryMetadataFromOutboxRecord(outcome.record);
				if (!metadata) {
					return;
				}
				const state =
					outcome.kind === "delivered" ? "delivered" : outcome.kind === "retried" ? "retried" : "dead_letter";
				await wakeDeliveryObserver({
					state,
					reason_code: wakeDispatchReasonCode({
						state,
						lastError: outcome.record.last_error,
						deadLetterReason: outcome.record.dead_letter_reason,
					}),
					wake_id: metadata.wakeId,
					dedupe_key: metadata.wakeDedupeKey,
					binding_id: metadata.bindingId,
					channel: metadata.channel,
					outbox_id: metadata.outboxId,
					outbox_dedupe_key: metadata.outboxDedupeKey,
					attempt_count: outcome.record.attempt_count,
				});
			},
		});
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

			async notifyOperators(notifyOpts: NotifyOperatorsOpts): Promise<NotifyOperatorsResult> {
				return await notifyOperators(notifyOpts);
			},

			setWakeDeliveryObserver(observer: WakeDeliveryObserver | null): void {
				wakeDeliveryObserver = observer;
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
				const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
				const fallbackStatusFilter = queueStatesForRunStatusFilter(opts.status);
				if (Array.isArray(fallbackStatusFilter) && fallbackStatusFilter.length === 0) {
					return [];
				}
				const queued = await runQueue.listRunSnapshots({
					status: opts.status,
					limit,
					runtimeByJobId: runQueueCoordinator.runtimeSnapshotsByJobId(),
				});
				const seen = new Set(queued.map((run) => run.job_id));
				const fallbackRuns = runSupervisor?.list({ limit: 500 }) ?? [];
				for (const run of fallbackRuns) {
					if (seen.has(run.job_id)) {
						continue;
					}
					if (fallbackStatusFilter && fallbackStatusFilter.length > 0) {
						const mapped =
							run.status === "completed"
								? "done"
								: run.status === "failed"
									? "failed"
									: run.status === "cancelled"
										? "cancelled"
										: "active";
						if (!fallbackStatusFilter.includes(mapped)) {
							continue;
						}
					}
					queued.push(run);
					seen.add(run.job_id);
				}
				return queued.slice(0, limit);
			},

			async getRun(idOrRoot: string): Promise<ControlPlaneRunSnapshot | null> {
				const queued = await runQueue.get(idOrRoot);
				if (queued) {
					const runtime = queued.job_id ? (runSupervisor?.get(queued.job_id) ?? null) : null;
					return runSnapshotFromQueueSnapshot(queued, runtime);
				}
				return runSupervisor?.get(idOrRoot) ?? null;
			},

			async startRun(startOpts: { prompt: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot> {
				return await runQueueCoordinator.launchQueuedRun({
					mode: "run_start",
					prompt: startOpts.prompt,
					maxSteps: startOpts.maxSteps,
					source: "api",
					dedupeKey: `api:run_start:${crypto.randomUUID()}`,
				});
			},

			async resumeRun(resumeOpts: { rootIssueId: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot> {
				const rootIssueId = normalizeIssueId(resumeOpts.rootIssueId);
				if (!rootIssueId) {
					throw new Error("run_resume_invalid_root_issue_id");
				}
				return await runQueueCoordinator.launchQueuedRun({
					mode: "run_resume",
					rootIssueId,
					maxSteps: resumeOpts.maxSteps,
					source: "api",
					dedupeKey: `api:run_resume:${rootIssueId}:${crypto.randomUUID()}`,
				});
			},

			async interruptRun(interruptOpts): Promise<ControlPlaneRunInterruptResult> {
				return await runQueueCoordinator.interruptQueuedRun(interruptOpts);
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
				wakeDeliveryObserver = null;
				runQueueCoordinator.stop();
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
		wakeDeliveryObserver = null;
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
