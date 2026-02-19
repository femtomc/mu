import { z } from "zod";

const ISSUE_ID_RE = /^mu-[a-z0-9][a-z0-9-]*$/;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const MuCliCommandKindSchema = z.enum([
	"status",
	"ready",
	"issue_get",
	"issue_list",
	"forum_read",
	"run_list",
	"run_status",
	"run_start",
	"run_resume",
	"run_interrupt",
]);
export type MuCliCommandKind = z.infer<typeof MuCliCommandKindSchema>;

export const MuCliValidationErrorReasonSchema = z.enum(["operator_action_disallowed", "cli_validation_failed"]);
export type MuCliValidationErrorReason = z.infer<typeof MuCliValidationErrorReasonSchema>;

const KNOWN_COMMAND_KEYS = new Set<string>([
	"status",
	"ready",
	"issue get",
	"issue list",
	"forum read",
	"run list",
	"run status",
	"run start",
	"run resume",
	"run interrupt",
]);

export type MuCliInvocationPlan = {
	invocationId: string;
	commandKind: MuCliCommandKind;
	argv: string[];
	timeoutMs: number;
	runRootId: string | null;
	mutating: boolean;
};

export type MuCliPlanDecision =
	| { kind: "skip" }
	| { kind: "reject"; reason: MuCliValidationErrorReason; details?: string }
	| { kind: "ok"; plan: MuCliInvocationPlan };

export type MuCliCommandSurfaceOpts = {
	muBinary?: string;
	readTimeoutMs?: number;
	runTimeoutMs?: number;
};

function parsePositiveInt(raw: string): number | null {
	if (!/^[0-9]+$/.test(raw)) {
		return null;
	}
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		return null;
	}
	return value;
}

function parseRunMaxSteps(arg: string | undefined): number | null {
	if (arg == null) {
		return 20;
	}
	const parsed = parsePositiveInt(arg);
	if (parsed == null || parsed < 1 || parsed > 500) {
		return null;
	}
	return parsed;
}

function parseForumLimit(arg: string | undefined): number | null {
	if (arg == null) {
		return 50;
	}
	const parsed = parsePositiveInt(arg);
	if (parsed == null || parsed < 1 || parsed > 500) {
		return null;
	}
	return parsed;
}

function resolveIssueId(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	if (!ISSUE_ID_RE.test(value)) {
		return null;
	}
	return value;
}

function resolveTopic(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	if (!TOPIC_RE.test(value)) {
		return null;
	}
	return value;
}

function defaultInvocationId(): string {
	return `cli-${crypto.randomUUID()}`;
}

function reject(reason: MuCliValidationErrorReason, details?: string): MuCliPlanDecision {
	return {
		kind: "reject",
		reason,
		details,
	};
}

export class MuCliCommandSurface {
	readonly #muBinary: string;
	readonly #readTimeoutMs: number;
	readonly #runTimeoutMs: number;

	public constructor(opts: MuCliCommandSurfaceOpts = {}) {
		this.#muBinary = opts.muBinary ?? "mu";
		this.#readTimeoutMs = Math.max(1_000, Math.trunc(opts.readTimeoutMs ?? 20_000));
		this.#runTimeoutMs = Math.max(1_000, Math.trunc(opts.runTimeoutMs ?? 10 * 60 * 1_000));
	}

	public build(opts: { commandKey: string; args: readonly string[]; invocationId?: string }): MuCliPlanDecision {
		const invocationId = opts.invocationId ?? defaultInvocationId();
		const args = opts.args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);

		if (!KNOWN_COMMAND_KEYS.has(opts.commandKey)) {
			return { kind: "skip" };
		}

		for (const arg of args) {
			if (arg.startsWith("-")) {
				return reject("cli_validation_failed", `flags are not allowed in command args: ${arg}`);
			}
		}

