type RenderedIo = { stdout?: string; stderr?: string };

export type PiPrettyStreamRendererOpts = {
	/**
	 * Enable ANSI colors/styles (intended for TTY output).
	 * Default: true.
	 */
	color?: boolean;
	/**
	 * Maximum length for tool detail snippets.
	 * Default: 120.
	 */
	maxDetailLen?: number;
};

const ESC = "\x1b[";

function ansi(code: string, text: string): string {
	return `${ESC}${code}m${text}`;
}

function bold(text: string): string {
	// 22 resets both bold + dim.
	return `${ansi("1", text)}${ansi("22", "")}`;
}

function dim(text: string): string {
	return `${ansi("2", text)}${ansi("22", "")}`;
}

function underline(text: string): string {
	return `${ansi("4", text)}${ansi("24", "")}`;
}

function inverse(text: string): string {
	return `${ansi("7", text)}${ansi("27", "")}`;
}

function fg(code: number, text: string): string {
	return `${ansi(String(code), text)}${ansi("39", "")}`;
}

function ensureTrailingNewline(s: string): string {
	return s.endsWith("\n") ? s : `${s}\n`;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	if (n <= 3) return s.slice(0, n);
	return `${s.slice(0, n - 3)}...`;
}

function stripShellWrapper(cmd: string): string {
	// Common wrapper patterns we see from runners.
	// Example: /bin/zsh -lc 'cd /repo && rg -n "x"'
	const m = cmd.match(/^\/\S+\s+-lc\s+([\s\S]+)$/);
	let inner = m?.[1]?.trim() ?? cmd;
	if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
		inner = inner.slice(1, -1);
	}
	inner = inner.replace(/^cd\s+\S+\s*&&\s*/g, "");
	return inner;
}

function summarizeBashCommand(cmd: string, maxLen: number): string {
	const raw = stripShellWrapper(cmd).replaceAll("\\n", "\n").trim();
	if (!raw) return "";
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const head = lines.length <= 1 ? (lines[0] ?? "") : `${lines[0]} (+${lines.length - 1} more lines)`;
	return truncate(head, maxLen);
}

function summarizeToolArgs(toolName: string, args: unknown, maxLen: number): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;

	if (toolName === "bash") {
		const v = (typeof a.command === "string" && a.command) || (typeof a.cmd === "string" && a.cmd) || "";
		return v ? summarizeBashCommand(v, maxLen) : "";
	}

	if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ls") {
		const v =
			(typeof a.path === "string" && a.path) ||
			(typeof a.filePath === "string" && a.filePath) ||
			(typeof a.file_path === "string" && a.file_path) ||
			"";
		return v ? truncate(v, maxLen) : "";
	}

	if (toolName === "glob" || toolName === "find") {
		const v = (typeof a.pattern === "string" && a.pattern) || (typeof a.query === "string" && a.query) || "";
		return v ? truncate(v, maxLen) : "";
	}

	if (toolName === "grep" || toolName === "search") {
		const v = (typeof a.query === "string" && a.query) || (typeof a.pattern === "string" && a.pattern) || "";
		return v ? truncate(v, maxLen) : "";
	}

	// Fallback: first short string field.
	for (const v of Object.values(a)) {
		if (typeof v === "string" && v.trim()) return truncate(v.trim(), maxLen);
	}
	return "";
}

function toolColor(toolName: string): number {
	// Basic categories (kept small; avoid dependency on external theming).
	if (toolName === "bash") return 33; // yellow
	if (
		toolName === "read" ||
		toolName === "ls" ||
		toolName === "grep" ||
		toolName === "glob" ||
		toolName === "find" ||
		toolName === "search"
	)
		return 34; // blue
	if (toolName === "edit" || toolName === "write") return 35; // magenta
	return 36; // cyan
}

