function hexByte(n: number): string {
	return n.toString(16).padStart(2, "0");
}

function randomBytes(len: number): Uint8Array {
	const out = new Uint8Array(len);

	const c = (globalThis as any).crypto as { getRandomValues?: (arr: Uint8Array) => Uint8Array } | undefined;
	if (c?.getRandomValues) {
		c.getRandomValues(out);
		return out;
	}

	for (let i = 0; i < out.length; i++) {
		out[i] = Math.floor(Math.random() * 256);
	}
	return out;
}

export function randomHex(bytes: number): string {
	return [...randomBytes(bytes)].map(hexByte).join("");
}

export function shortId(): string {
	// 8 hex chars for compact, human-scannable IDs.
	return randomHex(4);
}

export function newRunId(): string {
	// Python uses uuid4().hex (32 hex chars, no dashes).
	return randomHex(16);
}

export function nowTs(): number {
	// Seconds since Unix epoch.
	return Math.floor(Date.now() / 1000);
}

export function nowTsMs(): number {
	// Milliseconds since Unix epoch.
	return Date.now();
}
