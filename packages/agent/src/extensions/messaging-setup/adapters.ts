/**
 * Adapter constants and lookup helpers for mu-messaging-setup.
 */

import type { AdapterCheck, AdapterConfig, AdapterId, ConfigPresence, SetupAction } from "./types.js";

export const ADAPTERS: AdapterConfig[] = [
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
			"Run /mu in Slack, then /mu setup verify slack.",
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
			"Run a Discord command interaction, then /mu setup verify discord.",
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
			"Send /mu in Telegram chat, then /mu setup verify telegram.",
		],
	},
];

export const SETUP_ACTIONS: readonly SetupAction[] = [
	"check",
	"preflight",
	"guide",
	"plan",
	"apply",
	"verify",
] as const;

export function isSetupAction(value: string): value is SetupAction {
	return (SETUP_ACTIONS as readonly string[]).includes(value);
}

export function normalizeAdapterId(input: string): AdapterId | null {
	const normalized = input.trim().toLowerCase();
	switch (normalized) {
		case "slack":
		case "discord":
		case "telegram":
			return normalized;
		default:
			return null;
	}
}

export function defaultRouteForAdapter(id: AdapterId): string {
	return `/webhooks/${id}`;
}

export function normalizePublicBaseUrl(input: string | undefined): string | null {
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

export function adapterById(id: AdapterId): AdapterConfig {
	const found = ADAPTERS.find((adapter) => adapter.id === id);
	if (!found) {
		throw new Error(`Unknown adapter id: ${id}`);
	}
	return found;
}

export function fieldPresent(presence: ConfigPresence, adapterId: AdapterId, key: string): boolean {
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
	}
}

export function missingRequiredFields(adapter: AdapterConfig, presence: ConfigPresence | null): string[] {
	if (!presence) {
		return adapter.fields.filter((field) => field.required).map((field) => field.key);
	}
	return adapter.fields
		.filter((field) => field.required && !fieldPresent(presence, adapter.id, field.key))
		.map((field) => field.key);
}

export function configured(adapter: AdapterConfig, presence: ConfigPresence | null): boolean {
	return missingRequiredFields(adapter, presence).length === 0;
}

export function deriveState(opts: {
	adapter: AdapterConfig;
	configured: boolean;
	active: boolean;
}): AdapterCheck["state"] {
	if (opts.adapter.support === "planned") return "planned";
	if (opts.active) return "active";
	if (opts.configured) return "configured_not_active";
	return "missing_config";
}

export function nextStepForState(opts: { state: AdapterCheck["state"]; missing: string[] }): string {
	switch (opts.state) {
		case "active":
			return "No action needed. Adapter is mounted and receiving webhooks.";
		case "configured_not_active":
			return "Run `/mu setup apply <adapter>` to trigger in-process control-plane reload.";
		case "missing_config":
			return `Set required config fields: ${opts.missing.join(", ")}.`;
		case "planned":
			return "Adapter is planned. Track implementation work before expecting runtime activation.";
	}
}
