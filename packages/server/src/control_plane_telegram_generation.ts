import {
	ControlPlaneCommandPipeline,
	ControlPlaneOutbox,
	type ControlPlaneSignalObserver,
	type ReloadableGenerationIdentity,
	TelegramControlPlaneAdapter,
} from "@femtomc/mu-control-plane";
import type {
	ControlPlaneConfig,
	TelegramGenerationReloadResult,
	TelegramGenerationRollbackTrigger,
	TelegramGenerationSwapHooks,
} from "./control_plane_contract.js";

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
			neovim: config.adapters.neovim,
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

export class TelegramAdapterGenerationManager {
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

