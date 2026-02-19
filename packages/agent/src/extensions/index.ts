export { brandingExtension } from "./branding.js";
export { eventLogExtension } from "./event-log.js";
export { muOperatorExtension } from "./mu-operator.js";
export { muServeExtension } from "./mu-serve.js";

const RUNTIME_EXTENSION = import.meta.url.endsWith(".ts") ? "ts" : "js";

function resolveBundledExtensionPath(moduleBasename: string): string {
	return new URL(`./${moduleBasename}.${RUNTIME_EXTENSION}`, import.meta.url).pathname;
}

/**
 * Serve-mode extension — single facade that bundles all serve extensions.
 */
export const serveExtensionPaths = [resolveBundledExtensionPath("mu-serve")];

/**
 * Operator-mode extension — single facade that bundles operator UI helpers.
 */
export const operatorExtensionPaths = [resolveBundledExtensionPath("mu-operator")];

/**
 * Orchestrator and worker sessions run with the generic built-in tools
 * (bash/read/write/edit) and invoke `mu` CLI directly.
 */
export const orchestratorToolExtensionPaths: string[] = [];
export const workerToolExtensionPaths: string[] = [];
