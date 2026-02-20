import { relative } from "node:path";
import type { BackendRunner } from "@femtomc/mu-agent";
import type { EventLog, StorePaths } from "@femtomc/mu-core/node";
import type { ForumStore } from "@femtomc/mu-forum";
import type { IssueStore } from "@femtomc/mu-issue";
import type {
	DagRunnerBackendLineEvent,
	DagRunnerHooks,
	DagRunnerStepEndEvent,
	DagRunnerStepStartEvent,
	ModelOverrides,
} from "@femtomc/mu-orchestrator";

export type ResumeCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type ResumeIssueResolution = {
	issueId: string | null;
	error: string | null;
};

type ResumeCliWriter = {
	write: (chunk: string) => void;
	isTTY?: boolean;
};

type ResumeCliIo = {
	stdout?: ResumeCliWriter;
	stderr?: ResumeCliWriter;
};

export type ResumeCommandCtx = {
	repoRoot: string;
	store: IssueStore;
	forum: ForumStore;
	events: EventLog;
	paths: StorePaths;
	io?: ResumeCliIo;
	backend?: BackendRunner;
};

export type ResumeCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => ResumeCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => ResumeCommandRunResult;
	ensureStoreInitialized: (ctx: Pick<ResumeCommandCtx, "paths">) => Promise<void>;
	resolveIssueId: (store: IssueStore, rawId: string) => Promise<ResumeIssueResolution>;
	trimForHeader: (text: string, maxLen: number) => string;
	ensureTrailingNewline: (text: string) => string;
};

