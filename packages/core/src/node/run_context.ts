import { AsyncLocalStorage } from "node:async_hooks";

const runIdStore = new AsyncLocalStorage<string | null>();

export function currentRunId(): string | null {
	return runIdStore.getStore() ?? null;
}

export function runContext<T>(opts: { runId: string | null }, fn: () => T): T {
	return runIdStore.run(opts.runId, fn);
}
