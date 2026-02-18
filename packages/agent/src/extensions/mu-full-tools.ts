/**
 * mu-full-tools — Tool-only extension bundle with full mu tool surface.
 *
 * Intended for orchestrator/operator contexts that should have the complete
 * server-backed tool set (including mutation-capable tool actions).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { activitiesExtension } from "./activities.js";
import { cronExtension } from "./cron.js";
import { heartbeatsExtension } from "./heartbeats.js";
import { messagingSetupExtension } from "./messaging-setup.js";
import { orchestrationRunsExtension } from "./orchestration-runs.js";
import { serverToolsExtension } from "./server-tools.js";

export function muFullToolsExtension(pi: ExtensionAPI) {
	serverToolsExtension(pi, {
		allowForumPost: true,
		allowIdentityMutations: true,
		toolIntroLine:
			"Tools: mu_status, mu_control_plane, mu_issues, mu_forum, mu_events, mu_runs, mu_activities, mu_heartbeats, mu_cron, mu_messaging_setup, mu_identity.",
	});
	messagingSetupExtension(pi, { allowApply: true });
	orchestrationRunsExtension(pi);
	activitiesExtension(pi, { allowMutations: true });
	heartbeatsExtension(pi, { allowMutations: true });
	cronExtension(pi, { allowMutations: true });
}

export default muFullToolsExtension;
