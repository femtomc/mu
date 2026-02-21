/**
 * mu-operator — Operator-mode extension facade.
 *
 * Bundles operator extensions behind a single extension entry so
 * pi-coding-agent shows one "[Extensions] mu-operator" line instead of many.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { brandingExtension } from "./branding.js";
import { eventLogExtension } from "./event-log.js";
import { planningUiExtension } from "./planning-ui.js";
import { subagentsUiExtension } from "./subagents-ui.js";

export function muOperatorExtension(pi: ExtensionAPI) {
	brandingExtension(pi);
	eventLogExtension(pi);
	planningUiExtension(pi);
	subagentsUiExtension(pi);
}

export default muOperatorExtension;
