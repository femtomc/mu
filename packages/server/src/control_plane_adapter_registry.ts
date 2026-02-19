import {
	type ControlPlaneAdapter,
	type ControlPlaneCommandPipeline,
	type ControlPlaneOutbox,
	DiscordControlPlaneAdapter,
	NeovimControlPlaneAdapter,
	SlackControlPlaneAdapter,
	VscodeControlPlaneAdapter,
} from "@femtomc/mu-control-plane";
import type { ControlPlaneConfig } from "./control_plane_contract.js";

export type DetectedStaticAdapter = {
	name: "slack" | "discord" | "neovim" | "vscode";
	secret: string;
};

export type DetectedTelegramAdapter = {
	name: "telegram";
	webhookSecret: string;
	botToken: string | null;
	botUsername: string | null;
};

export type DetectedAdapter = DetectedStaticAdapter | DetectedTelegramAdapter;

type StaticAdapterModule = {
	name: DetectedStaticAdapter["name"];
	detectSecret: (config: ControlPlaneConfig) => string | null;
	create: (opts: {
		pipeline: ControlPlaneCommandPipeline;
		outbox: ControlPlaneOutbox;
		secret: string;
	}) => ControlPlaneAdapter;
};

const STATIC_ADAPTER_MODULES: readonly StaticAdapterModule[] = [
	{
		name: "slack",
		detectSecret: (config) => config.adapters.slack.signing_secret,
		create: (opts) =>
			new SlackControlPlaneAdapter({
				pipeline: opts.pipeline,
				outbox: opts.outbox,
				signingSecret: opts.secret,
			}),
	},
	{
		name: "discord",
		detectSecret: (config) => config.adapters.discord.signing_secret,
		create: (opts) =>
			new DiscordControlPlaneAdapter({
				pipeline: opts.pipeline,
				outbox: opts.outbox,
				signingSecret: opts.secret,
			}),
	},
	{
		name: "neovim",
		detectSecret: (config) => config.adapters.neovim.shared_secret,
		create: (opts) =>
			new NeovimControlPlaneAdapter({
				pipeline: opts.pipeline,
				sharedSecret: opts.secret,
			}),
	},
	{
		name: "vscode",
		detectSecret: (config) => config.adapters.vscode.shared_secret,
		create: (opts) =>
			new VscodeControlPlaneAdapter({
				pipeline: opts.pipeline,
				sharedSecret: opts.secret,
			}),
	},
];

const STATIC_ADAPTER_BY_NAME = new Map<DetectedStaticAdapter["name"], StaticAdapterModule>(
	STATIC_ADAPTER_MODULES.map((module) => [module.name, module]),
);

function isStaticAdapter(adapter: DetectedAdapter): adapter is DetectedStaticAdapter {
	return adapter.name !== "telegram";
}

export function detectAdapters(config: ControlPlaneConfig): DetectedAdapter[] {
	const detected: DetectedAdapter[] = [];

	for (const module of STATIC_ADAPTER_MODULES) {
		const secret = module.detectSecret(config);
		if (!secret) {
			continue;
		}
		detected.push({
			name: module.name,
			secret,
		});
	}

	const telegramSecret = config.adapters.telegram.webhook_secret;
	if (telegramSecret) {
		detected.push({
			name: "telegram",
			webhookSecret: telegramSecret,
			botToken: config.adapters.telegram.bot_token,
			botUsername: config.adapters.telegram.bot_username,
		});
	}

	return detected;
}

export function createStaticAdaptersFromDetected(opts: {
	detected: readonly DetectedAdapter[];
	pipeline: ControlPlaneCommandPipeline;
	outbox: ControlPlaneOutbox;
}): ControlPlaneAdapter[] {
	const adapters: ControlPlaneAdapter[] = [];
	for (const detected of opts.detected) {
		if (!isStaticAdapter(detected)) {
			continue;
		}
		const module = STATIC_ADAPTER_BY_NAME.get(detected.name);
		if (!module) {
			throw new Error(`missing static adapter module: ${detected.name}`);
		}
		adapters.push(
			module.create({
				pipeline: opts.pipeline,
				outbox: opts.outbox,
				secret: detected.secret,
			}),
		);
	}
	return adapters;
}