function extractMessageText(msg: any): string {
	if (!msg || typeof msg !== "object") return "";

	const text = msg.text;
	if (typeof text === "string" && text) return text;

	const content = msg.content;
	if (typeof content === "string" && content) return content;

	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const item of content) {
			if (!item) continue;
			if (typeof item === "string") {
				if (item) parts.push(item);
				continue;
			}
			if (typeof item === "object") {
				const t = (item as any).text;
				if (typeof t === "string" && t) {
					parts.push(t);
					continue;
				}
				const c = (item as any).content;
				if (typeof c === "string" && c) {
					parts.push(c);
					continue;
				}
				// pi-ai text blocks are often { type: "text", text: "..." }.
				if ((item as any).type === "text" && typeof (item as any).text === "string") {
					const v = (item as any).text;
					if (v) parts.push(v);
				}
			}
		}
		return parts.join("\n");
	}

	return "";
}

function renderInlineMarkdown(text: string, opts: { color: boolean }): string {
	// Keep it simple and safe for terminal output:
	// - Inline code spans: `code`
	// - Strong: **bold**
	// - Links: [label](url)
	const { color } = opts;
	const apply = (s: string, fn: (t: string) => string) => (color ? fn(s) : s);

	const renderNoCode = (seg: string): string => {
		// Links first (before adding ANSI for bold).
		seg = seg.replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
			const labelTxt = String(label);
			const urlTxt = String(url);
			if (!color) return `${labelTxt} (${urlTxt})`;
			return `${underline(labelTxt)}${dim(` (${urlTxt})`)}`;
		});
		seg = seg.replaceAll(/\*\*([^*]+)\*\*/g, (_m, inner) => apply(String(inner), bold));
		return seg;
	};

	let out = "";
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf("`", i);
		if (start === -1) {
			out += renderNoCode(text.slice(i));
			break;
		}
		const end = text.indexOf("`", start + 1);
		if (end === -1) {
			out += renderNoCode(text.slice(i));
			break;
		}
		out += renderNoCode(text.slice(i, start));
		const code = text.slice(start + 1, end);
		out += color ? inverse(code) : code;
		i = end + 1;
	}
	return out;
}

