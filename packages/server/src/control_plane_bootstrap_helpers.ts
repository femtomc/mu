import {
	ApprovedCommandBroker,
	CommandContextResolver,
	type MessagingOperatorBackend,
	MessagingOperatorRuntime,
	operatorExtensionPaths,
	PiMessagingOperatorBackend,
} from "@femtomc/mu-agent";
import {
	ControlPlaneOutboxDispatcher,
	type ControlPlaneOutbox,
	type OutboxDeliveryHandlerResult,
	type OutboxRecord,
} from "@femtomc/mu-control-plane";
import type { ControlPlaneConfig } from "./control_plane_contract.js";

const DEFAULT_OUTBOX_DRAIN_INTERVAL_MS = 500;

export function buildMessagingOperatorRuntime(opts: {
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

export function createOutboxDrainLoop(opts: {
	outbox: ControlPlaneOutbox;
	deliver: (record: OutboxRecord) => Promise<undefined | OutboxDeliveryHandlerResult>;
	intervalMs?: number;
}): {
	scheduleOutboxDrain: () => void;
	stop: () => void;
} {
	const dispatcher = new ControlPlaneOutboxDispatcher({
		outbox: opts.outbox,
		deliver: opts.deliver,
	});

	let drainInterval: ReturnType<typeof setInterval> | null = null;
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

	drainInterval = setInterval(
		() => {
			scheduleOutboxDrain();
		},
		Math.max(1, Math.trunc(opts.intervalMs ?? DEFAULT_OUTBOX_DRAIN_INTERVAL_MS)),
	);
	scheduleOutboxDrain();

	return {
		scheduleOutboxDrain,
		stop: () => {
			if (drainInterval) {
				clearInterval(drainInterval);
				drainInterval = null;
			}
		},
	};
}
