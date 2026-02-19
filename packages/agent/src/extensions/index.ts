export { brandingExtension } from "./branding.js";
export { eventLogExtension } from "./event-log.js";
export { muToolsExtension } from "./mu-tools.js";
export { muOperatorExtension } from "./mu-operator.js";
export { muServeExtension } from "./mu-serve.js";
export { operatorCommandExtension } from "./operator-command.js";
export { queryExtension } from "./query.js";

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
 * query/command tool pathways.
 */
export const operatorExtensionPaths = [resolveBundledExtensionPath("mu-operator")];

/**
 * Tool-only extension bundle for orchestrator sessions.
 */
export const orchestratorToolExtensionPaths = [resolveBundledExtensionPath("mu-tools")];

/**
 * Tool-only extension bundle for worker sessions.
 */
export const workerToolExtensionPaths = [resolveBundledExtensionPath("mu-tools")];