function renderMarkdown(text: string, opts: { color: boolean }): string {
	const { color } = opts;
	const md = text.replaceAll("\r\n", "\n");
	const lines = md.split("\n");
	const out: string[] = [];

	let inCode = false;

	for (const rawLine of lines) {
		const line = rawLine;
		const trimmed = line.trim();

		const fence = trimmed.startsWith("```") ? trimmed : null;
		if (fence) {
			if (!inCode) {
				inCode = true;
				const codeLang = fence.slice(3).trim();
				if (color) {
					out.push(dim(codeLang ? `[code:${codeLang}]` : "[code]"));
				}
			} else {
				inCode = false;
			}
			continue;
		}

		if (inCode) {
			out.push(color ? dim(`  ${line}`) : `  ${line}`);
			continue;
		}

		const h = line.match(/^\s*(#{1,6})\s+(.+)$/);
		if (h) {
			const title = h[2] ?? "";
			if (!color) {
				out.push(title);
				continue;
			}
			out.push(fg(36, bold(title)));
			continue;
		}

		const bq = line.match(/^(\s*)>\s?(.*)$/);
		if (bq) {
			const indent = bq[1] ?? "";
			const body = bq[2] ?? "";
			out.push(color ? `${indent}${dim("|")} ${renderInlineMarkdown(body, { color })}` : `${indent}| ${body}`);
			continue;
		}

		const li = line.match(/^(\s*)([-*+])\s+(.+)$/);
		if (li) {
			const indent = li[1] ?? "";
			const body = li[3] ?? "";
			if (!color) {
				out.push(`${indent}- ${body}`);
				continue;
			}
			out.push(`${indent}${fg(33, "-")} ${renderInlineMarkdown(body, { color })}`);
			continue;
		}

		const oli = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
		if (oli) {
			const indent = oli[1] ?? "";
			const n = oli[2] ?? "";
			const body = oli[3] ?? "";
			if (!color) {
				out.push(`${indent}${n}. ${body}`);
				continue;
			}
			out.push(`${indent}${fg(33, `${n}.`)} ${renderInlineMarkdown(body, { color })}`);
			continue;
		}

		const hr = /^\s*([-*_])\1\1+\s*$/.test(line);
		if (hr) {
			out.push(color ? dim("---") : "---");
			continue;
		}

		out.push(renderInlineMarkdown(line, { color }));
	}

	// Normalize trailing whitespace and ensure a final newline for clean streaming.
	const rendered = out.join("\n").replaceAll(/\s+\n/g, "\n").trimEnd();
	return rendered.length > 0 ? `${rendered}\n` : "";
}

export class PiPrettyStreamRenderer {
	readonly #color: boolean;
	readonly #maxDetailLen: number;

	readonly #pendingTools = new Map<string, { name: string; detail: string }>();
	#assistantText = "";

	constructor(opts: PiPrettyStreamRendererOpts = {}) {
		this.#color = opts.color ?? true;
		this.#maxDetailLen = opts.maxDetailLen ?? 120;
	}

	renderLine(line: string): RenderedIo | null {
		let event: any;
		try {
			event = JSON.parse(line) as any;
		} catch {
			if (!line) return null;
			const out = ensureTrailingNewline(line);
			return { stderr: this.#color ? dim(out.trimEnd()) + "\n" : out };
		}

		const type = event?.type;

		if (type === "tool_execution_start") {
			const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
			const toolName = typeof event?.toolName === "string" ? event.toolName : "tool";
			const args = event?.args;
			if (toolCallId) {
				const detail = summarizeToolArgs(toolName, args, this.#maxDetailLen);
				this.#pendingTools.set(toolCallId, { name: toolName, detail });
			}
			return null;
		}

		if (type === "tool_execution_end") {
			const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
			const toolName = typeof event?.toolName === "string" ? event.toolName : "tool";
			const isError = event?.isError === true;

			const pending = toolCallId ? this.#pendingTools.get(toolCallId) : undefined;
			if (toolCallId) this.#pendingTools.delete(toolCallId);

			const name = pending?.name ?? toolName;
			const detail = pending?.detail ?? "";

			const prefix = isError ? "x" : "+";
			if (!this.#color) {
				const plain = `  ${prefix} ${name}${detail ? ` ${detail}` : ""}`;
				return { stderr: ensureTrailingNewline(plain) };
			}

			const pfx = isError ? fg(31, prefix) : fg(32, prefix);
			const tname = fg(toolColor(name), bold(name));
			const d = detail ? ` ${dim(detail)}` : "";
			return { stderr: `  ${pfx} ${tname}${d}\n` };
		}

		if (type === "message_update") {
			const assistantEvent = event?.assistantMessageEvent;
			if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
				this.#assistantText += assistantEvent.delta;
			}
			return null;
		}

		if (type === "message_end") {
			const msg = event?.message;
			if (msg && typeof msg === "object" && msg.role === "assistant") {
				let body = this.#assistantText;
				this.#assistantText = "";
				if (!body.trim()) {
					body = extractMessageText(msg);
				}
				const rendered = renderMarkdown(body, { color: this.#color });
				if (!rendered) return null;
				if (!this.#color) return { stdout: rendered };
				const header = fg(32, bold("agent"));
				return { stdout: `\n${header}\n${rendered}` };
			}
			return null;
		}

		if (type === "error") {
			const msg =
				typeof event?.error === "string"
					? event.error
					: typeof event?.message === "string"
						? event.message
						: "error";
			if (!this.#color) return { stderr: ensureTrailingNewline(`  error: ${msg}`) };
			return { stderr: `  ${fg(31, bold("error"))} ${fg(31, msg)}\n` };
		}

		return null;
	}

	finish(): RenderedIo | null {
		// Safety net: flush any buffered assistant text (pi should end with message_end).
		if (!this.#assistantText.trim()) return null;
		const rendered = renderMarkdown(this.#assistantText, { color: this.#color });
		this.#assistantText = "";
		if (!rendered) return null;
		if (!this.#color) return { stdout: rendered };
		const header = fg(32, bold("agent"));
		return { stdout: `\n${header}\n${rendered}` };
	}
}
