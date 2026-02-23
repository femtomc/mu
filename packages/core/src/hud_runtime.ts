import { type HudDoc, normalizeHudDocs } from "./hud.js";

export type HudProviderRuntimeApi<Msg> = {
	dispatch: (message: Msg) => void;
};

export type HudProviderReducerResult<State, Effect> = {
	state: State;
	effects?: Effect[];
};

export type HudProvider<State, Msg, Effect> = {
	id: string;
	initialState: () => State;
	reduce: (state: State, message: Msg) => HudProviderReducerResult<State, Effect>;
	runEffect?: (effect: Effect, api: HudProviderRuntimeApi<Msg>) => void | Promise<void>;
	view: (state: State) => HudDoc | HudDoc[] | null;
};

type HudProviderAny = HudProvider<unknown, unknown, unknown>;

type HudProviderRecord = {
	provider: HudProviderAny;
	state: unknown;
};

export type HudRuntimeSnapshot = {
	provider_id: string;
	hud_docs: HudDoc[];
};

export type HudRuntimeListener = (snapshot: HudRuntimeSnapshot) => void;

export type HudRuntimeDispatchResult = {
	provider_id: string;
	messages_processed: number;
	effects_processed: number;
	hud_docs: HudDoc[];
};

export class HudRuntime {
	readonly #providers = new Map<string, HudProviderRecord>();
	readonly #listeners = new Set<HudRuntimeListener>();

	public register<State, Msg, Effect>(provider: HudProvider<State, Msg, Effect>): void {
		const providerId = provider.id.trim();
		if (providerId.length === 0) {
			throw new Error("provider id must be non-empty");
		}
		if (this.#providers.has(providerId)) {
			throw new Error(`provider already registered: ${providerId}`);
		}
		this.#providers.set(providerId, {
			provider: provider as HudProviderAny,
			state: provider.initialState(),
		});
		this.#emit(providerId);
	}

	public unregister(providerId: string): boolean {
		const normalized = providerId.trim();
		if (normalized.length === 0) {
			return false;
		}
		return this.#providers.delete(normalized);
	}

	public listProviders(): string[] {
		return [...this.#providers.keys()].sort((a, b) => a.localeCompare(b));
	}

	public subscribe(listener: HudRuntimeListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	public snapshot(providerId: string): HudRuntimeSnapshot {
		const record = this.#provider(providerId);
		const hudDocs = this.#hudDocs(record.provider, record.state);
		return {
			provider_id: providerId,
			hud_docs: hudDocs,
		};
	}

	public async dispatch<Msg>(providerId: string, message: Msg): Promise<HudRuntimeDispatchResult> {
		const record = this.#provider(providerId);
		const provider = record.provider as HudProvider<unknown, Msg, unknown>;
		const messageQueue: Msg[] = [message];
		let messagesProcessed = 0;
		let effectsProcessed = 0;

		while (messageQueue.length > 0) {
			const currentMessage = messageQueue.shift()!;
			messagesProcessed += 1;
			const reduced = provider.reduce(record.state, currentMessage);
			record.state = reduced.state;
			const effects = Array.isArray(reduced.effects) ? reduced.effects : [];
			for (const effect of effects) {
				effectsProcessed += 1;
				if (!provider.runEffect) {
					continue;
				}
				const api: HudProviderRuntimeApi<Msg> = {
					dispatch: (nextMessage: Msg) => {
						messageQueue.push(nextMessage);
					},
				};
				await provider.runEffect(effect, api);
			}
		}

		const snapshot = this.#emit(providerId);
		return {
			provider_id: providerId,
			messages_processed: messagesProcessed,
			effects_processed: effectsProcessed,
			hud_docs: snapshot.hud_docs,
		};
	}

	#provider(providerId: string): HudProviderRecord {
		const normalized = providerId.trim();
		if (normalized.length === 0) {
			throw new Error("provider id must be non-empty");
		}
		const record = this.#providers.get(normalized);
		if (!record) {
			throw new Error(`unknown provider: ${normalized}`);
		}
		return record;
	}

	#hudDocs(provider: HudProviderAny, state: unknown): HudDoc[] {
		const viewed = provider.view(state);
		if (viewed == null) {
			return [];
		}
		return normalizeHudDocs(Array.isArray(viewed) ? viewed : [viewed]);
	}

	#emit(providerId: string): HudRuntimeSnapshot {
		const record = this.#provider(providerId);
		const snapshot: HudRuntimeSnapshot = {
			provider_id: providerId,
			hud_docs: this.#hudDocs(record.provider, record.state),
		};
		for (const listener of this.#listeners) {
			listener(snapshot);
		}
		return snapshot;
	}
}
