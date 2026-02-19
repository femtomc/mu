/**
 * Command argument parsing and agent dispatch for mu-messaging-setup.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadBundledPrompt } from "../../default_prompts.js";
import {
	adapterById,
	isSetupAction,
	normalizeAdapterId,
	normalizePublicBaseUrl,
} from "./adapters.js";
import { applyAdapterConfig, buildVerifyOutcome, reloadOutcomeSummary } from "./actions.js";
import { collectChecksCached } from "./runtime.js";
import { buildPlan, verifyText } from "./ui.js";
import type { AdapterCheck, AdapterConfig, AdapterId, AdapterPlan, RuntimeState, SetupAction } from "./types.js";

const MESSAGING_SETUP_BRIEF_TEMPLATE = loadBundledPrompt("skills/messaging-setup-brief.md");

function interpolateTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? `{{${key}}}`);
}

export type ParsedSetupCommand = {
	action: SetupAction;
	adapterId: AdapterId | null;
	publicBaseUrl: string | undefined;
	dispatchToAgent: "auto" | "force" | "off";
	error: string | null;
};

export function parseSetupCommandArgs(args: string): ParsedSetupCommand {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);

	const positional: string[] = [];
	let publicBaseUrl: string | undefined;
	let dispatchToAgent: "auto" | "force" | "off" = "auto";

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--agent") {
			dispatchToAgent = "force";
			continue;
		}
		if (token === "--no-agent") {
			dispatchToAgent = "off";
			continue;
		}
		if (token === "--public-base-url") {
			const next = tokens[i + 1];
			if (!next) {
				return {
					action: "preflight",
					adapterId: null,
					publicBaseUrl: undefined,
					dispatchToAgent,
					error: "Missing value for --public-base-url",
				};
			}
			publicBaseUrl = next;
			i += 1;
			continue;
		}
		if (token.startsWith("--public-base-url=")) {
			publicBaseUrl = token.slice("--public-base-url=".length);
			continue;
		}
		if (token.startsWith("--")) {
			return {
				action: "preflight",
				adapterId: null,
				publicBaseUrl: undefined,
				dispatchToAgent,
				error: `Unknown option: ${token}`,
			};
		}
		positional.push(token);
	}

	if (positional.length === 0) {
		return { action: "preflight", adapterId: null, publicBaseUrl, dispatchToAgent, error: null };
	}

	const first = positional[0]!.toLowerCase();
	if (isSetupAction(first)) {
		const action = first;
		const adapterId = positional[1] ? normalizeAdapterId(positional[1]!) : null;
		if (positional[1] && !adapterId) {
			return {
				action,
				adapterId: null,
				publicBaseUrl,
				dispatchToAgent,
				error: `Unknown adapter: ${positional[1]}`,
			};
		}
		if (positional.length > 2) {
			return {
				action,
				adapterId,
				publicBaseUrl,
				dispatchToAgent,
				error: `Unexpected extra arguments: ${positional.slice(2).join(" ")}`,
			};
		}
		return { action, adapterId, publicBaseUrl, dispatchToAgent, error: null };
	}

	const adapterId = normalizeAdapterId(first);
	if (!adapterId) {
		return {
			action: "preflight",
			adapterId: null,
			publicBaseUrl,
			dispatchToAgent,
			error: `Unknown adapter or action: ${positional[0]}`,
		};
	}

	if (positional.length === 1) {
		return { action: "guide", adapterId, publicBaseUrl, dispatchToAgent, error: null };
	}

	const second = positional[1]!.toLowerCase();
	if (!isSetupAction(second)) {
		return {
			action: "guide",
			adapterId,
			publicBaseUrl,
			dispatchToAgent,
			error: `Unknown action: ${positional[1]}`,
		};
	}
	if (positional.length > 2) {
		return {
			action: second,
			adapterId,
			publicBaseUrl,
			dispatchToAgent,
			error: `Unexpected extra arguments: ${positional.slice(2).join(" ")}`,
		};
	}
	return { action: second, adapterId, publicBaseUrl, dispatchToAgent, error: null };
}

export function shouldDispatchSetupToAgent(parsed: ParsedSetupCommand): boolean {
	if (parsed.dispatchToAgent === "force") return true;
	if (parsed.dispatchToAgent === "off") return false;
	if (!parsed.adapterId) return false;
	if (parsed.action === "apply" || parsed.action === "check") return false;
	return true;
}

export function adapterFieldStatusLines(adapter: AdapterConfig, check: AdapterCheck): string[] {
	return adapter.fields.map((field) => {
		const status = check.missing.includes(field.key) ? "MISSING" : "SET";
		return `- ${field.key}: ${status} (${field.required ? "required" : "optional"})`;
	});
}

export function buildAgentSetupPrompt(opts: {
	check: AdapterCheck;
	plan: AdapterPlan;
	configPath: string | null;
	publicBaseUrl?: string;
}): string {
	const adapter = adapterById(opts.check.id);
	const normalizedBase = normalizePublicBaseUrl(opts.publicBaseUrl);
	const webhookUrl = normalizedBase ? `${normalizedBase}${opts.plan.route}` : opts.plan.webhook_url;
	const verifyFlag = normalizedBase ? ` --public-base-url ${normalizedBase}` : "";
	return interpolateTemplate(MESSAGING_SETUP_BRIEF_TEMPLATE, {
		adapter_name: adapter.name,
		adapter_id: adapter.id,
		state: opts.check.state,
		config_path: opts.configPath ?? ".mu/config.json",
		route: opts.plan.route,
		webhook_url: webhookUrl ?? "(need public base URL)",
		missing_fields: opts.check.missing.join(", ") || "(none)",
		provider_steps: adapter.providerSetupSteps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
		field_status: adapterFieldStatusLines(adapter, opts.check).join("\n"),
		verify_command: `/mu setup verify ${adapter.id}${verifyFlag}`,
	});
}

export function dispatchSetupPromptToAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
		return;
	}
	pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

export function findCheckByAdapter(checks: AdapterCheck[], adapterId: AdapterId): AdapterCheck | null {
	return checks.find((check) => check.id === adapterId) ?? null;
}

export function checksForAdapter(checks: AdapterCheck[], adapterId: AdapterId | null): AdapterCheck[] {
	if (!adapterId) {
		return checks;
	}
	const match = checks.find((check) => check.id === adapterId);
	return match ? [match] : [];
}

export async function maybeDispatchAgentSetupBrief(opts: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	parsed: ParsedSetupCommand;
	checks: AdapterCheck[];
	runtime: RuntimeState;
}): Promise<boolean> {
	if (!opts.parsed.adapterId) return false;
	if (!shouldDispatchSetupToAgent(opts.parsed)) return false;
	const check = findCheckByAdapter(opts.checks, opts.parsed.adapterId);
	if (!check) return false;
	const plan = buildPlan(check, opts.parsed.publicBaseUrl);
	const prompt = buildAgentSetupPrompt({
		check,
		plan,
		configPath: opts.runtime.configPath,
		publicBaseUrl: opts.parsed.publicBaseUrl,
	});
	dispatchSetupPromptToAgent(opts.pi, opts.ctx, prompt);
	opts.ctx.ui.notify(`Sent ${check.name} setup brief to mu agent.`, "info");
	return true;
}

export async function runInteractiveApply(ctx: ExtensionCommandContext, adapterId: AdapterId): Promise<string> {
	const adapter = adapterById(adapterId);
	if (adapter.support === "planned") {
		return `${adapter.name} is currently planned and not runtime-available.`;
	}

	const { checks, runtime } = await collectChecksCached(0);
	if (!runtime.configPresence) {
		return `Cannot read config presence: ${runtime.fetchError ?? "unknown error"}`;
	}

	const check = findCheckByAdapter(checks, adapterId);
	if (!check) {
		return `Unknown adapter: ${adapterId}`;
	}

	const overrides: Record<string, string> = {};
	for (const key of check.missing) {
		const entered = await ctx.ui.input(`${adapter.name}: enter value for ${key}`);
		if (entered == null) {
			return "Cancelled apply flow.";
		}
		const value = entered.trim();
		if (value.length === 0) {
			return `Cancelled: empty value for ${key}.`;
		}
		overrides[key] = value;
	}

	const applyConfirmed = await ctx.ui.confirm(
		`Apply ${adapter.name} configuration?`,
		`This writes to .mu/config.json and triggers in-process control-plane reload.`,
	);
	if (!applyConfirmed) {
		return "Apply cancelled.";
	}

	const outcome = await applyAdapterConfig({
		adapterId,
		overrides,
		presence: runtime.configPresence,
	});

	if (!outcome.ok) {
		return `Apply failed: ${outcome.reason} (${outcome.missing_required_fields.join(", ")}).`;
	}

	const { checks: refreshedChecks } = await collectChecksCached(0);
	const verify = buildVerifyOutcome(refreshedChecks, { adapterId });
	const lines = [
		`Updated config fields: ${outcome.updated_fields.join(", ") || "(none)"}`,
		`Config path: ${outcome.config_path ?? runtime.configPath ?? "(unknown)"}`,
		reloadOutcomeSummary(outcome.reload),
		"",
		verifyText(verify),
	];
	return lines.join("\n");
}
