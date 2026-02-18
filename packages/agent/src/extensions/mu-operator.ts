/**
 * mu-operator — Unified operator-mode extension facade.
 *
 * Bundles all mu operator extensions behind a single extension entry so
 * pi-coding-agent shows one "[Extensions] mu-operator" line instead of many.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { brandingExtension } from "./branding.js";
import { eventLogExtension } from "./event-log.js";
import { muFullToolsExtension } from "./mu-full-tools.js";
import { operatorCommandExtension } from "./operator-command.js";

export function muOperatorExtension(pi: ExtensionAPI) {
	brandingExtension(pi);
	muFullToolsExtension(pi);
	eventLogExtension(pi);
	operatorCommandExtension(pi);
}

export default muOperatorExtension;