		switch (opts.commandKey) {
			case "status": {
				if (args.length > 0) {
					return reject("cli_validation_failed", "status does not accept arguments");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "status",
						argv: [this.#muBinary, "status", "--json"],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "ready": {
				if (args.length > 0) {
					return reject("cli_validation_failed", "ready does not accept arguments");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "ready",
						argv: [this.#muBinary, "issues", "ready"],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "issue get": {
				if (args.length !== 1) {
					return reject("cli_validation_failed", "issue get requires exactly one issue id");
				}
				const issueId = resolveIssueId(args[0]);
				if (!issueId) {
					return reject("cli_validation_failed", "invalid issue id");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "issue_get",
						argv: [this.#muBinary, "issues", "get", issueId],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "issue list": {
				if (args.length > 0) {
					return reject("cli_validation_failed", "issue list does not accept positional arguments");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "issue_list",
						argv: [this.#muBinary, "issues", "list"],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "forum read": {
				if (args.length < 1 || args.length > 2) {
					return reject("cli_validation_failed", "forum read expects <topic> [limit]");
				}
				const topic = resolveTopic(args[0]);
				if (!topic) {
					return reject("cli_validation_failed", "invalid forum topic");
				}
				const limit = parseForumLimit(args[1]);
				if (limit == null) {
					return reject("cli_validation_failed", "invalid forum limit");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "forum_read",
						argv: [this.#muBinary, "forum", "read", topic, "--limit", String(limit)],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "run list": {
				if (args.length > 0) {
					return reject("cli_validation_failed", "run list does not accept arguments");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "run_list",
						argv: [this.#muBinary, "runs", "list", "--limit", "100"],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "run status": {
				if (args.length !== 1) {
					return reject("cli_validation_failed", "run status expects <root-id>");
				}
				const rootId = resolveIssueId(args[0]);
				if (!rootId) {
					return reject("cli_validation_failed", "invalid run root id");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "run_status",
						argv: [this.#muBinary, "runs", "get", rootId],
						timeoutMs: this.#readTimeoutMs,
						runRootId: rootId,
						mutating: false,
					},
				};
			}
			case "run interrupt": {
				if (args.length !== 1) {
					return reject("cli_validation_failed", "run interrupt expects <root-id>");
				}
				const rootId = resolveIssueId(args[0]);
				if (!rootId) {
					return reject("cli_validation_failed", "invalid run root id");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "run_interrupt",
						argv: [this.#muBinary, "runs", "interrupt", rootId],
						timeoutMs: this.#runTimeoutMs,
						runRootId: rootId,
						mutating: true,
					},
				};
			}
			case "run start": {
				if (args.length === 0) {
					return reject("cli_validation_failed", "run start requires a prompt");
				}
				if (args.some((arg) => arg.startsWith("-"))) {
					return reject("cli_validation_failed", "run start prompt contains disallowed flag-like token");
				}
				if (args.some((arg) => /[\u0000-\u001f]/.test(arg))) {
					return reject("cli_validation_failed", "run start prompt contains control characters");
				}
				const prompt = args.join(" ");
				if (prompt.length > 500) {
					return reject("cli_validation_failed", "run start prompt is too long");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "run_start",
						argv: [this.#muBinary, "runs", "start", prompt, "--max-steps", "20"],
						timeoutMs: this.#runTimeoutMs,
						runRootId: null,
						mutating: true,
					},
				};
			}
			case "run resume": {
				if (args.length < 1 || args.length > 2) {
					return reject("cli_validation_failed", "run resume expects <root-id> [max-steps]");
				}
				const rootId = resolveIssueId(args[0]);
				if (!rootId) {
					return reject("cli_validation_failed", "invalid run root id");
				}
				const maxSteps = parseRunMaxSteps(args[1]);
				if (maxSteps == null) {
					return reject("cli_validation_failed", "invalid max-steps");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "run_resume",
						argv: [this.#muBinary, "runs", "resume", rootId, "--max-steps", String(maxSteps)],
						timeoutMs: this.#runTimeoutMs,
						runRootId: rootId,
						mutating: true,
					},
				};
			}
			default:
				return { kind: "skip" };
		}
	}
}

export type MuCliFailureCode = "cli_spawn_failed" | "cli_timeout" | "cli_nonzero";

export type MuCliRunResult =
	| {
			kind: "completed";
			stdout: string;
			stderr: string;
			exitCode: number;
			runRootId: string | null;
	  }
	| {
			kind: "failed";
			errorCode: MuCliFailureCode;
			stdout: string;
			stderr: string;
			exitCode: number | null;
			runRootId: string | null;
	  };

export interface MuCliRunnerLike {
	run(opts: { plan: MuCliInvocationPlan; repoRoot: string }): Promise<MuCliRunResult>;
}

function extractRootIssueId(stdout: string, stderr: string): string | null {
	const joined = `${stdout}\n${stderr}`;
	const match = /\bRoot:\s*(mu-[a-z0-9]{4,})\b/i.exec(joined);
	if (!match?.[1]) {
		return null;
	}
	return match[1].toLowerCase();
}

async function streamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) {
		return "";
	}
	return await new Response(stream).text();
}

export class MuCliRunner implements MuCliRunnerLike {
	public async run(opts: { plan: MuCliInvocationPlan; repoRoot: string }): Promise<MuCliRunResult> {
		const argv = opts.plan.argv;
		if (argv.length === 0) {
			return {
				kind: "failed",
				errorCode: "cli_spawn_failed",
				stdout: "",
				stderr: "empty argv",
				exitCode: null,
				runRootId: opts.plan.runRootId,
			};
		}

		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn({
				cmd: argv,
				cwd: opts.repoRoot,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: Bun.env,
			});
		} catch (err) {
			return {
				kind: "failed",
				errorCode: "cli_spawn_failed",
				stdout: "",
				stderr: err instanceof Error ? err.message : "spawn_failed",
				exitCode: null,
				runRootId: opts.plan.runRootId,
			};
		}

		let didTimeout = false;
		const timeout = setTimeout(() => {
			didTimeout = true;
			proc.kill("SIGKILL");
		}, opts.plan.timeoutMs);

		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				streamText(proc.stdout),
				streamText(proc.stderr),
			]);

			if (didTimeout) {
				return {
					kind: "failed",
					errorCode: "cli_timeout",
					stdout,
					stderr,
					exitCode,
					runRootId: opts.plan.runRootId,
				};
			}

			if (exitCode !== 0) {
				return {
					kind: "failed",
					errorCode: "cli_nonzero",
					stdout,
					stderr,
					exitCode,
					runRootId: opts.plan.runRootId,
				};
			}

			const parsedRunRoot =
				opts.plan.commandKind === "run_start" ? extractRootIssueId(stdout, stderr) : opts.plan.runRootId;
			return {
				kind: "completed",
				stdout,
				stderr,
				exitCode,
				runRootId: parsedRunRoot,
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}
