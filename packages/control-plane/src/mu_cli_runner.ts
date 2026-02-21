import { z } from "zod";

const ISSUE_ID_RE = /^mu-[a-z0-9][a-z0-9-]*$/;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const MuCliCommandKindSchema = z.enum([
	"status",
	"ready",
	"issue_get",
	"issue_list",
	"forum_read",
	"operator_config_get",
	"operator_model_list",
	"operator_thinking_list",
	"operator_model_set",
	"operator_thinking_set",
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
	"operator config get",
	"operator model list",
	"operator thinking list",
	"operator model set",
	"operator thinking set",
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

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function resolveThinkingLevel(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (!THINKING_LEVELS.has(normalized)) {
		return null;
	}
	return normalized;
}

function resolveSafeToken(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	if (!/^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
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
			case "operator config get": {
				if (args.length > 0) {
					return reject("cli_validation_failed", "operator config get does not accept arguments");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "operator_config_get",
						argv: [this.#muBinary, "control", "operator", "get", "--json"],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "operator model list": {
				if (args.length > 1) {
					return reject("cli_validation_failed", "operator model list expects [provider]");
				}
				const provider = resolveSafeToken(args[0]);
				if (args[0] != null && !provider) {
					return reject("cli_validation_failed", "invalid provider id");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "operator_model_list",
						argv: [this.#muBinary, "control", "operator", "models", ...(provider ? [provider] : []), "--json"],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "operator thinking list": {
				if (args.length > 2) {
					return reject("cli_validation_failed", "operator thinking list expects [provider] [model]");
				}
				const provider = resolveSafeToken(args[0]);
				if (args[0] != null && !provider) {
					return reject("cli_validation_failed", "invalid provider id");
				}
				const model = resolveSafeToken(args[1]);
				if (args[1] != null && !model) {
					return reject("cli_validation_failed", "invalid model id");
				}
				if (!provider && model) {
					return reject("cli_validation_failed", "model requires provider context");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "operator_thinking_list",
						argv: [
							this.#muBinary,
							"control",
							"operator",
							"thinking",
							...(provider ? [provider] : []),
							...(model ? [model] : []),
							"--json",
						],
						timeoutMs: this.#readTimeoutMs,
						runRootId: null,
						mutating: false,
					},
				};
			}
			case "operator model set": {
				if (args.length < 2 || args.length > 3) {
					return reject("cli_validation_failed", "operator model set expects <provider> <model> [thinking]");
				}
				const provider = resolveSafeToken(args[0]);
				if (!provider) {
					return reject("cli_validation_failed", "invalid provider id");
				}
				const model = resolveSafeToken(args[1]);
				if (!model) {
					return reject("cli_validation_failed", "invalid model id");
				}
				const thinking = args[2] != null ? resolveThinkingLevel(args[2]) : null;
				if (args[2] != null && !thinking) {
					return reject("cli_validation_failed", "invalid thinking level");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "operator_model_set",
						argv: [
							this.#muBinary,
							"control",
							"operator",
							"set",
							provider,
							model,
							...(thinking ? [thinking] : []),
							"--json",
						],
						timeoutMs: this.#runTimeoutMs,
						runRootId: null,
						mutating: true,
					},
				};
			}
			case "operator thinking set": {
				if (args.length !== 1) {
					return reject("cli_validation_failed", "operator thinking set expects <thinking>");
				}
				const thinking = resolveThinkingLevel(args[0]);
				if (!thinking) {
					return reject("cli_validation_failed", "invalid thinking level");
				}
				return {
					kind: "ok",
					plan: {
						invocationId,
						commandKind: "operator_thinking_set",
						argv: [this.#muBinary, "control", "operator", "thinking-set", thinking, "--json"],
						timeoutMs: this.#runTimeoutMs,
						runRootId: null,
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

			return {
				kind: "completed",
				stdout,
				stderr,
				exitCode,
				runRootId: opts.plan.runRootId,
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}
