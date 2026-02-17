/**
 * mu-operator — Unified operator-mode extension facade.
 *
 * Bundles all mu operator extensions behind a single extension entry so
 * pi-coding-agent shows one "[Extensions] mu-operator" line instead of many.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { brandingExtension } from "./branding.js";
import { serverToolsReadOnlyExtension } from "./server-tools.js";
import { eventLogExtension } from "./event-log.js";
import { messagingSetupExtension } from "./messaging-setup.js";
import { orchestrationRunsReadOnlyExtension } from "./orchestration-runs-readonly.js";
import { operatorCommandExtension } from "./operator-command.js";

export function muOperatorExtension(pi: ExtensionAPI) {
	brandingExtension(pi);
	serverToolsReadOnlyExtension(pi);
	eventLogExtension(pi);
	messagingSetupExtension(pi);
	orchestrationRunsReadOnlyExtension(pi);
	operatorCommandExtension(pi);
}

export default muOperatorExtension;
