export function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

export function signalExitCode(signal: NodeJS.Signals): number {
	switch (signal) {
		case "SIGINT":
			return 130;
		case "SIGTERM":
			return 143;
		default:
			return 1;
	}
}

export function delayMs(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function setSearchParamIfPresent(search: URLSearchParams, key: string, value: string | null | undefined): void {
	if (value == null) {
		return;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return;
	}
	search.set(key, trimmed);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function trimForHeader(text: string, maxLen: number): string {
	const t = oneLine(text);
	if (t.length <= maxLen) return t;
	if (maxLen <= 3) return t.slice(0, maxLen);
	return `${t.slice(0, maxLen - 3)}...`;
}

export function ensureTrailingNewline(text: string): string {
	return text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
}
