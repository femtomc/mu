export type {
	DagResult,
	DagRunnerBackendLineEvent,
	DagRunnerHooks,
	DagRunnerRunOpts,
	DagRunnerStepEndEvent,
	DagRunnerStepStartEvent,
} from "./dag_runner.js";
export { DagRunner } from "./dag_runner.js";
export type { ModelOverrides, ResolvedModelConfig } from "./model_resolution.js";
export { resolveModelConfig } from "./model_resolution.js";
export type { BackendRunner, BackendRunOpts } from "./pi_backend.js";
export { PiCliBackend, piStreamHasError } from "./pi_backend.js";
export { createMuResourceLoader, PiSdkBackend } from "./pi_sdk_backend.js";
export type { PiStreamRendererOpts } from "./pi_stream_renderer.js";
export { PiStreamRenderer } from "./pi_stream_renderer.js";
export type { PromptMeta } from "./prompt.js";
export {
	buildRoleCatalog,
	extractDescription,
	readPromptMeta,
	renderPromptTemplate,
	splitFrontmatter,
} from "./prompt.js";

// Back-compat placeholder API used by other packages/tests.
export function orchestratorHello(): string {
	return "orchestrator(forum,issue)";
}
