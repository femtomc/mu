import type { JsonlStore } from "../persistence.js";

function invariant(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		throw new Error(msg);
	}
}

function getLocalStorage(): any | null {
	return (globalThis as any).localStorage ?? null;
}

export type LocalStorageJsonlStoreOpts = {
	key: string;
};

export class LocalStorageJsonlStore<T = unknown> implements JsonlStore<T> {
	readonly #key: string;

	public constructor(opts: LocalStorageJsonlStoreOpts) {
		this.#key = opts.key;
	}

	#ls(): any {
		const ls = getLocalStorage();
		invariant(ls, "localStorage is not available in this environment");
		return ls;
	}

	public async read(): Promise<T[]> {
		const raw = this.#ls().getItem(this.#key);
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error(`localStorage key ${JSON.stringify(this.#key)} did not contain an array`);
		}
		return parsed as T[];
	}

	public async write(rows: readonly T[]): Promise<void> {
		this.#ls().setItem(this.#key, JSON.stringify(rows));
	}

	public async append(row: T): Promise<void> {
		const rows = await this.read();
		rows.push(row);
		await this.write(rows);
	}
}
