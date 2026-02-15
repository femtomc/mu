export type JsonlStore<T = unknown> = {
	read(): Promise<T[]>;
	write(rows: readonly T[]): Promise<void>;
	append(row: T): Promise<void>;
};

export class InMemoryJsonlStore<T = unknown> implements JsonlStore<T> {
	#rows: T[];

	public constructor(initial: readonly T[] = []) {
		this.#rows = [...initial];
	}

	public async read(): Promise<T[]> {
		return [...this.#rows];
	}

	public async write(rows: readonly T[]): Promise<void> {
		this.#rows = [...rows];
	}

	public async append(row: T): Promise<void> {
		this.#rows.push(row);
	}
}
