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

export type RunDirectCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type RunDirectCliWriter = {
	write: (chunk: string) => void;
	isTTY?: boolean;
};

type RunDirectCliIo = {
	stdout?: RunDirectCliWriter;
	stderr?: RunDirectCliWriter;
};

export type RunDirectCommandCtx = {
	repoRoot: string;
	store: IssueStore;
	forum: ForumStore;
	events: EventLog;
	paths: StorePaths;
	io?: RunDirectCliIo;
	backend?: BackendRunner;
};

export type RunDirectCommandDeps = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => RunDirectCommandRunResult;
	jsonText: (data: unknown, pretty: boolean) => string;
	ok: (stdout?: string, exitCode?: number) => RunDirectCommandRunResult;
	ensureStoreInitialized: (ctx: Pick<RunDirectCommandCtx, "paths">) => Promise<void>;
	trimForHeader: (text: string, maxLen: number) => string;
	ensureTrailingNewline: (text: string) => string;
};

export async function cmdRunDirect<Ctx extends RunDirectCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: RunDirectCommandDeps,
): Promise<RunDirectCommandRunResult> {
	const {
		hasHelpFlag,
		ensureInt,
		jsonError,
		jsonText,
		ok,
		ensureStoreInitialized,
		trimForHeader,
		ensureTrailingNewline,
	} = deps;
	if (argv.length === 0 || hasHelpFlag(argv)) {
		return ok(
			[
				"mu run - create a root work item and start execution",
				"",
				"Usage:",
				"  mu run <prompt...> [--max-steps N] [--model ID] [--provider ID] [--reasoning LVL] [--raw-stream] [--json]",
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

	let maxSteps = 20;
	let jsonMode = false;
	let rawStream = false;
	let modelFlag: string | undefined;
	let providerFlag: string | undefined;
	let reasoningFlag: string | undefined;
	const promptParts: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--json") {
			jsonMode = true;
			continue;
		}
		if (a === "--raw-stream") {
			rawStream = true;
			continue;
		}
		if (a === "--max-steps") {
			const next = argv[i + 1];
			if (!next) {
				return jsonError("missing value for --max-steps", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			const n = ensureInt(next, { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			maxSteps = n;
			i += 1;
			continue;
		}
		if (a.startsWith("--max-steps=")) {
			const n = ensureInt(a.slice("--max-steps=".length), { name: "--max-steps", min: 1 });
			if (n == null) {
				return jsonError("max-steps must be >= 1", { recovery: ['mu run --max-steps 20 "..."'] });
			}
			maxSteps = n;
			continue;
		}
		if (a === "--model") {
			modelFlag = argv[++i];
			continue;
		}
		if (a.startsWith("--model=")) {
			modelFlag = a.slice("--model=".length);
			continue;
		}
		if (a === "--provider") {
			providerFlag = argv[++i];
			continue;
		}
		if (a.startsWith("--provider=")) {
			providerFlag = a.slice("--provider=".length);
			continue;
		}
		if (a === "--reasoning") {
			reasoningFlag = argv[++i];
			continue;
		}
		if (a.startsWith("--reasoning=")) {
			reasoningFlag = a.slice("--reasoning=".length);
			continue;
		}
		promptParts.push(a);
	}

	const modelOverrides: ModelOverrides = {};
	if (modelFlag) modelOverrides.model = modelFlag;
	if (providerFlag) modelOverrides.provider = providerFlag;
	if (reasoningFlag) modelOverrides.reasoning = reasoningFlag;

	const promptText = promptParts.join(" ").trim();
	if (!promptText) {
		return jsonError("missing prompt", { recovery: ['mu run "Break down and execute this goal"'] });
	}

	if (jsonMode && rawStream) {
		return jsonError("cannot combine --json and --raw-stream", {
			recovery: ['mu run "..." --json', 'mu run "..." --raw-stream'],
		});
	}

	await ensureStoreInitialized(ctx);

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

	const { rootIssue, result } = await runContext({ runId }, async () => {
		const rootIssue = await ctx.store.create(promptText, { tags: ["node:agent", "node:root"] });
		if (streaming) {
			io?.stderr?.write(`Root: ${rootIssue.id}  ${trimForHeader(String(rootIssue.title ?? ""), 80)}\n`);
		}
		const runner = new DagRunner(ctx.store, ctx.forum, ctx.repoRoot, {
			backend: ctx.backend,
			events: ctx.events,
			modelOverrides,
		});
		const result = await runner.run(rootIssue.id, maxSteps, { hooks });
		return { rootIssue, result };
	});

	if (jsonMode) {
		return {
			stdout: jsonText(
				{ status: result.status, steps: result.steps, error: result.error, root_id: rootIssue.id },
				true,
			),
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
			const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootIssue.id;
			const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
			io?.stderr?.write(
				[
					"",
					"Recovery:",
					`  mu replay ${rootIssue.id}/${replayId}`,
					`  logs: ${logsRel}/${rootIssue.id}/${replayId}*.jsonl`,
					`  resume: mu resume ${rootIssue.id} --max-steps ${maxSteps}`,
					"",
				].join("\n"),
			);
		}
		return { stdout: "", stderr: "", exitCode };
	}

	let out = `Root: ${rootIssue.id} ${String(rootIssue.title ?? "").slice(0, 80)}\n`;
	out += `Runner status: ${result.status}\n`;
	if (result.error) {
		out += `Error: ${result.error}\n`;
	}
	if (exitCode !== 0) {
		const replayId = lastBackendIssueId ?? lastStepIssueId ?? rootIssue.id;
		const logsRel = relative(ctx.repoRoot, ctx.paths.logsDir).replaceAll("\\", "/");
		out += "\nRecovery:\n";
		out += `  mu replay ${rootIssue.id}/${replayId}\n`;
		out += `  logs: ${logsRel}/${rootIssue.id}/${replayId}*.jsonl\n`;
		out += `  resume: mu resume ${rootIssue.id} --max-steps ${maxSteps}\n`;
	}
	return { stdout: out, stderr: "", exitCode };
}
