export { appendJsonl, FsJsonlStore, readJsonl, streamJsonl, writeJsonl } from "./jsonl";
export { currentRunId, runContext } from "./run_context";
export { executionSpecFromDict } from "./spec";
export type { StorePaths } from "./store";
export { findRepoRoot, getStorePaths } from "./store";

import { EventLog, JsonlEventSink } from "../events";
import { FsJsonlStore } from "./jsonl";
import { currentRunId } from "./run_context";
import { getStorePaths } from "./store";

export function fsEventLog(path: string): EventLog {
	return new EventLog(new JsonlEventSink(new FsJsonlStore(path)), { runIdProvider: currentRunId });
}

export function fsEventLogFromRepoRoot(repoRoot: string): EventLog {
	return fsEventLog(getStorePaths(repoRoot).eventsPath);
}

export * from "../dag";
// Re-export the node-free surface so node code can import from a single place.
export {
	EVENT_VERSION,
	type EventEnvelope,
	EventLog,
	type EventSink,
	JsonlEventSink,
	NullEventSink,
	type RunIdProvider,
} from "../events";
export { newRunId, nowTs, nowTsMs, randomHex, shortId } from "../ids";
export { InMemoryJsonlStore, type JsonlStore } from "../persistence";
export * from "../spec";
