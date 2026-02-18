import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import { createInterface } from "node:readline";
import type { JsonlStore } from "../persistence.js";

function tmpPathFor(path: string): string {
	const parsed = parsePath(path);
	const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return join(parsed.dir, `${parsed.base}.${nonce}.tmp`);
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

export class JsonlParseError extends SyntaxError {
	public readonly filePath: string;
	public readonly lineNumber: number;
	public readonly rawLine: string;

	public constructor(opts: { filePath: string; lineNumber: number; rawLine: string; cause: unknown }) {
		const causeMessage = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
		super(`invalid jsonl row at ${opts.filePath}:${opts.lineNumber}: ${causeMessage}`, {
			cause: opts.cause,
		});
		this.name = "JsonlParseError";
		this.filePath = opts.filePath;
		this.lineNumber = opts.lineNumber;
		this.rawLine = opts.rawLine;
	}
}

export class JsonlQueryValidationError extends TypeError {
	public constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "JsonlQueryValidationError";
	}
}

function normalizeReadLimit(limit: unknown): number | null {
	if (limit == null) {
		return null;
	}
	if (typeof limit !== "number" || !Number.isFinite(limit) || !Number.isInteger(limit)) {
		throw new JsonlQueryValidationError("invalid jsonl read limit: expected positive integer");
	}
	if (limit < 1) {
		throw new JsonlQueryValidationError("invalid jsonl read limit: must be >= 1");
	}
	return limit;
}

export async function* streamJsonl(path: string): AsyncGenerator<unknown> {
	if (!(await exists(path))) {
		return;
	}

	const file = createReadStream(path, { encoding: "utf8" });
	const rl = createInterface({ input: file, crlfDelay: Number.POSITIVE_INFINITY });
	let lineNumber = 0;
	try {
		for await (const line of rl) {
			lineNumber += 1;
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			try {
				yield JSON.parse(trimmed) as unknown;
			} catch (error) {
				throw new JsonlParseError({
					filePath: path,
					lineNumber,
					rawLine: trimmed,
					cause: error,
				});
			}
		}
	} finally {
		rl.close();
		file.close();
	}
}

export async function readJsonl(path: string, opts: { limit?: number | null } = {}): Promise<unknown[]> {
	const limit = normalizeReadLimit(opts.limit);
	if (limit == null) {
		const rows: unknown[] = [];
		for await (const row of streamJsonl(path)) {
			rows.push(row);
		}
		return rows;
	}

	const ring = new Array<unknown>(limit);
	let total = 0;
	for await (const row of streamJsonl(path)) {
		ring[total % limit] = row;
		total += 1;
	}

	if (total <= limit) {
		return ring.slice(0, total);
	}

	const out: unknown[] = [];
	const start = total % limit;
	for (let i = 0; i < limit; i += 1) {
		out.push(ring[(start + i) % limit]!);
	}
	return out;
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
