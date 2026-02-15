export type { DagResult } from "./dag_runner.js";
export { DagRunner } from "./dag_runner.js";
export type { BackendRunner, BackendRunOpts } from "./pi_backend.js";
export { PiCliBackend, piStreamHasError } from "./pi_backend.js";
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
