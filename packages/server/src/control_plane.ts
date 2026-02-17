import {
	ApprovedCommandBroker,
	CommandContextResolver,
	type MessagingOperatorBackend,
	MessagingOperatorRuntime,
	operatorExtensionPaths,
	PiMessagingOperatorBackend,
} from "@femtomc/mu-agent";
import {
	type AdapterIngressResult,
	type Channel,
	type ControlPlaneAdapter,
	ControlPlaneCommandPipeline,
	ControlPlaneOutbox,
	ControlPlaneOutboxDispatcher,
	ControlPlaneRuntime,
	type ControlPlaneSignalObserver,
	correlationFromCommandRecord,
	DiscordControlPlaneAdapter,
	type GenerationTelemetryRecorder,
	getControlPlanePaths,
	type MutationCommandExecutionResult,
	type OutboundEnvelope,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
	type ReloadableGenerationIdentity,
	SlackControlPlaneAdapter,
	TelegramControlPlaneAdapter,
	TelegramControlPlaneAdapterSpec,
} from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG, type MuConfig } from "./config.js";
import type { ActivityHeartbeatScheduler } from "./heartbeat_scheduler.js";
import {
	type ControlPlaneRunEvent,
	type ControlPlaneRunHeartbeatResult,
	type ControlPlaneRunInterruptResult,
	type ControlPlaneRunSnapshot,
	type ControlPlaneRunStatus,
	ControlPlaneRunSupervisor,
	type ControlPlaneRunSupervisorOpts,
	type ControlPlaneRunTrace,
} from "./run_supervisor.js";

export type ActiveAdapter = {
	name: Channel;
	route: string;
};

export type TelegramGenerationRollbackTrigger =
	| "manual"
	| "warmup_failed"
	| "health_gate_failed"
	| "cutover_failed"
	| "post_cutover_health_failed"
	| "rollback_unavailable"
	| "rollback_failed";

export type TelegramGenerationReloadResult = {
	handled: boolean;
	ok: boolean;
	reason: string;
	route: string;
	from_generation: ReloadableGenerationIdentity | null;
	to_generation: ReloadableGenerationIdentity | null;
	active_generation: ReloadableGenerationIdentity | null;
	warmup: {
		ok: boolean;
		elapsed_ms: number;
		error?: string;
	} | null;
	cutover: {
		ok: boolean;
		elapsed_ms: number;
		error?: string;
	} | null;
	drain: {
		ok: boolean;
		elapsed_ms: number;
		timed_out: boolean;
		forced_stop: boolean;
		error?: string;
	} | null;
	rollback: {
		requested: boolean;
		trigger: TelegramGenerationRollbackTrigger | null;
		attempted: boolean;
		ok: boolean;
		error?: string;
	};
	error?: string;
};

