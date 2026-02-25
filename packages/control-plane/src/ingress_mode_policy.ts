import { ChannelSchema, type Channel } from "./identity_store.js";

export type IngressMode = "command_only" | "conversational";

const CHANNEL_INGRESS_MODE: Record<Channel, IngressMode> = {
	slack: "conversational",
	discord: "conversational",
	telegram: "conversational",
	neovim: "conversational",
	terminal: "conversational",
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

export function allowsConversationalIngressForInbound(channel: string): boolean {
	return allowsConversationalIngress(channel);
}
