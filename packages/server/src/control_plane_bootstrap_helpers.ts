import {
	ApprovedCommandBroker,
	CommandContextResolver,
	JsonFileConversationSessionStore,
	type MessagingOperatorBackend,
	MessagingOperatorRuntime,
	operatorExtensionPaths,
	PiMessagingOperatorBackend,
} from "@femtomc/mu-agent";
import { join } from "node:path";
import {
	ControlPlaneOutbox,
	ControlPlaneOutboxDispatcher,
	type OutboxDeliveryHandlerResult,
	type OutboxDispatchOutcome,
	type OutboxRecord,
} from "@femtomc/mu-control-plane";
import type { ControlPlaneConfig } from "./control_plane_contract.js";

const OUTBOX_DRAIN_INTERVAL_MS = 500;

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
	const conversationSessionStore = new JsonFileConversationSessionStore(
		join(opts.repoRoot, ".mu", "control-plane", "operator_conversations.json"),
	);

	return new MessagingOperatorRuntime({
		backend,
		broker: new ApprovedCommandBroker({
			runTriggersEnabled: opts.config.operator.run_triggers_enabled,
			contextResolver: new CommandContextResolver({ allowedRepoRoots: [opts.repoRoot] }),
		}),
		enabled: true,
		conversationSessionStore,
	});
}

export function createOutboxDrainLoop(opts: {
	outbox: ControlPlaneOutbox;
	deliver: (record: OutboxRecord) => Promise<undefined | OutboxDeliveryHandlerResult>;
	onOutcome?: (outcome: OutboxDispatchOutcome) => void | Promise<void>;
}): {
	scheduleOutboxDrain: () => void;
	stop: () => void;
} {
	const dispatcher = new ControlPlaneOutboxDispatcher({
		outbox: opts.outbox,
		deliver: opts.deliver,
	});

	let drainingOutbox = false;
	let drainRequested = false;
	let stopped = false;

	const drainOutboxNow = async (): Promise<void> => {
		if (stopped) {
			return;
		}
		if (drainingOutbox) {
			drainRequested = true;
			return;
		}
		drainingOutbox = true;
		try {
			do {
				drainRequested = false;
				const outcomes = await dispatcher.drainDue();
				if (opts.onOutcome) {
					for (const outcome of outcomes) {
						try {
							await opts.onOutcome(outcome);
						} catch {
							// Keep telemetry callbacks non-fatal.
						}
					}
				}
			} while (drainRequested && !stopped);
		} catch {
			// Swallow errors — dispatcher handles retry progression internally.
		} finally {
			drainingOutbox = false;
		}
	};

	const scheduleOutboxDrain = (): void => {
		if (stopped) {
			return;
		}
		queueMicrotask(() => {
			void drainOutboxNow();
		});
	};

	const interval = setInterval(() => {
		scheduleOutboxDrain();
	}, OUTBOX_DRAIN_INTERVAL_MS);
	scheduleOutboxDrain();

	return {
		scheduleOutboxDrain,
		stop: () => {
			if (stopped) {
				return;
			}
			stopped = true;
			clearInterval(interval);
		},
	};
}
