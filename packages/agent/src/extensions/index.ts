export { brandingExtension } from "./branding.js";
export { eventLogExtension } from "./event-log.js";
export { muOperatorExtension } from "./mu-operator.js";
export { muServeExtension } from "./mu-serve.js";
export { planningUiExtension } from "./planning-ui.js";
export { subagentsUiExtension } from "./subagents-ui.js";

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
