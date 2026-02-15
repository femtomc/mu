import type { JsonlStore } from "../persistence";

function invariant(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		throw new Error(msg);
	}
}

function getIndexedDb(): any | null {
	return (globalThis as any).indexedDB ?? null;
}

function requestToPromise<T>(req: any): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result as T);
		req.onerror = () => reject(req.error ?? new Error("indexeddb request failed"));
	});
}

function transactionDone(tx: any): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
		tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
	});
}

function hasObjectStore(db: any, name: string): boolean {
	const names = db.objectStoreNames as any;
	if (names && typeof names.contains === "function") {
		return names.contains(name);
	}
	// Fallback for older DOMStringList implementations.
	try {
		for (const n of names as Iterable<string>) {
			if (n === name) {
				return true;
			}
		}
	} catch {}
	return false;
}

async function ensureDb(opts: { dbName: string; stores: readonly string[] }): Promise<any> {
	const idb = getIndexedDb();
	invariant(idb, "IndexedDB is not available in this environment");

	// First open creates a v1 DB when missing; ensure object stores exist on create.
	{
		const req = idb.open(opts.dbName);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const store of opts.stores) {
				if (!hasObjectStore(db, store)) {
					db.createObjectStore(store, { autoIncrement: true });
				}
			}
		};
		const db = await requestToPromise<any>(req);

		const missing = opts.stores.filter((s) => !hasObjectStore(db, s));
		if (missing.length === 0) {
			return db;
		}

		// Upgrade by one and create missing stores.
		const nextVersion = Math.max(1, Math.trunc(db.version ?? 1)) + 1;
		db.close();

		const upgradeReq = idb.open(opts.dbName, nextVersion);
		upgradeReq.onupgradeneeded = () => {
			const db2 = upgradeReq.result;
			for (const store of opts.stores) {
				if (!hasObjectStore(db2, store)) {
					db2.createObjectStore(store, { autoIncrement: true });
				}
			}
		};
		return await requestToPromise<any>(upgradeReq);
	}
}

async function readAllFromStore<T>(store: any): Promise<T[]> {
	const out: T[] = [];
	return await new Promise((resolve, reject) => {
		const req = store.openCursor();
		req.onerror = () => reject(req.error ?? new Error("indexeddb cursor failed"));
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) {
				resolve(out);
				return;
			}
			out.push(cursor.value as T);
			cursor.continue();
		};
	});
}

export type IndexedDbJsonlStoreOpts = {
	// Shared DB name; use different names to isolate apps/tests.
	dbName: string;

	// Object store name within the DB.
	storeName: string;

	// Full list of stores to ensure exist in this DB.
	// Defaults to just `storeName`, but for a multi-store DB you should pass all store names.
	ensureStores?: readonly string[];
};

export class IndexedDbJsonlStore<T = unknown> implements JsonlStore<T> {
	readonly #dbName: string;
	readonly #storeName: string;
	readonly #stores: readonly string[];
	#lock: Promise<void> = Promise.resolve();

	public constructor(opts: IndexedDbJsonlStoreOpts) {
		this.#dbName = opts.dbName;
		this.#storeName = opts.storeName;
		this.#stores = opts.ensureStores ?? [opts.storeName];
	}

	async #withLock<R>(fn: () => Promise<R>): Promise<R> {
		const start = this.#lock;
		let release: () => void = () => {};
		this.#lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await start;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	public async read(): Promise<T[]> {
		return await this.#withLock(async () => {
			const db = await ensureDb({ dbName: this.#dbName, stores: this.#stores });
			try {
				const tx = db.transaction(this.#storeName, "readonly");
				const store = tx.objectStore(this.#storeName);
				const rows = await readAllFromStore<T>(store);
				await transactionDone(tx);
				return rows;
			} finally {
				db.close();
			}
		});
	}

	public async write(rows: readonly T[]): Promise<void> {
		await this.#withLock(async () => {
			const db = await ensureDb({ dbName: this.#dbName, stores: this.#stores });
			try {
				const tx = db.transaction(this.#storeName, "readwrite");
				const store = tx.objectStore(this.#storeName);
				store.clear();
				for (const row of rows) {
					store.add(row);
				}
				await transactionDone(tx);
			} finally {
				db.close();
			}
		});
	}

	public async append(row: T): Promise<void> {
		await this.#withLock(async () => {
			const db = await ensureDb({ dbName: this.#dbName, stores: this.#stores });
			try {
				const tx = db.transaction(this.#storeName, "readwrite");
				const store = tx.objectStore(this.#storeName);
				store.add(row);
				await transactionDone(tx);
			} finally {
				db.close();
			}
		});
	}
}

