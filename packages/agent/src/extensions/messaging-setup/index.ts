/**
 * mu-messaging-setup — Adapter configuration diagnostics + guided setup.
 *
 * Goals:
 * - Make `/mu setup <adapter>` hand setup context to the active mu agent.
 * - Keep configuration in `.mu/config.json` (no process.env mutations).
 * - Support plan/apply/verify workflow with in-process control-plane reload.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerMuSubcommand } from "../mu-command-dispatcher.js";
import { textResult, toJsonText } from "../shared.js";
import { ADAPTERS, normalizeAdapterId } from "./adapters.js";
import { applyAdapterConfig, buildVerifyOutcome, reloadOutcomeSummary } from "./actions.js";
import {
	buildAgentSetupPrompt,
	checksForAdapter,
	findCheckByAdapter,
	maybeDispatchAgentSetupBrief,
	parseSetupCommandArgs,
	runInteractiveApply,
} from "./parser.js";
import { collectChecksCached, refreshMessagingStatus } from "./runtime.js";
import { buildPlan, planSummary, preflightSummary, setupGuide, summarizeChecks, verifyText } from "./ui.js";

export type { AdapterId, AdapterCheck, AdapterPlan, RuntimeState, SetupAction } from "./types.js";
export type { ParsedSetupCommand } from "./parser.js";

export type MessagingSetupExtensionOpts = {
	allowApply?: boolean;
};

export function messagingSetupExtension(pi: ExtensionAPI, opts: MessagingSetupExtensionOpts = {}) {
	const allowApply = opts.allowApply ?? true;
	pi.on("before_agent_start", async (event) => {
		const { checks } = await collectChecksCached();
		const summary = summarizeChecks(checks);
		const lines = [
			"",
			"[MU MESSAGING]",
			summary.length > 0 ? summary : "no adapter status available",
			allowApply
				? "Use mu_messaging_setup(action=preflight|plan|apply|verify|guide) for operator workflow."
				: "Use mu_messaging_setup(action=preflight|plan|verify|guide) for query workflow.",
		];
		return {
			systemPrompt: `${event.systemPrompt}${lines.join("\n")}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshMessagingStatus(ctx);
	});

	const setupActions = allowApply
		? (["check", "preflight", "guide", "plan", "apply", "verify"] as const)
		: (["check", "preflight", "guide", "plan", "verify"] as const);
	const SetupParams = Type.Object({
		action: StringEnum(setupActions),
		adapter: Type.Optional(Type.String({ description: "Adapter name: slack, discord, telegram" })),
		public_base_url: Type.Optional(
			Type.String({
				description:
					"Optional public base URL used to compute expected webhook endpoints (e.g. https://example.ngrok.app)",
			}),
		),
		fields: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					"Config field overrides for apply action. Keys are field names (e.g. bot_token, webhook_secret), values are the secrets/tokens to write.",
			}),
		),
	});

	pi.registerTool({
		name: "mu_messaging_setup",
		label: "Messaging Setup",
		description: allowApply
			? "Messaging setup workflow. Actions: check/preflight/guide/plan/apply/verify. For apply, pass field values via the fields parameter (e.g. fields={bot_token:'...', webhook_secret:'...'})."
			: "Messaging setup query workflow. Actions: check/preflight/guide/plan/verify. Apply is disabled in query-only mode.",
		parameters: SetupParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const adapterId = params.adapter ? normalizeAdapterId(params.adapter) : null;
			if (params.adapter && !adapterId) {
				return textResult(
					`Unknown adapter: ${params.adapter}. Available: ${ADAPTERS.map((adapter) => adapter.id).join(", ")}`,
				);
			}

			switch (params.action) {
				case "check": {
					const { checks, runtime } = await collectChecksCached();
					const filteredChecks = checksForAdapter(checks, adapterId);
					return textResult(
						toJsonText({
							checks: filteredChecks,
							runtime: { ...runtime, routesByAdapter: Object.fromEntries(runtime.routesByAdapter) },
						}),
						{
							checks: filteredChecks,
							runtime,
							adapter: adapterId,
						},
					);
				}
				case "preflight": {
					const { checks, runtime } = await collectChecksCached();
					const filteredChecks = checksForAdapter(checks, adapterId);
					return textResult(preflightSummary(filteredChecks, runtime), {
						checks: filteredChecks,
						runtime,
						adapter: adapterId,
					});
				}
				case "guide":
				case "plan": {
					const { checks, runtime } = await collectChecksCached();
					if (adapterId) {
						const check = findCheckByAdapter(checks, adapterId);
						if (!check) {
							return textResult(`Unknown adapter: ${adapterId}`);
						}
						const plan = buildPlan(check, params.public_base_url);
						const brief = buildAgentSetupPrompt({
							check,
							plan,
							configPath: runtime.configPath,
							publicBaseUrl: params.public_base_url,
						});
						return textResult(brief, { checks, runtime, adapter: adapterId, plan });
					}
					if (params.action === "guide") {
						return textResult(setupGuide(checks), { checks, runtime, adapter: null });
					}
					const plans = checks.map((check) => buildPlan(check, params.public_base_url));
					return textResult(planSummary(plans), { plans, runtime, adapter: null });
				}
				case "apply": {
					if (!allowApply) {
						return textResult("apply is disabled in query-only mode. Use plan/guide/verify actions.", {
							blocked: true,
							reason: "messaging_setup_query_only_mode",
						});
					}
					if (!adapterId) {
						return textResult("apply requires adapter (slack|discord|telegram)");
					}

					const { runtime, checks } = await collectChecksCached(0);
					if (!runtime.configPresence) {
						return textResult(`Cannot read config presence: ${runtime.fetchError ?? "unknown error"}`);
					}
					const check = findCheckByAdapter(checks, adapterId);
					if (!check) {
						return textResult(`Unknown adapter: ${adapterId}`);
					}

					const overrides = params.fields ?? {};
					const stillMissing = check.missing.filter((field) => !(field in overrides));
					if (stillMissing.length > 0) {
						return textResult(
							`Cannot apply ${adapterId}: missing required config fields (${stillMissing.join(", ")}). Pass them via the fields parameter or use /mu setup apply ${adapterId} for guided input.`,
							{ adapter: adapterId, missing_required_fields: stillMissing },
						);
					}

					const outcome = await applyAdapterConfig({
						adapterId,
						overrides,
						presence: runtime.configPresence,
					});
					if (!outcome.ok) {
						return textResult(
							`Apply failed: ${outcome.reason} (${outcome.missing_required_fields.join(", ")}).`,
							outcome,
						);
					}

					const { checks: refreshed } = await collectChecksCached(0);
					const verify = buildVerifyOutcome(refreshed, { adapterId, publicBaseUrl: params.public_base_url });
					const lines = [
						`Updated config fields: ${outcome.updated_fields.join(", ") || "(none)"}`,
						`Config path: ${outcome.config_path ?? runtime.configPath ?? "(unknown)"}`,
						reloadOutcomeSummary(outcome.reload),
						"",
						verifyText(verify),
					];
					return textResult(lines.join("\n"), { outcome, verify });
				}
				case "verify": {
					const { checks } = await collectChecksCached(0);
					const verify = buildVerifyOutcome(checks, {
						adapterId: adapterId ?? undefined,
						publicBaseUrl: params.public_base_url,
					});
					return textResult(verifyText(verify), { verify });
				}
				default:
					return textResult(`Unknown action: ${params.action}`);
			}
		},
	});

	registerMuSubcommand(pi, {
		subcommand: "setup",
		summary: "Messaging adapter setup workflow (preflight/guide/plan/apply/verify)",
		usage: "/mu setup [preflight|guide|plan|apply|verify] [adapter] [--public-base-url URL] [--agent|--no-agent]",
		handler: async (args, ctx) => {
			const parsed = parseSetupCommandArgs(args);
			if (parsed.error) {
				ctx.ui.notify(
					`${parsed.error}. Usage: /mu setup [preflight|guide|plan|apply|verify] [adapter] [--public-base-url URL] [--agent|--no-agent]`,
					"error",
				);
				return;
			}

			switch (parsed.action) {
				case "check": {
					const { checks, runtime } = await collectChecksCached(0);
					const filteredChecks = checksForAdapter(checks, parsed.adapterId);
					ctx.ui.notify(
						toJsonText({
							checks: filteredChecks,
							runtime: { ...runtime, routesByAdapter: Object.fromEntries(runtime.routesByAdapter) },
						}),
						"info",
					);
					await refreshMessagingStatus(ctx);
					return;
				}
				case "preflight": {
					const { checks, runtime } = await collectChecksCached(0);
					if (await maybeDispatchAgentSetupBrief({ pi, ctx, parsed, checks, runtime })) {
						if (runtime.fetchError) {
							ctx.ui.notify(`runtime note: ${runtime.fetchError}`, "warning");
						}
						await refreshMessagingStatus(ctx);
						return;
					}
					const filteredChecks = checksForAdapter(checks, parsed.adapterId);
					ctx.ui.notify(preflightSummary(filteredChecks, runtime), "info");
					await refreshMessagingStatus(ctx);
					return;
				}
				case "guide": {
					const { checks, runtime } = await collectChecksCached(0);
					if (await maybeDispatchAgentSetupBrief({ pi, ctx, parsed, checks, runtime })) {
						if (runtime.fetchError) {
							ctx.ui.notify(`runtime note: ${runtime.fetchError}`, "warning");
						}
						await refreshMessagingStatus(ctx);
						return;
					}
					ctx.ui.notify(setupGuide(checks, parsed.adapterId ?? undefined), "info");
					if (runtime.fetchError) {
						ctx.ui.notify(`runtime note: ${runtime.fetchError}`, "warning");
					}
					await refreshMessagingStatus(ctx);
					return;
				}
				case "plan": {
					const { checks, runtime } = await collectChecksCached(0);
					if (await maybeDispatchAgentSetupBrief({ pi, ctx, parsed, checks, runtime })) {
						await refreshMessagingStatus(ctx);
						return;
					}
					const plans = parsed.adapterId
						? checks
								.filter((check) => check.id === parsed.adapterId)
								.map((check) => buildPlan(check, parsed.publicBaseUrl))
						: checks.map((check) => buildPlan(check, parsed.publicBaseUrl));
					ctx.ui.notify(planSummary(plans), "info");
					await refreshMessagingStatus(ctx);
					return;
				}
				case "apply": {
					if (!allowApply) {
						ctx.ui.notify(
							"apply is disabled in query-only mode. Use /mu setup plan and /mu setup verify.",
							"warning",
						);
						return;
					}
					if (!parsed.adapterId) {
						ctx.ui.notify("apply requires adapter. Example: /mu setup apply slack", "error");
						return;
					}
					const text = await runInteractiveApply(ctx, parsed.adapterId);
					ctx.ui.notify(text, "info");
					await refreshMessagingStatus(ctx);
					return;
				}
				case "verify": {
					const { checks, runtime } = await collectChecksCached(0);
					if (await maybeDispatchAgentSetupBrief({ pi, ctx, parsed, checks, runtime })) {
						await refreshMessagingStatus(ctx);
						return;
					}
					const verify = buildVerifyOutcome(checks, {
						adapterId: parsed.adapterId ?? undefined,
						publicBaseUrl: parsed.publicBaseUrl,
					});
					ctx.ui.notify(verifyText(verify), verify.ok ? "info" : "warning");
					await refreshMessagingStatus(ctx);
					return;
				}
			}
		},
	});
}

export default messagingSetupExtension;
