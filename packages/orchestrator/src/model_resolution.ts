import type { Model } from "@mariozechner/pi-ai";
import { getModels, getProviders, supportsXhigh } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

export type ModelOverrides = {
	model?: string;
	provider?: string;
	reasoning?: string;
};

export type ResolvedModelConfig = {
	provider: string;
	model: string;
	reasoning: string;
};

/**
 * Rank models by capability: xhigh > reasoning > output cost (proxy for tier) > context window.
 * xhigh-capable models (GPT-5.x, Opus 4.6) are strongly preferred over older generations.
 */
function rankModel(m: Model<any>): number {
	const xhighScore = supportsXhigh(m) ? 10_000_000 : 0;
	const reasoningScore = m.reasoning ? 1_000_000 : 0;
	const costScore = (m.cost?.output ?? 0) * 1_000;
	const ctxScore = (m.contextWindow ?? 0) / 1_000_000;
	return xhighScore + reasoningScore + costScore + ctxScore;
}

function pickReasoning(model: Model<any>, explicit?: string): string {
	if (explicit) return explicit;
	if (supportsXhigh(model)) return "xhigh";
	if (model.reasoning) return "high";
	return "high";
}

/**
 * Resolve model configuration from overrides and authenticated providers.
 *
 * Resolution order:
 *   1. Explicit --model: find across providers (prefer auth'd)
 *   2. Explicit --provider only: pick best model from that provider
 *   3. Auto-detect: best model from any auth'd provider
 */
export function resolveModelConfig(overrides: ModelOverrides, authStorage?: AuthStorage): ResolvedModelConfig {
	const auth = authStorage ?? AuthStorage.create();

	if (overrides.model) {
		return resolveExplicitModel(overrides.model, overrides.provider, overrides.reasoning, auth);
	}

	if (overrides.provider) {
		return resolveFromProvider(overrides.provider, overrides.reasoning, auth);
	}

	return autoDetect(overrides.reasoning, auth);
}

function resolveExplicitModel(
	modelId: string,
	providerConstraint: string | undefined,
	reasoningOverride: string | undefined,
	auth: AuthStorage,
): ResolvedModelConfig {
	const providers = getProviders();
	if (providerConstraint && !providers.includes(providerConstraint as any)) {
		throw new Error(`Unknown provider "${providerConstraint}". Available: ${providers.join(", ")}`);
	}

	let fallback: { provider: string; model: Model<any> } | undefined;

	for (const provider of providers) {
		if (providerConstraint && provider !== providerConstraint) continue;

		const models = getModels(provider);
		const match = models.find((m) => m.id === modelId);
		if (!match) continue;

		if (auth.hasAuth(provider)) {
			return { provider, model: match.id, reasoning: pickReasoning(match, reasoningOverride) };
		}
		if (!fallback) {
			fallback = { provider, model: match };
		}
	}

	if (fallback) {
		return {
			provider: fallback.provider,
			model: fallback.model.id,
			reasoning: pickReasoning(fallback.model, reasoningOverride),
		};
	}

	const scope = providerConstraint ? ` in provider "${providerConstraint}"` : "";
	throw new Error(`Model "${modelId}" not found${scope}. Run \`mu login --list\` to see available providers.`);
}

function resolveFromProvider(
	providerId: string,
	reasoningOverride: string | undefined,
	auth: AuthStorage,
): ResolvedModelConfig {
	const providers = getProviders();
	if (!providers.includes(providerId as any)) {
		throw new Error(`Unknown provider "${providerId}". Available: ${providers.join(", ")}`);
	}

	if (!auth.hasAuth(providerId)) {
		throw new Error(`No auth for provider "${providerId}". Run \`mu login ${providerId}\``);
	}

	const models = getModels(providerId as any);
	if (models.length === 0) {
		throw new Error(`No models available for provider "${providerId}".`);
	}

	const best = [...models].sort((a, b) => rankModel(b) - rankModel(a))[0]!;
	return { provider: providerId, model: best.id, reasoning: pickReasoning(best, reasoningOverride) };
}

const PREFERRED_MODEL = "gpt-5.3-codex";

function autoDetect(reasoningOverride: string | undefined, auth: AuthStorage): ResolvedModelConfig {
	const authedModels: Array<{ provider: string; model: Model<any> }> = [];

	for (const provider of getProviders()) {
		if (!auth.hasAuth(provider)) continue;
		for (const model of getModels(provider)) {
			authedModels.push({ provider, model });
		}
	}

	if (authedModels.length === 0) {
		throw new Error("No authenticated providers. Run `mu login` to authenticate.");
	}

	// Prefer the default model if available and xhigh-capable.
	const preferred = authedModels.find((e) => e.model.id === PREFERRED_MODEL && supportsXhigh(e.model));
	if (preferred) {
		return {
			provider: preferred.provider,
			model: preferred.model.id,
			reasoning: pickReasoning(preferred.model, reasoningOverride),
		};
	}

	const best = authedModels.sort((a, b) => rankModel(b.model) - rankModel(a.model))[0]!;
	return {
		provider: best.provider,
		model: best.model.id,
		reasoning: pickReasoning(best.model, reasoningOverride),
	};
}
