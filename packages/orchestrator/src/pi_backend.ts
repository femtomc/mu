import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { MuRole } from "./mu_roles.js";

export type BackendRunOpts = {
	issueId: string;
	role: MuRole;
	systemPrompt: string;
	prompt: string;
	provider: string;
	model: string;
	thinking: string;
	cwd: string;
	cli: string;
	logSuffix: string;
	onLine?: (line: string) => void;
	teePath?: string;
};

export interface BackendRunner {
	run(opts: BackendRunOpts): Promise<number>;
}

export type PiCliArgvOpts = Pick<BackendRunOpts, "prompt" | "systemPrompt" | "provider" | "model" | "thinking">;

/** Build argv for the `pi` CLI. Exported for regression testing. */
export function buildPiCliArgv(opts: PiCliArgvOpts): string[] {
	return [
		"pi",
		"--mode",
		"json",
		"--no-session",
		"--provider",
		opts.provider,
		"--model",
		opts.model,
		"--thinking",
		opts.thinking,
		"--system-prompt",
		opts.systemPrompt,
		opts.prompt,
	];
}

export function piStreamHasError(line: string): boolean {
	let event: any;
	try {
		event = JSON.parse(line) as any;
	} catch {
		return false;
	}

	const etype = event?.type;
	if (etype === "message_update") {
		const assistantEvent = event?.assistantMessageEvent;
		if (assistantEvent && typeof assistantEvent === "object" && assistantEvent.type === "error") {
			return true;
		}
	}

	if (etype === "message_end") {
		const message = event?.message;
		if (!message || typeof message !== "object") {
			return false;
		}
		if (message.role !== "assistant") {
			return false;
		}
		return message.stopReason === "error" || message.stopReason === "aborted";
	}

	return false;
}

export class PiCliBackend implements BackendRunner {
	public async run(opts: BackendRunOpts): Promise<number> {
		if (opts.cli !== "pi") {
			throw new Error(`unsupported backend cli=${JSON.stringify(opts.cli)} (only "pi" is supported)`);
		}

		const argv = buildPiCliArgv(opts);

		let teeFh: Awaited<ReturnType<typeof open>> | null = null;
		try {
			if (opts.teePath) {
				await mkdir(dirname(opts.teePath), { recursive: true });
				teeFh = await open(opts.teePath, "w");
			}

			const proc = spawn(argv[0]!, argv.slice(1), {
				cwd: opts.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const merged = new PassThrough();
			proc.stdout?.pipe(merged);
			proc.stderr?.pipe(merged);

			let sawAssistantError = false;
			const DELTA_TYPES = /^(?:thinking_delta|toolcall_delta|text_delta)$/;
			const rl = createInterface({ input: merged, crlfDelay: Number.POSITIVE_INFINITY });

			const readLoop = (async () => {
				for await (const line of rl) {
					const trimmed = String(line);
					if (piStreamHasError(trimmed)) {
						sawAssistantError = true;
					}
					opts.onLine?.(trimmed);
					if (teeFh) {
						// Skip streaming deltas from the log — they carry the full
						// accumulated message state on every token, causing quadratic
						// log growth. Structural events are preserved.
						let skip = false;
						try {
							const parsed = JSON.parse(trimmed) as any;
							const aType = parsed?.assistantMessageEvent?.type;
							if (typeof aType === "string" && DELTA_TYPES.test(aType)) {
								skip = true;
							}
						} catch {}
						if (!skip) {
							await teeFh.write(`${trimmed}\n`);
						}
					}
				}
			})();

			const exitCode = await new Promise<number>((resolve, reject) => {
				proc.once("error", (err) => reject(err));
				proc.once("close", (code) => resolve(code ?? 0));
			});

			// Ensure the reader finishes (and flushes tee writes).
			await readLoop;

			if (exitCode === 0 && sawAssistantError) {
				return 1;
			}
			return exitCode;
		} finally {
			if (teeFh) {
				await teeFh.close();
			}
		}
	}
}
