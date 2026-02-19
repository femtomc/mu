/**
 * mu-serve — Serve-mode extension facade.
 *
 * Bundles serve extensions behind a single extension entry so
 * pi-coding-agent shows one "[Extensions] mu-serve" line instead of many.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { brandingExtension } from "./branding.js";
import { eventLogExtension } from "./event-log.js";
import { operatorCommandExtension } from "./operator-command.js";
import { queryExtension } from "./query.js";

export function muServeExtension(pi: ExtensionAPI) {
	brandingExtension(pi);
	queryExtension(pi);
	eventLogExtension(pi);
	operatorCommandExtension(pi);
}

export default muServeExtension;
