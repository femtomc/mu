export { activitiesExtension } from "./activities.js";
export { brandingExtension } from "./branding.js";
export { eventLogExtension } from "./event-log.js";
export { heartbeatsExtension } from "./heartbeats.js";
export { messagingSetupExtension } from "./messaging-setup.js";
export { orchestrationRunsExtension } from "./orchestration-runs.js";
export { serverToolsExtension } from "./server-tools.js";

const SERVE_EXTENSION_MODULE_BASENAMES = [
	"branding",
	"server-tools",
	"event-log",
	"messaging-setup",
	"orchestration-runs",
	"activities",
	"heartbeats",
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
