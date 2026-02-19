export type PiStreamRendererOpts = {
	/**
	 * Render tool execution lifecycle events (start/end).
	 * Default: false (assistant text only).
	 */
	showToolEvents?: boolean;
	/**
	 * Render model "thinking" deltas (if present).
	 * Default: false.
	 */
	showThinking?: boolean;
};

/**
 * Compact renderer for pi JSONL event streams (pi CLI `--mode json` and pi SDK AgentEvent JSON).
 *
 * Intended usage:
 *
 * ```ts
 * const r = new PiStreamRenderer();
 * onLine: (line) => {
 *   const out = r.renderLine(line);
 *   if (out) process.stdout.write(out);
 * }
 * ```
 */
export class PiStreamRenderer {
	readonly #showToolEvents: boolean;
	readonly #showThinking: boolean;
	#needsNewline = false;

	constructor(opts: PiStreamRendererOpts = {}) {
		this.#showToolEvents = opts.showToolEvents ?? false;
		this.#showThinking = opts.showThinking ?? false;
	}

	renderLine(line: string): string | null {
		let event: any;
		try {
			event = JSON.parse(line) as any;
		} catch {
			// Mixed stdout/stderr can include plain-text warnings; surface them.
			if (!line) return null;
			this.#needsNewline = false;
			return line.endsWith("\n") ? line : `${line}\n`;
		}

		const type = event?.type;

		if (type === "message_update") {
			const assistantEvent = event?.assistantMessageEvent;
			if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
				const delta = assistantEvent.delta;
				if (!delta) return null;
				this.#needsNewline = !delta.endsWith("\n");
				return delta;
			}

			if (
				this.#showThinking &&
				assistantEvent?.type === "thinking_delta" &&
				typeof assistantEvent.delta === "string"
			) {
				const delta = assistantEvent.delta;
				if (!delta) return null;
				this.#needsNewline = !delta.endsWith("\n");
				return delta;
			}

			if (assistantEvent?.type === "error") {
				let out = "";
				if (this.#needsNewline) {
					out += "\n";
					this.#needsNewline = false;
				}
				const reason = typeof assistantEvent.reason === "string" ? assistantEvent.reason : "error";
				out += `[assistant:${reason}]\n`;
				return out;
			}

			return null;
		}

		if (type === "message_end") {
			const msg = event?.message;
			if (msg && typeof msg === "object" && msg.role === "assistant") {
				if (this.#needsNewline) {
					this.#needsNewline = false;
					return "\n";
				}
			}
			return null;
		}

		if (this.#showToolEvents && type === "tool_execution_start") {
			const toolName = typeof event?.toolName === "string" ? event.toolName : "tool";
			let out = "";
			if (this.#needsNewline) {
				out += "\n";
				this.#needsNewline = false;
			}
			out += `[tool] ${toolName}\n`;
			return out;
		}

		if (this.#showToolEvents && type === "tool_execution_end" && event?.isError === true) {
			const toolName = typeof event?.toolName === "string" ? event.toolName : "tool";
			let out = "";
			if (this.#needsNewline) {
				out += "\n";
				this.#needsNewline = false;
			}
			out += `[tool:error] ${toolName}\n`;
			return out;
		}

		return null;
	}
}
