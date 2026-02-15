export type { DagResult } from "./dag_runner";
export { DagRunner } from "./dag_runner";
export type { BackendRunner, BackendRunOpts } from "./pi_backend";
export { PiCliBackend, piStreamHasError } from "./pi_backend";
export type { PromptMeta } from "./prompt";
export {
	buildRoleCatalog,
	extractDescription,
	readPromptMeta,
	renderPromptTemplate,
	splitFrontmatter,
} from "./prompt";

// Back-compat placeholder API used by other packages/tests.
export function orchestratorHello(): string {
	return "orchestrator(forum,issue)";
}
