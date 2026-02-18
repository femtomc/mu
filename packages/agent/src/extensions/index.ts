export { activitiesExtension } from "./activities.js";
export { brandingExtension } from "./branding.js";
export { cronExtension } from "./cron.js";
export { eventLogExtension } from "./event-log.js";
export { heartbeatsExtension } from "./heartbeats.js";
export { messagingSetupExtension } from "./messaging-setup.js";
export { muFullToolsExtension } from "./mu-full-tools.js";
export { muOperatorExtension } from "./mu-operator.js";
export { muQueryToolsExtension } from "./mu-query-tools.js";
export { muServeExtension } from "./mu-serve.js";
export { operatorCommandExtension } from "./operator-command.js";
export { orchestrationRunsExtension } from "./orchestration-runs.js";
export { orchestrationRunsReadOnlyExtension } from "./orchestration-runs-readonly.js";
export { serverToolsExtension, serverToolsIssueForumExtension, serverToolsReadOnlyExtension } from "./server-tools.js";
export { serverToolsReadonlyExtension } from "./server-tools-readonly.js";

const RUNTIME_EXTENSION = import.meta.url.endsWith(".ts") ? "ts" : "js";

function resolveBundledExtensionPath(moduleBasename: string): string {
	return new URL(`./${moduleBasename}.${RUNTIME_EXTENSION}`, import.meta.url).pathname;
}

/**
 * Serve-mode extension — single facade that bundles all serve extensions.
 */
export const serveExtensionPaths = [resolveBundledExtensionPath("mu-serve")];

/**
 * Operator-mode extension — single facade that bundles operator UI +
 * full mu tools + approved `/mu` command flow.
 */
export const operatorExtensionPaths = [resolveBundledExtensionPath("mu-operator")];

/**
 * Tool-only extension bundle for orchestrator sessions (full tool surface).
 */
export const orchestratorToolExtensionPaths = [resolveBundledExtensionPath("mu-full-tools")];

/**
 * Tool-only extension bundle for worker sessions (issue/forum coordination only).
 */
export const workerToolExtensionPaths = [resolveBundledExtensionPath("mu-query-tools")];
