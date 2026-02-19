/**
 * UI text formatting functions for mu-messaging-setup.
 */

import { adapterById, defaultRouteForAdapter, normalizePublicBaseUrl } from "./adapters.js";
import type { AdapterCheck, AdapterPlan, RuntimeState, VerifyOutcome } from "./types.js";
import type { AdapterId } from "./types.js";

export function iconForState(state: AdapterCheck["state"]): string {
	switch (state) {
		case "active":
			return "✅";
		case "configured_not_active":
			return "⚠️";
		case "missing_config":
			return "❌";
		case "planned":
			return "🧪";
	}
}

export function summarizeChecks(checks: AdapterCheck[]): string {
	const active = checks.filter((check) => check.state === "active").map((check) => check.id);
	const configured = checks.filter((check) => check.state === "configured_not_active").map((check) => check.id);
	const missing = checks.filter((check) => check.state === "missing_config").map((check) => check.id);
	const planned = checks.filter((check) => check.state === "planned").map((check) => check.id);
	const parts: string[] = [];
	if (active.length > 0) parts.push(`active: ${active.join(",")}`);
	if (configured.length > 0) parts.push(`reload-needed: ${configured.join(",")}`);
	if (missing.length > 0) parts.push(`missing-config: ${missing.join(",")}`);
	if (planned.length > 0) parts.push(`planned: ${planned.join(",")}`);
	return parts.join(" | ");
}

export function preflightSummary(checks: AdapterCheck[], runtime: RuntimeState): string {
	const lines = ["Messaging adapter preflight:", ""];
	if (checks.length === 0) {
		lines.push("(no matching adapters)");
	}
	for (const check of checks) {
		const route = check.route ? ` · route ${check.route}` : "";
		const missing = check.missing.length > 0 ? ` · missing ${check.missing.join(", ")}` : "";
		const support = check.support === "planned" ? "planned" : "available";
		lines.push(`${iconForState(check.state)} ${check.name} (${support})${route}${missing}`);
		lines.push(`   next: ${check.next_step}`);
	}
	if (runtime.configPath) {
		lines.push("", `config: ${runtime.configPath}`);
	}
	if (runtime.fetchError) {
		lines.push("", `runtime note: ${runtime.fetchError}`);
	}
	return lines.join("\n");
}

export function guideForAdapter(check: AdapterCheck): string {
	const adapter = adapterById(check.id);
	const vars = adapter.fields
		.map((field) => {
			const present = check.missing.includes(field.key) ? "MISSING" : "SET";
			const req = field.required ? "required" : "optional";
			return `- ${field.key} [${present}] (${req})\n  ${field.description}`;
		})
		.join("\n");

	return [
		`## ${adapter.name}`,
		`state: ${check.state}`,
		check.route ? `webhook route: ${check.route}` : "webhook route: not active",
		`next step: ${check.next_step}`,
		"",
		"config fields (.mu/config.json → control_plane.adapters.<adapter>):",
		vars,
		"",
		"provider setup steps:",
		...adapter.providerSetupSteps.map((step, index) => `${index + 1}. ${step}`),
		...(check.notes.length > 0 ? ["", "notes:", ...check.notes.map((note) => `- ${note}`)] : []),
	].join("\n");
}

export function setupGuide(checks: AdapterCheck[], adapterId?: AdapterId): string {
	if (adapterId) {
		const found = checks.find((check) => check.id === adapterId);
		if (!found) {
			return `Unknown adapter: ${adapterId}`;
		}
		return guideForAdapter(found);
	}

	const sections = checks.map((check) => guideForAdapter(check));
	return [
		"# Messaging Integration Setup",
		"",
		"Use `/mu setup <adapter>` to hand setup context to mu agent.",
		"Config source of truth is `.mu/config.json`.",
		"",
		...sections,
	].join("\n\n");
}

export function buildPlan(check: AdapterCheck, publicBaseUrl?: string): AdapterPlan {
	const adapter = adapterById(check.id);
	const normalizedBase = normalizePublicBaseUrl(publicBaseUrl);
	const route = check.route ?? defaultRouteForAdapter(check.id);
	const webhookUrl = normalizedBase ? `${normalizedBase}${route}` : null;
	const requiredFields = adapter.fields.filter((field) => field.required).map((field) => field.key);
	const steps: string[] = [];

	if (check.support === "planned") {
		steps.push("Adapter is planned; implementation is required before runtime activation.");
	} else {
		if (check.missing.length > 0) {
			steps.push(`Set required config fields: ${check.missing.join(", ")}.`);
			steps.push(`Run /mu setup apply ${check.id} to write config and reload control-plane.`);
		}
		if (check.state === "configured_not_active") {
			steps.push(`Run /mu setup apply ${check.id} to trigger control-plane reload.`);
		}
		if (webhookUrl) {
			steps.push(`Configure provider webhook/inbound URL to: ${webhookUrl}`);
		}
		steps.push(
			`Run verification: /mu setup verify ${check.id}${normalizedBase ? ` --public-base-url ${normalizedBase}` : ""}`,
		);
	}

	return {
		id: check.id,
		name: check.name,
		support: check.support,
		state: check.state,
		route,
		webhook_url: webhookUrl,
		required_fields: requiredFields,
		missing_required_fields: check.missing,
		steps,
		commands: {
			apply: `/mu setup apply ${check.id}`,
			verify: `/mu setup verify ${check.id}`,
		},
	};
}

export function planText(plan: AdapterPlan): string {
	const lines = [
		`# ${plan.name} wiring plan`,
		`state: ${plan.state}`,
		`support: ${plan.support}`,
		`route: ${plan.route}`,
		`required fields: ${plan.required_fields.join(", ") || "(none)"}`,
		`missing fields now: ${plan.missing_required_fields.join(", ") || "(none)"}`,
		`webhook url: ${plan.webhook_url ?? "(provide --public-base-url to compute)"}`,
		"",
		"steps:",
		...plan.steps.map((step, index) => `${index + 1}. ${step}`),
		"",
		"apply command:",
		plan.commands.apply,
		"",
		"verify command:",
		plan.commands.verify,
	];
	return lines.join("\n");
}

export function planSummary(plans: AdapterPlan[]): string {
	return plans.map((plan) => planText(plan)).join("\n\n");
}

export function verifyText(result: VerifyOutcome): string {
	const lines = [`Verification: ${result.ok ? "PASS" : "NOT READY"}`, ""];
	for (const check of result.targets) {
		const route = check.route ?? defaultRouteForAdapter(check.id);
		const webhookUrl = result.public_base_url ? `${result.public_base_url}${route}` : null;
		lines.push(`${iconForState(check.state)} ${check.name}: ${check.state}`);
		lines.push(`   route: ${route}`);
		if (webhookUrl) {
			lines.push(`   expected webhook URL: ${webhookUrl}`);
		}
		lines.push(`   next: ${check.next_step}`);
	}
	if (!result.ok) {
		lines.push("", "Tip: run `/mu setup plan <adapter>` for exact remediation steps.");
	}
	return lines.join("\n");
}
