export { activitiesExtension } from "./activities.js";
export { brandingExtension } from "./branding.js";
export { eventLogExtension } from "./event-log.js";
export { heartbeatsExtension } from "./heartbeats.js";
export { messagingSetupExtension } from "./messaging-setup.js";
export { operatorCommandExtension } from "./operator-command.js";
export { orchestrationRunsExtension } from "./orchestration-runs.js";
export { orchestrationRunsReadOnlyExtension } from "./orchestration-runs-readonly.js";
export { serverToolsExtension, serverToolsReadOnlyExtension } from "./server-tools.js";
export { serverToolsReadonlyExtension } from "./server-tools-readonly.js";

const SERVE_EXTENSION_MODULE_BASENAMES = [
	"branding",
	"server-tools",
	"event-log",
	"messaging-setup",
	"orchestration-runs",
	"activities",
	"heartbeats",
] as const;

const OPERATOR_EXTENSION_MODULE_BASENAMES = [
	"branding",
	"server-tools-readonly",
	"event-log",
	"messaging-setup",
	"orchestration-runs-readonly",
	"operator-command",
] as const;
const RUNTIME_EXTENSION = import.meta.url.endsWith(".ts") ? "ts" : "js";

function resolveBundledExtensionPath(moduleBasename: string): string {
	return new URL(`./${moduleBasename}.${RUNTIME_EXTENSION}`, import.meta.url).pathname;
}

/**
 * Serve-mode extension module paths.
 *
 * Prefer this for session creation so extensions are loaded through pi's
 * normal path-based loader (discoverable and visible by file path), not as
 * anonymous inline factories.
 */
export const serveExtensionPaths = SERVE_EXTENSION_MODULE_BASENAMES.map((moduleBasename) =>
	resolveBundledExtensionPath(moduleBasename),
);

/**
 * Control-plane operator extension module paths.
 *
 * This set is intentionally read-only for tool-invoked actions so all
 * mutations flow through approved `/mu ...` command proposals and policy.
 */
export const operatorExtensionPaths = OPERATOR_EXTENSION_MODULE_BASENAMES.map((moduleBasename) =>
	resolveBundledExtensionPath(moduleBasename),
);
