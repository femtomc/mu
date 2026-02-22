import { ChannelSchema, type Channel } from "./identity_store.js";

export type IngressMode = "command_only" | "conversational";

export const CONVERSATIONAL_INGRESS_OVERRIDE_KEY = "mu_conversational_ingress";
export const CONVERSATIONAL_INGRESS_OVERRIDE_ALLOW = "allow";

const CHANNEL_INGRESS_MODE: Record<Channel, IngressMode> = {
	slack: "command_only",
	discord: "command_only",
	telegram: "conversational",
	neovim: "command_only",
	terminal: "command_only",
};

export function ingressModeForChannel(channel: Channel): IngressMode {
	return CHANNEL_INGRESS_MODE[channel];
}

export function ingressModeForValue(channel: string): IngressMode {
	const parsed = ChannelSchema.safeParse(channel);
	if (!parsed.success) {
		return "command_only";
	}
	return ingressModeForChannel(parsed.data);
}

export function allowsConversationalIngress(channel: string): boolean {
	return ingressModeForValue(channel) === "conversational";
}

export function allowsConversationalIngressForInbound(
	channel: string,
	metadata: Record<string, unknown> | null | undefined,
): boolean {
	if (allowsConversationalIngress(channel)) {
		return true;
	}
	const marker = metadata?.[CONVERSATIONAL_INGRESS_OVERRIDE_KEY];
	return typeof marker === "string" && marker.trim().toLowerCase() === CONVERSATIONAL_INGRESS_OVERRIDE_ALLOW;
}
