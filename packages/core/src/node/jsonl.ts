import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import { createInterface } from "node:readline";
import type { JsonlStore } from "../persistence.js";

function tmpPathFor(path: string): string {
	const parsed = parsePath(path);
	return join(parsed.dir, `${parsed.name}.tmp`);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return false;
		}
		throw err;
	}
}

export async function* streamJsonl(path: string): AsyncGenerator<unknown> {
	if (!(await exists(path))) {
		return;
	}

	const file = createReadStream(path, { encoding: "utf8" });
	const rl = createInterface({ input: file, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			yield JSON.parse(trimmed) as unknown;
		}
	} finally {
		rl.close();
		file.close();
	}
}

export async function readJsonl(path: string): Promise<unknown[]> {
	const rows: unknown[] = [];
	for await (const row of streamJsonl(path)) {
		rows.push(row);
	}
	return rows;
}

export async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });

	const tmp = tmpPathFor(path);
	const out = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
	await writeFile(tmp, out, "utf8");
	await rename(tmp, path);
}

export async function appendJsonl(path: string, row: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const line = `${JSON.stringify(row)}\n`;

	const fh = await open(path, "a");
	try {
		await fh.writeFile(line, { encoding: "utf8" });
	} finally {
		await fh.close();
	}
}

export class FsJsonlStore<T = unknown> implements JsonlStore<T> {
	public readonly path: string;

	public constructor(path: string) {
		this.path = path;
	}

	public async read(): Promise<T[]> {
		return (await readJsonl(this.path)) as T[];
	}

	public async write(rows: readonly T[]): Promise<void> {
		await writeJsonl(this.path, rows as readonly unknown[]);
	}

	public async append(row: T): Promise<void> {
		await appendJsonl(this.path, row as unknown);
	}
}
