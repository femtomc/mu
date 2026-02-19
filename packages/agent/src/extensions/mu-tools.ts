/**
 * mu-tools — Tool-only extension bundle for non-interactive roles.
 *
 * Registers `query` (read) and `command` (mutation).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { operatorCommandExtension } from "./operator-command.js";
import { queryExtension } from "./query.js";

export function muToolsExtension(pi: ExtensionAPI) {
	queryExtension(pi);
	operatorCommandExtension(pi);
}

export default muToolsExtension;
