import { describe, expect, test } from "bun:test";
import {
	CONTROL_PLANE_ADAPTER_CONTRACT_VERSION,
	CONTROL_PLANE_CHANNEL_ADAPTER_SPECS,
	ControlPlaneAdapterSpecSchema,
	DiscordControlPlaneAdapter,
	DiscordControlPlaneAdapterSpec,
	defaultWebhookRouteForChannel,
	SlackControlPlaneAdapter,
	SlackControlPlaneAdapterSpec,
	TelegramControlPlaneAdapter,
	TelegramControlPlaneAdapterSpec,
} from "@femtomc/mu-control-plane";

describe("adapter contract", () => {
	test("built-in adapter specs are contract-valid and uniquely routed", () => {
		for (const spec of CONTROL_PLANE_CHANNEL_ADAPTER_SPECS) {
			const parsed = ControlPlaneAdapterSpecSchema.parse(spec);
			expect(parsed.v).toBe(CONTROL_PLANE_ADAPTER_CONTRACT_VERSION);
		}

		const channels = new Set(CONTROL_PLANE_CHANNEL_ADAPTER_SPECS.map((spec) => spec.channel));
		expect(channels.size).toBe(CONTROL_PLANE_CHANNEL_ADAPTER_SPECS.length);

		const routes = new Set(CONTROL_PLANE_CHANNEL_ADAPTER_SPECS.map((spec) => spec.route));
		expect(routes.size).toBe(CONTROL_PLANE_CHANNEL_ADAPTER_SPECS.length);

		expect(SlackControlPlaneAdapterSpec.route).toBe(defaultWebhookRouteForChannel("slack"));
		expect(DiscordControlPlaneAdapterSpec.route).toBe(defaultWebhookRouteForChannel("discord"));
		expect(TelegramControlPlaneAdapterSpec.route).toBe(defaultWebhookRouteForChannel("telegram"));
		expect(TelegramControlPlaneAdapterSpec.delivery_semantics).toBe("at_least_once");
	});

	test("built-in adapter classes expose canonical specs", () => {
		const pipeline = {} as any;
		const outbox = {} as any;

		const slack = new SlackControlPlaneAdapter({
			pipeline,
			outbox,
			signingSecret: "slack-secret",
		});
		expect(slack.spec).toEqual(SlackControlPlaneAdapterSpec);

		const discord = new DiscordControlPlaneAdapter({
			pipeline,
			outbox,
			signingSecret: "discord-secret",
		});
		expect(discord.spec).toEqual(DiscordControlPlaneAdapterSpec);

		const telegram = new TelegramControlPlaneAdapter({
			pipeline,
			outbox,
			webhookSecret: "telegram-secret",
		});
		expect(telegram.spec).toEqual(TelegramControlPlaneAdapterSpec);
	});
});
