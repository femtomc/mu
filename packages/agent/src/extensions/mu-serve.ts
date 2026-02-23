/**
 * mu-serve — Serve-mode extension facade.
 *
 * Bundles serve extensions behind a single extension entry so
 * pi-coding-agent shows one "[Extensions] mu-serve" line instead of many.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { brandingExtension } from "./branding.js";
import { eventLogExtension } from "./event-log.js";
import { hudExtension } from "./hud.js";

export function muServeExtension(pi: ExtensionAPI) {
	hudExtension(pi);
	brandingExtension(pi);
	eventLogExtension(pi);
}

export default muServeExtension;