export type ControlPlaneHandle = {
	activeAdapters: ActiveAdapter[];
	handleWebhook(path: string, req: Request): Promise<Response | null>;
	reloadTelegramGeneration?(opts: {
		config: ControlPlaneConfig;
		reason: string;
	}): Promise<TelegramGenerationReloadResult>;
	listRuns?(opts?: { status?: string; limit?: number }): Promise<ControlPlaneRunSnapshot[]>;
	getRun?(idOrRoot: string): Promise<ControlPlaneRunSnapshot | null>;
	startRun?(opts: { prompt: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot>;
	resumeRun?(opts: { rootIssueId: string; maxSteps?: number }): Promise<ControlPlaneRunSnapshot>;
	interruptRun?(opts: { jobId?: string | null; rootIssueId?: string | null }): Promise<ControlPlaneRunInterruptResult>;
	heartbeatRun?(opts: {
		jobId?: string | null;
		rootIssueId?: string | null;
		reason?: string | null;
		wakeMode?: string | null;
	}): Promise<ControlPlaneRunHeartbeatResult>;
	traceRun?(opts: { idOrRoot: string; limit?: number }): Promise<ControlPlaneRunTrace | null>;
	stop(): Promise<void>;
};

export type ControlPlaneConfig = MuConfig["control_plane"];

export type ControlPlaneGenerationContext = ReloadableGenerationIdentity;

export type TelegramGenerationSwapHooks = {
	onWarmup?: (ctx: { generation: ReloadableGenerationIdentity; reason: string }) => void | Promise<void>;
	onCutover?: (ctx: {
		from_generation: ReloadableGenerationIdentity | null;
		to_generation: ReloadableGenerationIdentity;
		reason: string;
	}) => void | Promise<void>;
	onDrain?: (ctx: {
		generation: ReloadableGenerationIdentity;
		reason: string;
		timeout_ms: number;
	}) => void | Promise<void>;
};

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

type TelegramAdapterConfig = {
	webhookSecret: string;
	botToken: string | null;
	botUsername: string | null;
};

type TelegramGenerationRecord = {
	generation: ReloadableGenerationIdentity;
	config: TelegramAdapterConfig;
	adapter: TelegramControlPlaneAdapter;
};

const TELEGRAM_GENERATION_SUPERVISOR_ID = "telegram-adapter";
const TELEGRAM_WARMUP_TIMEOUT_MS = 2_000;
const TELEGRAM_DRAIN_TIMEOUT_MS = 5_000;

function cloneControlPlaneConfig(config: ControlPlaneConfig): ControlPlaneConfig {
	return JSON.parse(JSON.stringify(config)) as ControlPlaneConfig;
}

function controlPlaneNonTelegramFingerprint(config: ControlPlaneConfig): string {
	return JSON.stringify({
		adapters: {
			slack: config.adapters.slack,
			discord: config.adapters.discord,
			gmail: config.adapters.gmail,
		},
		operator: config.operator,
	});
}

function telegramAdapterConfigFromControlPlane(config: ControlPlaneConfig): TelegramAdapterConfig | null {
	const webhookSecret = config.adapters.telegram.webhook_secret;
	if (!webhookSecret) {
		return null;
	}
	return {
		webhookSecret,
		botToken: config.adapters.telegram.bot_token,
		botUsername: config.adapters.telegram.bot_username,
	};
}

function applyTelegramAdapterConfig(
	base: ControlPlaneConfig,
	telegram: TelegramAdapterConfig | null,
): ControlPlaneConfig {
	const next = cloneControlPlaneConfig(base);
	next.adapters.telegram.webhook_secret = telegram?.webhookSecret ?? null;
	next.adapters.telegram.bot_token = telegram?.botToken ?? null;
	next.adapters.telegram.bot_username = telegram?.botUsername ?? null;
	return next;
}

function cloneTelegramAdapterConfig(config: TelegramAdapterConfig): TelegramAdapterConfig {
	return {
		webhookSecret: config.webhookSecret,
		botToken: config.botToken,
		botUsername: config.botUsername,
	};
}

function describeError(err: unknown): string {
	if (err instanceof Error && err.message.trim().length > 0) {
		return err.message;
	}
	return String(err);
}

async function runWithTimeout<T>(opts: {
	timeoutMs: number;
	timeoutMessage: string;
	run: () => Promise<T>;
}): Promise<T> {
	if (opts.timeoutMs <= 0) {
		return await opts.run();
	}
	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error(opts.timeoutMessage));
		}, opts.timeoutMs);
		void opts
			.run()
			.then((value) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(value);
			})
			.catch((err) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				reject(err);
			});
	});
}

class TelegramAdapterGenerationManager {
	readonly #pipeline: ControlPlaneCommandPipeline;
	readonly #outbox: ControlPlaneOutbox;
	readonly #nowMs: () => number;
	readonly #onOutboxEnqueued: (() => void) | null;
	readonly #signalObserver: ControlPlaneSignalObserver | null;
	readonly #hooks: TelegramGenerationSwapHooks | null;
	#generationSeq = -1;
	#active: TelegramGenerationRecord | null = null;
	#previousConfig: TelegramAdapterConfig | null = null;
	#activeControlPlaneConfig: ControlPlaneConfig;

