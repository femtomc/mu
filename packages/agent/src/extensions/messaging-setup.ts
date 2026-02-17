/**
 * mu-messaging-setup — Adapter configuration diagnostics + guided setup.
 *
 * Goals:
 * - Make `/mu-setup <adapter>` hand setup context to the active mu agent.
 * - Keep configuration in `.mu/config.json` (no process.env mutations).
 * - Support plan/apply/verify workflow with in-process control-plane reload.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadBundledPrompt } from "../default_prompts.js";
import { fetchMuJson, fetchMuStatus, muServerUrl, textResult, toJsonText } from "./shared.js";

const MESSAGING_SETUP_BRIEF_TEMPLATE = loadBundledPrompt("skills/messaging-setup-brief.md");

function interpolateTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? `{{${key}}}`);
}

type AdapterSupport = "available" | "planned";
type AdapterId = "slack" | "discord" | "telegram" | "gmail";
type SetupAction = "check" | "preflight" | "guide" | "plan" | "apply" | "verify";

type AdapterField = {
	key: string;
	required: boolean;
	description: string;
};

type AdapterConfig = {
	id: AdapterId;
	name: string;
	support: AdapterSupport;
	fields: AdapterField[];
	providerSetupSteps: string[];
	notes?: string[];
};

type RuntimeState = {
	repoRoot: string | null;
	configPath: string | null;
	runtimeActive: boolean;
	routesByAdapter: Map<string, string>;
	configPresence: ConfigPresence | null;
	fetchError: string | null;
};

type AdapterCheck = {
	id: AdapterId;
	name: string;
	support: AdapterSupport;
	configured: boolean;
	missing: string[];
	active: boolean;
	route: string | null;
	state: "active" | "configured_not_active" | "missing_config" | "planned";
	next_step: string;
	notes: string[];
};

type AdapterPlan = {
	id: AdapterId;
	name: string;
	support: AdapterSupport;
	state: AdapterCheck["state"];
	route: string;
	webhook_url: string | null;
	required_fields: string[];
	missing_required_fields: string[];
	steps: string[];
	commands: {
		apply: string;
		verify: string;
	};
};

type ApplyOutcome =
	| {
			ok: true;
			adapter: AdapterId;
			updated_fields: string[];
			config_path: string | null;
			reload: ControlPlaneReloadOutcome;
	  }
	| {
			ok: false;
			adapter: AdapterId;
			reason: string;
			missing_required_fields: string[];
			reload?: ControlPlaneReloadOutcome;
	  };

type VerifyOutcome = {
	ok: boolean;
	targets: AdapterCheck[];
	public_base_url: string | null;
};

type ConfigPresence = {
	control_plane: {
		adapters: {
			slack: {
				signing_secret: boolean;
			};
			discord: {
				signing_secret: boolean;
			};
			telegram: {
				webhook_secret: boolean;
				bot_token: boolean;
				bot_username: boolean;
			};
			gmail: {
				enabled: boolean;
				webhook_secret: boolean;
				client_id: boolean;
				client_secret: boolean;
				refresh_token: boolean;
			};
		};
		operator: {
			enabled: boolean;
			run_triggers_enabled: boolean;
			provider: boolean;
			model: boolean;
		};
	};
};

type ConfigReadResponse = {
	repo_root: string;
	config_path: string;
	presence: ConfigPresence;
};

type ConfigWriteResponse = {
	ok: boolean;
	repo_root: string;
	config_path: string;
	presence: ConfigPresence;
};

type ControlPlaneGenerationIdentity = { generation_id: string; generation_seq: number };

type ControlPlaneReloadGenerationSummary = {
	attempt_id: string;
	coalesced: boolean;
	from_generation: ControlPlaneGenerationIdentity | null;
	to_generation: ControlPlaneGenerationIdentity;
	active_generation: ControlPlaneGenerationIdentity | null;
	outcome: "success" | "failure";
};

type ControlPlaneReloadApiResponse = {
	ok: boolean;
	reason: string;
	previous_control_plane?: {
		active: boolean;
		adapters: string[];
		routes: Array<{ name: string; route: string }>;
	};
	control_plane?: {
		active: boolean;
		adapters: string[];
		routes: Array<{ name: string; route: string }>;
	};
	generation: ControlPlaneReloadGenerationSummary;
	telegram_generation: {
		handled: boolean;
		ok: boolean;
		rollback: {
			requested: boolean;
			trigger: string | null;
			attempted: boolean;
			ok: boolean;
			error?: string;
		};
	} | null;
	error?: string;
};

type ControlPlaneReloadOutcome = {
	ok: boolean;
	response: ControlPlaneReloadApiResponse | null;
	error: string | null;
};

const ADAPTERS: AdapterConfig[] = [
	{
		id: "slack",
		name: "Slack",
		support: "available",
		fields: [
			{
				key: "signing_secret",
				required: true,
				description: "Slack Signing Secret used to validate inbound webhook signatures.",
			},
		],
		providerSetupSteps: [
			"Create/open your Slack App (api.slack.com/apps).",
			"Copy Signing Secret into .mu/config.json → control_plane.adapters.slack.signing_secret.",
			"Create a Slash Command (e.g. /mu) with Request URL <public-base-url>/webhooks/slack.",
			"Install/reinstall app after command changes.",
			"Run /mu in Slack, then /mu-setup verify slack.",
		],
	},
	{
		id: "discord",
		name: "Discord",
		support: "available",
		fields: [
			{
				key: "signing_secret",
				required: true,
				description: "Discord interaction public key for signature verification.",
			},
		],
		providerSetupSteps: [
			"Create/open app in Discord Developer Portal.",
			"Copy Interaction Public Key into .mu/config.json → control_plane.adapters.discord.signing_secret.",
			"Set Interactions Endpoint URL to <public-base-url>/webhooks/discord.",
			"Run a Discord command interaction, then /mu-setup verify discord.",
		],
	},
	{
		id: "telegram",
		name: "Telegram",
		support: "available",
		fields: [
			{
				key: "webhook_secret",
				required: true,
				description: "Telegram webhook secret token.",
			},
			{
				key: "bot_token",
				required: true,
				description: "Telegram bot token used for outbound replies.",
			},
			{
				key: "bot_username",
				required: false,
				description: "Optional bot username used for mention normalization.",
			},
		],
		providerSetupSteps: [
			"Create bot with @BotFather and place token in control_plane.adapters.telegram.bot_token.",
			"Set control_plane.adapters.telegram.webhook_secret to a random secret string.",
			"Call Telegram setWebhook using URL <public-base-url>/webhooks/telegram and matching secret_token.",
			"Link your Telegram identity to control-plane policy (mu control link --channel telegram --actor-id <telegram-user-id> --tenant-id telegram-bot --role <viewer|contributor|operator>).",
			"Optionally set control_plane.adapters.telegram.bot_username.",
			"Send /mu in Telegram chat, then /mu-setup verify telegram.",
		],
	},
	{
		id: "gmail",
		name: "Gmail",
		support: "planned",
		fields: [
			{ key: "enabled", required: true, description: "Enable planned Gmail adapter once implemented." },
			{ key: "webhook_secret", required: true, description: "Webhook/shared secret for ingress verification." },
			{ key: "client_id", required: true, description: "Google OAuth client id." },
			{ key: "client_secret", required: true, description: "Google OAuth client secret." },
			{ key: "refresh_token", required: true, description: "Offline refresh token for mailbox access." },
		],
		providerSetupSteps: [
			"Create Google OAuth credentials and obtain refresh token for Gmail scopes.",
			"Populate control_plane.adapters.gmail fields in .mu/config.json.",
			"Track control-plane implementation progress before expecting runtime activation.",
		],
		notes: [
			"Gmail adapter is planned but not mounted by current runtime.",
			"Use this guidance for planning and future rollout prep.",
		],
	},
];

const SETUP_ACTIONS: readonly SetupAction[] = ["check", "preflight", "guide", "plan", "apply", "verify"] as const;

function isSetupAction(value: string): value is SetupAction {
	return (SETUP_ACTIONS as readonly string[]).includes(value);
}

function normalizeAdapterId(input: string): AdapterId | null {
	const normalized = input.trim().toLowerCase();
	switch (normalized) {
		case "slack":
		case "discord":
		case "telegram":
		case "gmail":
			return normalized;
		default:
			return null;
	}
}

function defaultRouteForAdapter(id: AdapterId): string {
	return `/webhooks/${id}`;
}

function normalizePublicBaseUrl(input: string | undefined): string | null {
	if (!input) return null;
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}
		const normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return null;
	}
}

function adapterById(id: AdapterId): AdapterConfig {
	const found = ADAPTERS.find((adapter) => adapter.id === id);
	if (!found) {
		throw new Error(`Unknown adapter id: ${id}`);
	}
	return found;
}

function fieldPresent(presence: ConfigPresence, adapterId: AdapterId, key: string): boolean {
	switch (adapterId) {
		case "slack":
			return key === "signing_secret" ? presence.control_plane.adapters.slack.signing_secret : false;
		case "discord":
			return key === "signing_secret" ? presence.control_plane.adapters.discord.signing_secret : false;
		case "telegram":
			if (key === "webhook_secret") return presence.control_plane.adapters.telegram.webhook_secret;
			if (key === "bot_token") return presence.control_plane.adapters.telegram.bot_token;
			if (key === "bot_username") return presence.control_plane.adapters.telegram.bot_username;
			return false;
		case "gmail":
			if (key === "enabled") return presence.control_plane.adapters.gmail.enabled;
			if (key === "webhook_secret") return presence.control_plane.adapters.gmail.webhook_secret;
			if (key === "client_id") return presence.control_plane.adapters.gmail.client_id;
			if (key === "client_secret") return presence.control_plane.adapters.gmail.client_secret;
			if (key === "refresh_token") return presence.control_plane.adapters.gmail.refresh_token;
			return false;
	}
}

async function fetchConfigPresence(): Promise<ConfigReadResponse> {
	return await fetchMuJson<ConfigReadResponse>("/api/config", { timeoutMs: 4_000 });
}

async function fetchRuntimeState(): Promise<RuntimeState> {
	if (!muServerUrl()) {
		return {
			repoRoot: null,
			configPath: null,
			runtimeActive: false,
			routesByAdapter: new Map(),
			configPresence: null,
			fetchError: "MU_SERVER_URL not set",
		};
	}

	try {
		const [status, config] = await Promise.all([fetchMuStatus(2_000), fetchConfigPresence()]);
		const cp = status.control_plane ?? {
			active: false,
			adapters: [] as string[],
			routes: [] as { name: string; route: string }[],
		};
		const routesByAdapter = new Map<string, string>();
		for (const route of cp.routes ?? []) {
			routesByAdapter.set(route.name, route.route);
		}
		for (const adapter of cp.adapters) {
			if (!routesByAdapter.has(adapter)) {
				routesByAdapter.set(adapter, `/webhooks/${adapter}`);
			}
		}
		return {
			repoRoot: status.repo_root,
			configPath: config.config_path,
			runtimeActive: cp.active,
			routesByAdapter,
			configPresence: config.presence,
			fetchError: null,
		};
	} catch (err) {
		return {
			repoRoot: null,
			configPath: null,
			runtimeActive: false,
			routesByAdapter: new Map(),
			configPresence: null,
			fetchError: err instanceof Error ? err.message : String(err),
		};
	}
}

function missingRequiredFields(adapter: AdapterConfig, presence: ConfigPresence | null): string[] {
	if (!presence) {
		return adapter.fields.filter((field) => field.required).map((field) => field.key);
	}
	return adapter.fields
		.filter((field) => field.required && !fieldPresent(presence, adapter.id, field.key))
		.map((field) => field.key);
}

function configured(adapter: AdapterConfig, presence: ConfigPresence | null): boolean {
	return missingRequiredFields(adapter, presence).length === 0;
}

function deriveState(opts: { adapter: AdapterConfig; configured: boolean; active: boolean }): AdapterCheck["state"] {
	if (opts.adapter.support === "planned") return "planned";
	if (opts.active) return "active";
	if (opts.configured) return "configured_not_active";
	return "missing_config";
}

function nextStepForState(opts: { state: AdapterCheck["state"]; missing: string[] }): string {
	switch (opts.state) {
		case "active":
			return "No action needed. Adapter is mounted and receiving webhooks.";
		case "configured_not_active":
			return "Run `/mu-setup apply <adapter>` to trigger in-process control-plane reload.";
		case "missing_config":
			return `Set required config fields: ${opts.missing.join(", ")}.`;
		case "planned":
			return "Adapter is planned. Track implementation work before expecting runtime activation.";
	}
}

async function collectChecks(): Promise<{ checks: AdapterCheck[]; runtime: RuntimeState }> {
	const runtime = await fetchRuntimeState();
	const checks: AdapterCheck[] = ADAPTERS.map((adapter) => {
		const missing = missingRequiredFields(adapter, runtime.configPresence);
		const isConfigured = configured(adapter, runtime.configPresence);
		const active = runtime.routesByAdapter.has(adapter.id);
		const route = runtime.routesByAdapter.get(adapter.id) ?? null;
		const state = deriveState({ adapter, configured: isConfigured, active });
		const notes = [...(adapter.notes ?? [])];
		if (runtime.fetchError && runtime.fetchError !== "MU_SERVER_URL not set") {
			notes.push(`Runtime/config status unavailable: ${runtime.fetchError}`);
		}
		if (runtime.configPath) {
			notes.push(`Config path: ${runtime.configPath}`);
		}
		return {
			id: adapter.id,
			name: adapter.name,
			support: adapter.support,
			configured: isConfigured,
			missing,
			active,
			route,
			state,
			next_step: nextStepForState({ state, missing }),
			notes,
		};
	});
	return { checks, runtime };
}

let checksCache: { tsMs: number; value: Awaited<ReturnType<typeof collectChecks>> } | null = null;

async function collectChecksCached(ttlMs: number = 4_000): Promise<Awaited<ReturnType<typeof collectChecks>>> {
	if (ttlMs <= 0) {
		const value = await collectChecks();
		checksCache = { tsMs: Date.now(), value };
		return value;
	}

	const now = Date.now();
	if (checksCache && now - checksCache.tsMs <= ttlMs) {
		return checksCache.value;
	}
	const value = await collectChecks();
	checksCache = { tsMs: now, value };
	return value;
}

function iconForState(state: AdapterCheck["state"]): string {
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

function summarizeChecks(checks: AdapterCheck[]): string {
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

function preflightSummary(checks: AdapterCheck[], runtime: RuntimeState): string {
	const lines = ["Messaging adapter preflight:", ""];
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

function guideForAdapter(check: AdapterCheck): string {
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

function setupGuide(checks: AdapterCheck[], adapterId?: AdapterId): string {
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
		"Use `/mu-setup <adapter>` to hand setup context to mu agent.",
		"Config source of truth is `.mu/config.json`.",
		"",
		...sections,
	].join("\n\n");
}

function buildPlan(check: AdapterCheck, publicBaseUrl?: string): AdapterPlan {
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
			steps.push(`Run /mu-setup apply ${check.id} to write config and reload control-plane.`);
		}
		if (check.state === "configured_not_active") {
			steps.push(`Run /mu-setup apply ${check.id} to trigger control-plane reload.`);
		}
		if (webhookUrl) {
			steps.push(`Configure provider webhook/inbound URL to: ${webhookUrl}`);
		}
		steps.push(
			`Run verification: /mu-setup verify ${check.id}${normalizedBase ? ` --public-base-url ${normalizedBase}` : ""}`,
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
			apply: `/mu-setup apply ${check.id}`,
			verify: `/mu-setup verify ${check.id}`,
		},
	};
}

function planText(plan: AdapterPlan): string {
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

function planSummary(plans: AdapterPlan[]): string {
	return plans.map((plan) => planText(plan)).join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isControlPlaneGenerationIdentity(value: unknown): value is ControlPlaneGenerationIdentity {
	if (!isRecord(value)) return false;
	return typeof value.generation_id === "string" && typeof value.generation_seq === "number";
}

function isControlPlaneReloadGenerationSummary(value: unknown): value is ControlPlaneReloadGenerationSummary {
	if (!isRecord(value)) return false;
	if (typeof value.attempt_id !== "string") return false;
	if (typeof value.coalesced !== "boolean") return false;
	if (value.from_generation !== null && !isControlPlaneGenerationIdentity(value.from_generation)) return false;
	if (!isControlPlaneGenerationIdentity(value.to_generation)) return false;
	if (value.active_generation !== null && !isControlPlaneGenerationIdentity(value.active_generation)) return false;
	return value.outcome === "success" || value.outcome === "failure";
}

function parseControlPlaneReloadApiResponse(raw: string): {
	response: ControlPlaneReloadApiResponse | null;
	error: string | null;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return {
			response: null,
			error: "control-plane reload returned invalid JSON response",
		};
	}

	if (!isRecord(parsed)) {
		return {
			response: null,
			error: "control-plane reload returned non-object payload",
		};
	}

	if (!isControlPlaneReloadGenerationSummary(parsed.generation)) {
		return {
			response: null,
			error: "control-plane reload response missing generation metadata (expected generation-scoped contract)",
		};
	}

	const parsedRecord = parsed as Record<string, unknown>;
	const response = {
		...(parsed as ControlPlaneReloadApiResponse),
		telegram_generation:
			(parsedRecord.telegram_generation as ControlPlaneReloadApiResponse["telegram_generation"] | undefined) ?? null,
	};
	return {
		response,
		error: null,
	};
}

async function reloadControlPlaneInProcess(reason: string): Promise<ControlPlaneReloadOutcome> {
	const base = muServerUrl();
	if (!base) {
		return {
			ok: false,
			response: null,
			error: "MU_SERVER_URL not set",
		};
	}

	try {
		const response = await fetch(`${base}/api/control-plane/reload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason }),
		});
		const raw = await response.text();
		const parsedResult = parseControlPlaneReloadApiResponse(raw);
		const parsed = parsedResult.response;

		if (parsedResult.error) {
			return {
				ok: false,
				response: null,
				error: parsedResult.error,
			};
		}

		if (!parsed) {
			return {
				ok: false,
				response: null,
				error: "control-plane reload response missing payload",
			};
		}

		if (!response.ok || !parsed.ok) {
			return {
				ok: false,
				response: parsed,
				error: parsed.error ?? `control-plane reload failed (${response.status})`,
			};
		}

		return {
			ok: true,
			response: parsed,
			error: null,
		};
	} catch (err) {
		return {
			ok: false,
			response: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function reloadOutcomeSummary(reload: ControlPlaneReloadOutcome): string {
	if (!reload.ok) {
		return `Control-plane reload failed: ${reload.error ?? "unknown error"}.`;
	}
	const response = reload.response;
	if (!response) {
		return "Control-plane reload failed: missing reload response payload.";
	}

	const adapters = response.control_plane?.adapters.join(", ") || "(none)";
	const generationSummary = `${response.generation.outcome} (${response.generation.active_generation?.generation_id ?? response.generation.to_generation.generation_id})`;
	const telegramRollbackTrigger = response.telegram_generation?.rollback.trigger;
	const telegramNote =
		response.telegram_generation?.handled && telegramRollbackTrigger
			? ` rollback_trigger=${telegramRollbackTrigger}`
			: "";
	return `Control-plane reloaded in-process. Active adapters: ${adapters}. Generation: ${generationSummary}.${telegramNote}`;
}

function patchForAdapterValues(adapterId: AdapterId, values: Record<string, string>): Record<string, unknown> {
	switch (adapterId) {
		case "slack":
			return {
				control_plane: {
					adapters: {
						slack: {
							signing_secret: values.signing_secret ?? null,
						},
					},
				},
			};
		case "discord":
			return {
				control_plane: {
					adapters: {
						discord: {
							signing_secret: values.signing_secret ?? null,
						},
					},
				},
			};
		case "telegram":
			return {
				control_plane: {
					adapters: {
						telegram: {
							webhook_secret: values.webhook_secret ?? null,
							bot_token: values.bot_token ?? null,
							bot_username: values.bot_username ?? null,
						},
					},
				},
			};
		case "gmail":
			return {
				control_plane: {
					adapters: {
						gmail: {
							enabled: values.enabled === "true",
							webhook_secret: values.webhook_secret ?? null,
							client_id: values.client_id ?? null,
							client_secret: values.client_secret ?? null,
							refresh_token: values.refresh_token ?? null,
						},
					},
				},
			};
	}
}

async function writeConfigPatch(patch: Record<string, unknown>): Promise<ConfigWriteResponse> {
	return await fetchMuJson<ConfigWriteResponse>("/api/config", {
		method: "POST",
		body: { patch },
		timeoutMs: 6_000,
	});
}

async function applyAdapterConfig(opts: {
	adapterId: AdapterId;
	overrides?: Record<string, string>;
	presence: ConfigPresence;
}): Promise<ApplyOutcome> {
	const adapter = adapterById(opts.adapterId);
	if (adapter.support === "planned") {
		return {
			ok: false,
			adapter: adapter.id,
			reason: "adapter_planned",
			missing_required_fields: adapter.fields.filter((field) => field.required).map((field) => field.key),
		};
	}

	const missingRequired = missingRequiredFields(adapter, opts.presence);
	const overrides = opts.overrides ?? {};
	const unresolved = missingRequired.filter((field) => !(field in overrides));
	if (unresolved.length > 0) {
		return {
			ok: false,
			adapter: adapter.id,
			reason: "missing_required_fields",
			missing_required_fields: unresolved,
		};
	}

	const patchValues: Record<string, string> = {};
	for (const [key, value] of Object.entries(overrides)) {
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			patchValues[key] = trimmed;
		}
	}

	let configPath: string | null = null;
	const updatedFields = Object.keys(patchValues);
	if (updatedFields.length > 0) {
		const patch = patchForAdapterValues(adapter.id, patchValues);
		const writeResult = await writeConfigPatch(patch);
		configPath = writeResult.config_path;
	}

	checksCache = null;

	const reload = await reloadControlPlaneInProcess(`mu_setup_apply_${adapter.id}`);
	return {
		ok: true,
		adapter: adapter.id,
		updated_fields: updatedFields,
		config_path: configPath,
		reload,
	};
}

function buildVerifyOutcome(
	checks: AdapterCheck[],
	opts: { adapterId?: AdapterId; publicBaseUrl?: string },
): VerifyOutcome {
	const targets = opts.adapterId ? checks.filter((check) => check.id === opts.adapterId) : checks;
	const normalizedBase = normalizePublicBaseUrl(opts.publicBaseUrl);
	const ok = targets.every((check) => check.state === "active");
	return {
		ok,
		targets,
		public_base_url: normalizedBase,
	};
}

function verifyText(result: VerifyOutcome): string {
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
		lines.push("", "Tip: run `/mu-setup plan <adapter>` for exact remediation steps.");
	}
	return lines.join("\n");
}

async function refreshMessagingStatus(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const { checks } = await collectChecksCached();
	ctx.ui.setStatus("mu-messaging", ctx.ui.theme.fg("dim", summarizeChecks(checks)));
}

type ParsedSetupCommand = {
	action: SetupAction;
	adapterId: AdapterId | null;
	publicBaseUrl: string | undefined;
	dispatchToAgent: "auto" | "force" | "off";
	error: string | null;
};

function parseSetupCommandArgs(args: string): ParsedSetupCommand {
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

function shouldDispatchSetupToAgent(parsed: ParsedSetupCommand): boolean {
	if (parsed.dispatchToAgent === "force") return true;
	if (parsed.dispatchToAgent === "off") return false;
	if (!parsed.adapterId) return false;
	if (parsed.action === "apply" || parsed.action === "check") return false;
	return true;
}

function adapterFieldStatusLines(adapter: AdapterConfig, check: AdapterCheck): string[] {
	return adapter.fields.map((field) => {
		const status = check.missing.includes(field.key) ? "MISSING" : "SET";
		return `- ${field.key}: ${status} (${field.required ? "required" : "optional"})`;
	});
}

function buildAgentSetupPrompt(opts: {
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
		verify_command: `/mu-setup verify ${adapter.id}${verifyFlag}`,
	});
}

function dispatchSetupPromptToAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
		return;
	}
	pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function findCheckByAdapter(checks: AdapterCheck[], adapterId: AdapterId): AdapterCheck | null {
	return checks.find((check) => check.id === adapterId) ?? null;
}

async function maybeDispatchAgentSetupBrief(opts: {
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

async function runInteractiveApply(ctx: ExtensionCommandContext, adapterId: AdapterId): Promise<string> {
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

export function messagingSetupExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const { checks } = await collectChecksCached();
		const summary = summarizeChecks(checks);
		const lines = [
			"",
			"[MU MESSAGING]",
			summary.length > 0 ? summary : "no adapter status available",
			"Use mu_messaging_setup(action=preflight|plan|apply|verify|guide) for operator workflow.",
		];
		return {
			systemPrompt: `${event.systemPrompt}${lines.join("\n")}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshMessagingStatus(ctx);
	});

	const SetupParams = Type.Object({
		action: StringEnum(["check", "preflight", "guide", "plan", "apply", "verify"] as const),
		adapter: Type.Optional(Type.String({ description: "Adapter name: slack, discord, telegram, gmail" })),
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
		description:
			"Messaging setup workflow. Actions: check/preflight/guide/plan/apply/verify. For apply, pass field values via the fields parameter (e.g. fields={bot_token:'...', webhook_secret:'...'}).",
		parameters: SetupParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const adapterId = params.adapter ? normalizeAdapterId(params.adapter) : null;
			if (params.adapter && !adapterId) {
				return textResult(
					`Unknown adapter: ${params.adapter}. Available: ${ADAPTERS.map((adapter) => adapter.id).join(", ")}`,
				);
			}

			switch (params.action) {
				case "check": {
					const { checks, runtime } = await collectChecksCached();
					return textResult(
						toJsonText({
							checks,
							runtime: { ...runtime, routesByAdapter: Object.fromEntries(runtime.routesByAdapter) },
						}),
						{
							checks,
							runtime,
						},
					);
				}
				case "preflight": {
					const { checks, runtime } = await collectChecksCached();
					return textResult(preflightSummary(checks, runtime), { checks, runtime });
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
							`Cannot apply ${adapterId}: missing required config fields (${stillMissing.join(", ")}). Pass them via the fields parameter or use /mu-setup apply ${adapterId} for guided input.`,
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

	pi.registerCommand("mu-setup", {
		description:
			"Messaging setup workflow (`/mu-setup slack`, `/mu-setup plan <adapter>`, `/mu-setup apply <adapter>`, `/mu-setup verify [adapter]`)",
		handler: async (args, ctx) => {
			const parsed = parseSetupCommandArgs(args);
			if (parsed.error) {
				ctx.ui.notify(
					`${parsed.error}. Usage: /mu-setup [preflight|guide|plan|apply|verify] [adapter] [--public-base-url URL] [--agent|--no-agent]`,
					"error",
				);
				return;
			}

			switch (parsed.action) {
				case "check": {
					const { checks, runtime } = await collectChecksCached(0);
					ctx.ui.notify(
						toJsonText({
							checks,
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
					ctx.ui.notify(preflightSummary(checks, runtime), "info");
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
					if (!parsed.adapterId) {
						ctx.ui.notify("apply requires adapter. Example: /mu-setup apply slack", "error");
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
