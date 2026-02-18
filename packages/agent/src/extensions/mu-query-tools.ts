/**
 * mu-query-tools — Worker tool bundle.
 *
 * Exposes only issue/forum tools for agentic coordination, plus the base coding
 * tools supplied by the session runtime (bash/read/write/edit).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { serverToolsIssueForumExtension } from "./server-tools.js";

export function muQueryToolsExtension(pi: ExtensionAPI) {
	serverToolsIssueForumExtension(pi);
}

export default muQueryToolsExtension;
