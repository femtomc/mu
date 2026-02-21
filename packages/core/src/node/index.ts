export {
	appendJsonl,
	FsJsonlStore,
	JsonlParseError,
	JsonlQueryValidationError,
	readJsonl,
	streamJsonl,
	writeJsonl,
} from "./jsonl.js";
export { currentRunId, runContext } from "./run_context.js";
export * from "./memory_runtime.js";
export type { StorePaths } from "./store.js";
export { findRepoRoot, getMuHomeDir, getStorePaths, workspaceIdForRepoRoot } from "./store.js";

import { EventLog, JsonlEventSink } from "../events.js";
import { FsJsonlStore } from "./jsonl.js";
import { currentRunId } from "./run_context.js";
import { getStorePaths } from "./store.js";

export function fsEventLog(path: string): EventLog {
	return new EventLog(new JsonlEventSink(new FsJsonlStore(path)), { runIdProvider: currentRunId });
}

export function fsEventLogFromRepoRoot(repoRoot: string): EventLog {
	return fsEventLog(getStorePaths(repoRoot).eventsPath);
}

// Re-export the node-free surface so node code can import from a single place.
export {
	EVENT_VERSION,
	type EventEnvelope,
	EventLog,
	type EventSink,
	JsonlEventSink,
	NullEventSink,
	type RunIdProvider,
} from "../events.js";
export { newRunId, nowTs, nowTsMs, randomHex, shortId } from "../ids.js";
export { InMemoryJsonlStore, type JsonlStore } from "../persistence.js";
export * from "../spec.js";
