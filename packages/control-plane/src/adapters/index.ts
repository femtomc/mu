export * from "./shared.js";
export * from "./slack.js";
export * from "./discord.js";
export * from "./telegram.js";
export * from "./editor_frontend.js";
export * from "./neovim.js";

import { SlackControlPlaneAdapterSpec } from "./slack.js";
import { DiscordControlPlaneAdapterSpec } from "./discord.js";
import { TelegramControlPlaneAdapterSpec } from "./telegram.js";
import { NeovimControlPlaneAdapterSpec } from "./neovim.js";

export const CONTROL_PLANE_CHANNEL_ADAPTER_SPECS = [
	SlackControlPlaneAdapterSpec,
	DiscordControlPlaneAdapterSpec,
	TelegramControlPlaneAdapterSpec,
	NeovimControlPlaneAdapterSpec,
] as const;
