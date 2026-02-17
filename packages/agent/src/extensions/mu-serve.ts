/**
 * mu-serve — Unified serve-mode extension facade.
 *
 * Bundles all mu serve extensions behind a single extension entry so
 * pi-coding-agent shows one "[Extensions] mu-serve" line instead of many.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { brandingExtension } from "./branding.js";
import { serverToolsExtension } from "./server-tools.js";
import { eventLogExtension } from "./event-log.js";
import { messagingSetupExtension } from "./messaging-setup.js";
import { orchestrationRunsExtension } from "./orchestration-runs.js";
import { activitiesExtension } from "./activities.js";
import { heartbeatsExtension } from "./heartbeats.js";
import { cronExtension } from "./cron.js";

export function muServeExtension(pi: ExtensionAPI) {
	brandingExtension(pi);
	serverToolsExtension(pi);
	eventLogExtension(pi);
	messagingSetupExtension(pi);
	orchestrationRunsExtension(pi);
	activitiesExtension(pi);
	heartbeatsExtension(pi);
	cronExtension(pi);
}

export default muServeExtension;