export async function cmdResume<Ctx extends ResumeCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: ResumeCommandDeps,
): Promise<ResumeCommandRunResult> {
	const {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		resolveIssueId,
		trimForHeader,
		ensureTrailingNewline,
	} = deps;

	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu resume - resume an interrupted run",
				"",
				"Usage:",
				"  mu resume <root-id> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--raw-stream] [--json]",
				"",
				"Model flags:",
				"  --model <id>        Model ID (e.g. gpt-5.3-codex, claude-opus-4-6)",
				"  --provider <id>     Provider (e.g. anthropic, openai-codex)",
				"  --reasoning <lvl>   Thinking level (minimal|low|medium|high|xhigh)",
				"",
				"See also: `mu guide`",
			].join("\n") + "\n",
		);
	}

	const rawId = argv[0]!;
	let maxSteps = 20;
	let jsonMode = false;
	let rawStream = false;
	let modelFlag: string | undefined;
	let providerFlag: string | undefined;
	let reasoningFlag: string | undefined;
	const rest = argv.slice(1);

	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--json") {
			jsonMode = true;
			continue;
		}
		if (a === "--raw-stream") {
			rawStream = true;
			continue;
		}
		if (a === "--max-steps") {
			const next = rest[i + 1];
			if (!next) {
				return jsonError("missing value for --max-steps", { recovery: [`mu resume ${rawId} --max-steps 20`] });
			}
			const n = ensureInt(next, { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: [`mu resume ${rawId} --max-steps 20`] });
			}
			maxSteps = n;
			i += 1;
			continue;
		}
		if (a.startsWith("--max-steps=")) {
			const n = ensureInt(a.slice("--max-steps=".length), { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: [`mu resume ${rawId} --max-steps 20`] });
			}
			maxSteps = n;
			continue;
		}
		if (a === "--model") {
			modelFlag = rest[++i];
			continue;
		}
		if (a.startsWith("--model=")) {
			modelFlag = a.slice("--model=".length);
			continue;
		}
		if (a === "--provider") {
			providerFlag = rest[++i];
			continue;
		}
		if (a.startsWith("--provider=")) {
			providerFlag = a.slice("--provider=".length);
			continue;
		}
		if (a === "--reasoning") {
			reasoningFlag = rest[++i];
			continue;
		}
		if (a.startsWith("--reasoning=")) {
			reasoningFlag = a.slice("--reasoning=".length);
			continue;
		}
		return jsonError(`unknown arg: ${a}`, { recovery: ["mu resume --help"] });
	}

	const modelOverrides: ModelOverrides = {};
	if (modelFlag) modelOverrides.model = modelFlag;
	if (providerFlag) modelOverrides.provider = providerFlag;
	if (reasoningFlag) modelOverrides.reasoning = reasoningFlag;

	if (jsonMode && rawStream) {
		return jsonError("cannot combine --json and --raw-stream", {
			recovery: [`mu resume ${rawId} --json`, `mu resume ${rawId} --raw-stream`],
		});
	}

	await ensureStoreInitialized(ctx);

	const resolved = await resolveIssueId(ctx.store, rawId);
	if (resolved.error) {
		return { stdout: jsonText({ error: resolved.error }, false), stderr: "", exitCode: 1 };
	}
	const rootId = resolved.issueId!;

	const reset = await ctx.store.reset_in_progress(rootId);
	const { newRunId, runContext } = await import("@femtomc/mu-core/node");
	const { PiPrettyStreamRenderer } = await import("../pi_pretty_stream_renderer.js");
	const runId = newRunId();
	const io = ctx.io;
	const streaming = io != null && !jsonMode;

	let lastStepIssueId: string | null = null;
	let lastBackendIssueId: string | null = null;
	let lineOpen = false;

	const { DagRunner, PiStreamRenderer } = await import("@femtomc/mu-orchestrator");
	const usePretty = Boolean(io?.stdout?.isTTY && io?.stderr?.isTTY);
	const pretty = rawStream || !usePretty ? null : new PiPrettyStreamRenderer({ color: Bun.env.NO_COLOR == null });
	const renderer = rawStream || usePretty ? null : new PiStreamRenderer();

	const hooks: DagRunnerHooks | undefined = streaming
		? {
				onStepStart: (ev: DagRunnerStepStartEvent) => {
					lastStepIssueId = ev.issueId;
					const role = ev.role ?? "orchestrator";
					const title = trimForHeader(ev.title ?? "", 80);
					if (lineOpen) {
						io?.stderr?.write("\n");
						lineOpen = false;
					}
					io?.stderr?.write(`Step ${ev.step}/${maxSteps}  ${ev.issueId}  role=${role}  ${title}\n`);
				},
				onBackendLine: (ev: DagRunnerBackendLineEvent) => {
					lastBackendIssueId = ev.issueId;
					if (rawStream) {
						const out = ensureTrailingNewline(ev.line);
						io?.stdout?.write(out);
						lineOpen = false;
						return;
					}
					const rendered = pretty?.renderLine(ev.line);
					if (rendered) {
						if (rendered.stderr) io?.stderr?.write(rendered.stderr);
						if (rendered.stdout) io?.stdout?.write(rendered.stdout);
						const tail = rendered.stdout ?? rendered.stderr ?? "";
						lineOpen = tail.length > 0 && !tail.endsWith("\n");
						return;
					}
					const out = renderer?.renderLine(ev.line);
					if (out) {
						io?.stdout?.write(out);
						lineOpen = !out.endsWith("\n");
					}
				},
				onStepEnd: (ev: DagRunnerStepEndEvent) => {
					const flush = pretty?.finish();
					if (flush) {
						if (flush.stderr) io?.stderr?.write(flush.stderr);
						if (flush.stdout) io?.stdout?.write(flush.stdout);
						lineOpen = false;
					}
					const outcome = ev.outcome ?? "?";
					const elapsed = Number.isFinite(ev.elapsedS) ? ev.elapsedS.toFixed(1) : String(ev.elapsedS);
					if (lineOpen) {
						io?.stderr?.write("\n");
						lineOpen = false;
					}
					io?.stderr?.write(
						`Done ${ev.step}/${maxSteps}  ${ev.issueId}  outcome=${outcome}  elapsed=${elapsed}s  exit=${ev.exitCode}\n`,
					);
				},
			}
		: undefined;

	const result = await runContext({ runId }, async () => {
		if (streaming) {
			if (reset.length > 0) {
				io?.stderr?.write(`Reset ${reset.length} stale issue(s) to open: ${reset.join(", ")}\n`);
			}
			io?.stderr?.write(`Resuming ${rootId}\n`);
		}
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot, {
			backend: ctx.backend,
			events: ctx.events,
			modelOverrides,
		});
		return await runner.run(rootId, maxSteps, { hooks });
	});

	if (jsonMode) {
		return {
			stdout: jsonText({ status: result.status, steps: result.steps, error: result.error, root_id: rootId }, true),
			stderr: "",
			exitCode: result.status === "root_final" ? 0 : 1,
		};
	}

	const exitCode = result.status === "root_final" ? 0 : 1;
	if (streaming) {
		io?.stderr?.write(`Runner status: ${result.status}\n`);
		if (result.error) {
			io?.stderr?.write(`Error: ${result.error}\n`);
		}
		if (exitCode !== 0) {
			const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootId;
			const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
			io?.stderr?.write(
				[
					"",
					"Recovery:",
					`  mu replay ${rootId}/${replayId}`,
					`  logs: ${logsRel}/${rootId}/${replayId}*.jsonl`,
					`  resume: mu resume ${rootId} --max-steps ${maxSteps}`,
					"",
				].join("\n"),
			);
		}
		return { stdout: "", stderr: "", exitCode };
	}

	let out = "";
	if (reset.length > 0) {
		out += `Reset ${reset.length} stale issue(s) to open: ${reset.join(", ")}\n`;
	}
	out += `Resuming ${rootId}\n`;
	out += `Runner status: ${result.status}\n`;
	if (result.error) {
		out += `Error: ${result.error}\n`;
	}
	if (exitCode !== 0) {
		const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootId;
		const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
		out += "\nRecovery:\n";
		out += `  mu replay ${rootId}/${replayId}\n`;
		out += `  logs: ${logsRel}/${rootId}/${replayId}*.jsonl\n`;
		out += `  resume: mu resume ${rootId} --max-steps ${maxSteps}\n`;
	}
	return { stdout: out, stderr: "", exitCode };
}