	public constructor(opts: {
		pipeline: ControlPlaneCommandPipeline;
		outbox: ControlPlaneOutbox;
		initialConfig: ControlPlaneConfig;
		nowMs?: () => number;
		onOutboxEnqueued?: () => void;
		signalObserver?: ControlPlaneSignalObserver;
		hooks?: TelegramGenerationSwapHooks;
	}) {
		this.#pipeline = opts.pipeline;
		this.#outbox = opts.outbox;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#onOutboxEnqueued = opts.onOutboxEnqueued ?? null;
		this.#signalObserver = opts.signalObserver ?? null;
		this.#hooks = opts.hooks ?? null;
		this.#activeControlPlaneConfig = cloneControlPlaneConfig(opts.initialConfig);
	}

	#nextGeneration(): ReloadableGenerationIdentity {
		const nextSeq = this.#generationSeq + 1;
		return {
			generation_id: `${TELEGRAM_GENERATION_SUPERVISOR_ID}-gen-${nextSeq}`,
			generation_seq: nextSeq,
		};
	}

	#buildAdapter(
		config: TelegramAdapterConfig,
		opts: { acceptIngress: boolean; ingressDrainEnabled: boolean },
	): TelegramControlPlaneAdapter {
		return new TelegramControlPlaneAdapter({
			pipeline: this.#pipeline,
			outbox: this.#outbox,
			webhookSecret: config.webhookSecret,
			botUsername: config.botUsername,
			deferredIngress: true,
			onOutboxEnqueued: this.#onOutboxEnqueued ?? undefined,
			signalObserver: this.#signalObserver ?? undefined,
			acceptIngress: opts.acceptIngress,
			ingressDrainEnabled: opts.ingressDrainEnabled,
			nowMs: this.#nowMs,
		});
	}

	public async initialize(): Promise<void> {
		const initial = telegramAdapterConfigFromControlPlane(this.#activeControlPlaneConfig);
		if (!initial) {
			return;
		}
		const generation = this.#nextGeneration();
		const adapter = this.#buildAdapter(initial, {
			acceptIngress: true,
			ingressDrainEnabled: true,
		});
		await adapter.warmup();
		const health = await adapter.healthCheck();
		if (!health.ok) {
			await adapter.stop({ force: true, reason: "startup_health_gate_failed" });
			throw new Error(`telegram adapter warmup health failed: ${health.reason}`);
		}
		this.#active = {
			generation,
			config: cloneTelegramAdapterConfig(initial),
			adapter,
		};
		this.#generationSeq = generation.generation_seq;
	}

	public hasActiveGeneration(): boolean {
		return this.#active != null;
	}

	public activeGeneration(): ReloadableGenerationIdentity | null {
		return this.#active ? { ...this.#active.generation } : null;
	}

	public activeBotToken(): string | null {
		return this.#active?.config.botToken ?? null;
	}

	public activeAdapter(): TelegramControlPlaneAdapter | null {
		return this.#active?.adapter ?? null;
	}

	public canHandleConfig(nextConfig: ControlPlaneConfig, reason: string): boolean {
		if (reason === "rollback") {
			return true;
		}
		return (
			controlPlaneNonTelegramFingerprint(nextConfig) ===
			controlPlaneNonTelegramFingerprint(this.#activeControlPlaneConfig)
		);
	}

	async #rollbackToPrevious(opts: {
		failedRecord: TelegramGenerationRecord;
		previous: TelegramGenerationRecord | null;
		reason: string;
	}): Promise<{ ok: boolean; error?: string }> {
		if (!opts.previous) {
			return { ok: false, error: "rollback_unavailable" };
		}
		try {
			opts.previous.adapter.activateIngress();
			this.#active = opts.previous;
			this.#previousConfig = cloneTelegramAdapterConfig(opts.failedRecord.config);
			await opts.failedRecord.adapter.stop({ force: true, reason: `rollback:${opts.reason}` });
			this.#activeControlPlaneConfig = applyTelegramAdapterConfig(
				this.#activeControlPlaneConfig,
				opts.previous.config,
			);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: describeError(err) };
		}
	}

	public async reload(opts: {
		config: ControlPlaneConfig;
		reason: string;
		warmupTimeoutMs?: number;
		drainTimeoutMs?: number;
	}): Promise<TelegramGenerationReloadResult> {
		if (!this.canHandleConfig(opts.config, opts.reason)) {
			return {
				handled: false,
				ok: false,
				reason: opts.reason,
				route: "/webhooks/telegram",
				from_generation: this.#active?.generation ?? null,
				to_generation: null,
				active_generation: this.#active?.generation ?? null,
				warmup: null,
				cutover: null,
				drain: null,
				rollback: {
					requested: opts.reason === "rollback",
					trigger: null,
					attempted: false,
					ok: true,
				},
			};
		}

		const rollbackRequested = opts.reason === "rollback";
		let rollbackTrigger: TelegramGenerationRollbackTrigger | null = rollbackRequested ? "manual" : null;
		let rollbackAttempted = false;
		let rollbackOk = true;
		let rollbackError: string | undefined;
		const fromGeneration = this.#active?.generation ?? null;
		const previousRecord = this.#active;
		const warmupTimeoutMs = Math.max(0, Math.trunc(opts.warmupTimeoutMs ?? TELEGRAM_WARMUP_TIMEOUT_MS));
		const drainTimeoutMs = Math.max(0, Math.trunc(opts.drainTimeoutMs ?? TELEGRAM_DRAIN_TIMEOUT_MS));

		const targetConfig = rollbackRequested
			? this.#previousConfig
			: telegramAdapterConfigFromControlPlane(opts.config);
		if (rollbackRequested && !targetConfig) {
			return {
				handled: true,
				ok: false,
				reason: opts.reason,
				route: "/webhooks/telegram",
				from_generation: fromGeneration,
				to_generation: null,
				active_generation: fromGeneration,
				warmup: null,
				cutover: null,
				drain: null,
				rollback: {
					requested: true,
					trigger: "rollback_unavailable",
					attempted: false,
					ok: false,
					error: "rollback_unavailable",
				},
				error: "rollback_unavailable",
			};
		}

		if (!targetConfig && !previousRecord) {
			this.#activeControlPlaneConfig = cloneControlPlaneConfig(opts.config);
			return {
				handled: true,
				ok: true,
				reason: opts.reason,
				route: "/webhooks/telegram",
				from_generation: null,
				to_generation: null,
				active_generation: null,
				warmup: null,
				cutover: null,
				drain: null,
				rollback: {
					requested: rollbackRequested,
					trigger: rollbackTrigger,
					attempted: false,
					ok: true,
				},
			};
		}

		if (!targetConfig && previousRecord) {
			const drainStartedAtMs = Math.trunc(this.#nowMs());
			let forcedStop = false;
			let drainError: string | undefined;
			let drainTimedOut = false;
			try {
				previousRecord.adapter.beginDrain();
				if (this.#hooks?.onDrain) {
					await this.#hooks.onDrain({
						generation: previousRecord.generation,
						reason: opts.reason,
						timeout_ms: drainTimeoutMs,
					});
				}
				const drain = await runWithTimeout({
					timeoutMs: drainTimeoutMs,
					timeoutMessage: "telegram_drain_timeout",
					run: async () => await previousRecord.adapter.drain({ timeoutMs: drainTimeoutMs, reason: opts.reason }),
				});
				drainTimedOut = drain.timed_out;
				if (!drain.ok || drain.timed_out) {
					forcedStop = true;
					await previousRecord.adapter.stop({ force: true, reason: "disable_drain_timeout" });
				} else {
					await previousRecord.adapter.stop({ force: false, reason: "disable" });
				}
			} catch (err) {
				drainError = describeError(err);
				forcedStop = true;
				drainTimedOut = drainError.includes("timeout");
				await previousRecord.adapter.stop({ force: true, reason: "disable_drain_failed" });
			}
			this.#previousConfig = cloneTelegramAdapterConfig(previousRecord.config);
			this.#active = null;
			this.#activeControlPlaneConfig = applyTelegramAdapterConfig(this.#activeControlPlaneConfig, null);
			return {
				handled: true,
				ok: drainError == null,
				reason: opts.reason,
				route: "/webhooks/telegram",
				from_generation: fromGeneration,
				to_generation: null,
				active_generation: null,
				warmup: null,
				cutover: {
					ok: true,
					elapsed_ms: 0,
				},
				drain: {
					ok: drainError == null && !drainTimedOut,
					elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - drainStartedAtMs),
					timed_out: drainTimedOut,
					forced_stop: forcedStop,
					...(drainError ? { error: drainError } : {}),
				},
				rollback: {
					requested: rollbackRequested,
					trigger: rollbackTrigger,
					attempted: false,
					ok: true,
				},
				...(drainError ? { error: drainError } : {}),
			};
		}

		const nextConfig = cloneTelegramAdapterConfig(targetConfig as TelegramAdapterConfig);
		const toGeneration = this.#nextGeneration();
		const nextAdapter = this.#buildAdapter(nextConfig, {
			acceptIngress: false,
			ingressDrainEnabled: false,
		});
		const nextRecord: TelegramGenerationRecord = {
			generation: toGeneration,
			config: nextConfig,
			adapter: nextAdapter,
		};

		const warmupStartedAtMs = Math.trunc(this.#nowMs());
		try {
			if (this.#hooks?.onWarmup) {
				await this.#hooks.onWarmup({ generation: toGeneration, reason: opts.reason });
			}
			await runWithTimeout({
				timeoutMs: warmupTimeoutMs,
				timeoutMessage: "telegram_warmup_timeout",
				run: async () => {
					await nextAdapter.warmup();
					const health = await nextAdapter.healthCheck();
					if (!health.ok) {
						throw new Error(`telegram_health_gate_failed:${health.reason}`);
					}
				},
			});
		} catch (err) {
			const error = describeError(err);
			rollbackTrigger = error.includes("health_gate") ? "health_gate_failed" : "warmup_failed";
			await nextAdapter.stop({ force: true, reason: "warmup_failed" });
			return {
				handled: true,
				ok: false,
				reason: opts.reason,
				route: "/webhooks/telegram",
				from_generation: fromGeneration,
				to_generation: toGeneration,
				active_generation: fromGeneration,
				warmup: {
					ok: false,
					elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - warmupStartedAtMs),
					error,
				},
				cutover: null,
				drain: null,
				rollback: {
					requested: rollbackRequested,
					trigger: rollbackTrigger,
					attempted: false,
					ok: true,
				},
				error,
			};
		}

		const cutoverStartedAtMs = Math.trunc(this.#nowMs());
		try {
			if (this.#hooks?.onCutover) {
				await this.#hooks.onCutover({
					from_generation: fromGeneration,
					to_generation: toGeneration,
					reason: opts.reason,
				});
			}
			nextAdapter.activateIngress();
			if (previousRecord) {
				previousRecord.adapter.beginDrain();
			}
			this.#active = nextRecord;
			this.#generationSeq = toGeneration.generation_seq;
			const postCutoverHealth = await nextAdapter.healthCheck();
			if (!postCutoverHealth.ok) {
				throw new Error(`telegram_post_cutover_health_failed:${postCutoverHealth.reason}`);
			}
		} catch (err) {
			const error = describeError(err);
			rollbackTrigger = error.includes("post_cutover") ? "post_cutover_health_failed" : "cutover_failed";
			rollbackAttempted = true;
			const rollback = await this.#rollbackToPrevious({
				failedRecord: nextRecord,
				previous: previousRecord,
				reason: opts.reason,
			});
			rollbackOk = rollback.ok;
			rollbackError = rollback.error;
			if (!rollback.ok) {
				await nextAdapter.stop({ force: true, reason: "rollback_failed" });
				this.#active = previousRecord ?? null;
				this.#activeControlPlaneConfig = applyTelegramAdapterConfig(
					this.#activeControlPlaneConfig,
					previousRecord?.config ?? null,
				);
			}
			return {
				handled: true,
				ok: false,
				reason: opts.reason,
				route: "/webhooks/telegram",
				from_generation: fromGeneration,
				to_generation: toGeneration,
				active_generation: this.#active?.generation ?? fromGeneration,
				warmup: {
					ok: true,
					elapsed_ms: Math.max(0, cutoverStartedAtMs - warmupStartedAtMs),
				},
				cutover: {
					ok: false,
					elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - cutoverStartedAtMs),
					error,
				},
				drain: null,
				rollback: {
					requested: rollbackRequested,
					trigger: rollbackTrigger,
					attempted: rollbackAttempted,
					ok: rollbackOk,
					...(rollbackError ? { error: rollbackError } : {}),
				},
				error,
			};
		}

		let drain: TelegramGenerationReloadResult["drain"] = null;
		if (previousRecord) {
			const drainStartedAtMs = Math.trunc(this.#nowMs());
			let forcedStop = false;
			let drainTimedOut = false;
			let drainError: string | undefined;
			try {
				if (this.#hooks?.onDrain) {
					await this.#hooks.onDrain({
						generation: previousRecord.generation,
						reason: opts.reason,
						timeout_ms: drainTimeoutMs,
					});
				}
				const drained = await runWithTimeout({
					timeoutMs: drainTimeoutMs,
					timeoutMessage: "telegram_drain_timeout",
					run: async () => await previousRecord.adapter.drain({ timeoutMs: drainTimeoutMs, reason: opts.reason }),
				});
				drainTimedOut = drained.timed_out;
				if (!drained.ok || drained.timed_out) {
					forcedStop = true;
					await previousRecord.adapter.stop({ force: true, reason: "generation_drain_timeout" });
				} else {
					await previousRecord.adapter.stop({ force: false, reason: "generation_drained" });
				}
			} catch (err) {
				drainError = describeError(err);
				forcedStop = true;
				drainTimedOut = drainError.includes("timeout");
				await previousRecord.adapter.stop({ force: true, reason: "generation_drain_failed" });
			}
			drain = {
				ok: drainError == null && !drainTimedOut,
				elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - drainStartedAtMs),
				timed_out: drainTimedOut,
				forced_stop: forcedStop,
				...(drainError ? { error: drainError } : {}),
			};
		}

		this.#previousConfig = previousRecord ? cloneTelegramAdapterConfig(previousRecord.config) : this.#previousConfig;
		this.#activeControlPlaneConfig = applyTelegramAdapterConfig(this.#activeControlPlaneConfig, nextConfig);
		return {
			handled: true,
			ok: true,
			reason: opts.reason,
			route: "/webhooks/telegram",
			from_generation: fromGeneration,
			to_generation: toGeneration,
			active_generation: toGeneration,
			warmup: {
				ok: true,
				elapsed_ms: Math.max(0, cutoverStartedAtMs - warmupStartedAtMs),
			},
			cutover: {
				ok: true,
				elapsed_ms: Math.max(0, Math.trunc(this.#nowMs()) - cutoverStartedAtMs),
			},
			drain,
			rollback: {
				requested: rollbackRequested,
				trigger: rollbackTrigger,
				attempted: rollbackAttempted,
				ok: rollbackOk,
				...(rollbackError ? { error: rollbackError } : {}),
			},
		};
	}

	public async stop(): Promise<void> {
		const active = this.#active;
		this.#active = null;
		if (!active) {
			return;
		}
		await active.adapter.stop({ force: true, reason: "shutdown" });
	}
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
	runSupervisorSpawnProcess?: ControlPlaneRunSupervisorOpts["spawnProcess"];
	runSupervisorHeartbeatIntervalMs?: number;
	generation?: ControlPlaneGenerationContext;
	telemetry?: GenerationTelemetryRecorder | null;
	telegramGenerationHooks?: TelegramGenerationSwapHooks;
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

	if (detected.length === 0) {
		return null;
	}

	const paths = getControlPlanePaths(opts.repoRoot);

	const runtime = new ControlPlaneRuntime({ repoRoot: opts.repoRoot });
	let pipeline: ControlPlaneCommandPipeline | null = null;
	let runSupervisor: ControlPlaneRunSupervisor | null = null;
	let drainInterval: ReturnType<typeof setInterval> | null = null;
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
