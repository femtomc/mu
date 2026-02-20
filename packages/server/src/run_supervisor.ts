import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CommandRecord } from "@femtomc/mu-control-plane";

export type ControlPlaneRunMode = "run_start" | "run_resume";
export type ControlPlaneRunStatus = "running" | "completed" | "failed" | "cancelled";

export type ControlPlaneRunSnapshot = {
	job_id: string;
	mode: ControlPlaneRunMode;
	status: ControlPlaneRunStatus;
	prompt: string | null;
	root_issue_id: string | null;
	max_steps: number;
	command_id: string | null;
	source: "command" | "api";
	started_at_ms: number;
	updated_at_ms: number;
	finished_at_ms: number | null;
	exit_code: number | null;
	pid: number | null;
	last_progress: string | null;
	queue_id?: string;
	queue_state?: "queued" | "active" | "waiting_review" | "refining" | "done" | "failed" | "cancelled";
};

export type ControlPlaneRunTrace = {
	run: ControlPlaneRunSnapshot;
	stdout: string[];
	stderr: string[];
	log_hints: string[];
	trace_files: string[];
};

export type ControlPlaneRunInterruptResult = {
	ok: boolean;
	reason: "not_found" | "not_running" | "missing_target" | null;
	run: ControlPlaneRunSnapshot | null;
};

export type ControlPlaneRunEventKind =
	| "run_started"
	| "run_root_discovered"
	| "run_progress"
	| "run_interrupt_requested"
	| "run_completed"
	| "run_failed"
	| "run_cancelled";

export type ControlPlaneRunEvent = {
	seq: number;
	ts_ms: number;
	kind: ControlPlaneRunEventKind;
	message: string;
	run: ControlPlaneRunSnapshot;
	command: CommandRecord | null;
};

export type ControlPlaneRunProcess = {
	pid: number;
	stdout: ReadableStream<Uint8Array> | null;
	stderr: ReadableStream<Uint8Array> | null;
	exited: Promise<number>;
	kill(signal?: number | string): void;
};

export type ControlPlaneRunSupervisorOpts = {
	repoRoot: string;
	nowMs?: () => number;
	spawnProcess?: (opts: { argv: string[]; cwd: string }) => ControlPlaneRunProcess;
	maxStoredLines?: number;
	maxHistory?: number;
	onEvent?: (event: ControlPlaneRunEvent) => void | Promise<void>;
};

type InternalRunJob = {
	snapshot: ControlPlaneRunSnapshot;
	command: CommandRecord | null;
	process: ControlPlaneRunProcess;
	stdout_lines: string[];
	stderr_lines: string[];
	log_hints: Set<string>;
	interrupt_requested: boolean;
	hard_kill_timer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_MAX_STEPS = 20;
const ROOT_RE = /\bRoot:\s*(mu-[a-z0-9][a-z0-9-]*)\b/i;
const STEP_RE = /^(Step|Done)\s+\d+\/\d+\s+/;
const LOG_HINT_RE = /\blogs:\s+(\S+)/i;

function defaultNowMs(): number {
	return Date.now();
}

function defaultSpawnProcess(opts: { argv: string[]; cwd: string }): ControlPlaneRunProcess {
	const proc = Bun.spawn({
		cmd: opts.argv,
		cwd: opts.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: Bun.env,
	});
	return {
		pid: proc.pid,
		stdout: proc.stdout,
		stderr: proc.stderr,
		exited: proc.exited,
		kill(signal?: number | string): void {
			proc.kill(signal as never);
		},
	};
}

function toPositiveInt(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(1, Math.trunc(value));
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Math.max(1, Number.parseInt(value, 10));
	}
	return fallback;
}

function normalizeIssueId(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!/^mu-[a-z0-9][a-z0-9-]*$/i.test(trimmed)) {
		return null;
	}
	return trimmed.toLowerCase();
}

function pushBounded(lines: string[], line: string, maxLines: number): void {
	lines.push(line);
	if (lines.length <= maxLines) {
		return;
	}
	lines.splice(0, lines.length - maxLines);
}

async function consumeStreamLines(
	stream: ReadableStream<Uint8Array> | null,
	onLine: (line: string) => void,
): Promise<void> {
	if (!stream) {
		return;
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			pending += decoder.decode(value, { stream: true });
			while (true) {
				const newline = pending.indexOf("\n");
				if (newline < 0) {
					break;
				}
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				onLine(line);
			}
		}
		pending += decoder.decode();
		const finalLine = pending.replace(/\r$/, "").trimEnd();
		if (finalLine.length > 0) {
			onLine(finalLine);
		}
	} finally {
		reader.releaseLock();
	}
}

function describeRun(snapshot: ControlPlaneRunSnapshot): string {
	const root = snapshot.root_issue_id ?? snapshot.job_id;
	return `${snapshot.mode} ${root}`;
}

/**
 * Process execution boundary for orchestration runs.
 *
 * Contract with the durable queue/reconcile layer:
 * - this supervisor executes already-selected work; it does not decide inter-root scheduling policy
 * - sequential/parallel root policy is enforced by queue leasing before launch
 * - queue-first launch is the supported execution path
 */
export class ControlPlaneRunSupervisor {
	readonly #repoRoot: string;
	readonly #nowMs: () => number;
	readonly #spawnProcess: (opts: { argv: string[]; cwd: string }) => ControlPlaneRunProcess;
	readonly #maxStoredLines: number;
	readonly #maxHistory: number;
	readonly #onEvent: ((event: ControlPlaneRunEvent) => void | Promise<void>) | null;
	readonly #jobsById = new Map<string, InternalRunJob>();
	readonly #jobIdByRootIssueId = new Map<string, string>();
	#seq = 0;
	#jobCounter = 0;

	public constructor(opts: ControlPlaneRunSupervisorOpts) {
		this.#repoRoot = opts.repoRoot;
		this.#nowMs = opts.nowMs ?? defaultNowMs;
		this.#spawnProcess = opts.spawnProcess ?? defaultSpawnProcess;
		this.#maxStoredLines = Math.max(50, Math.trunc(opts.maxStoredLines ?? 1_000));
		this.#maxHistory = Math.max(20, Math.trunc(opts.maxHistory ?? 200));
		this.#onEvent = opts.onEvent ?? null;
	}

	#nextJobId(): string {
		this.#jobCounter += 1;
		return `run-job-${this.#jobCounter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
	}

	#snapshot(job: InternalRunJob): ControlPlaneRunSnapshot {
		return { ...job.snapshot };
	}

	#allJobsSorted(): InternalRunJob[] {
		return [...this.#jobsById.values()].sort((a, b) => {
			if (a.snapshot.started_at_ms !== b.snapshot.started_at_ms) {
				return b.snapshot.started_at_ms - a.snapshot.started_at_ms;
			}
			return a.snapshot.job_id.localeCompare(b.snapshot.job_id);
		});
	}

	#pruneHistory(): void {
		const jobs = this.#allJobsSorted();
		let kept = 0;
		for (const job of jobs) {
			if (job.snapshot.status === "running") {
				kept += 1;
				continue;
			}
			kept += 1;
			if (kept <= this.#maxHistory) {
				continue;
			}
			this.#jobsById.delete(job.snapshot.job_id);
			if (job.snapshot.root_issue_id) {
				const current = this.#jobIdByRootIssueId.get(job.snapshot.root_issue_id);
				if (current === job.snapshot.job_id) {
					this.#jobIdByRootIssueId.delete(job.snapshot.root_issue_id);
				}
			}
		}
	}

	#emit(kind: ControlPlaneRunEventKind, job: InternalRunJob, message: string): void {
		if (!this.#onEvent) {
			return;
		}
		const event: ControlPlaneRunEvent = {
			seq: ++this.#seq,
			ts_ms: Math.trunc(this.#nowMs()),
			kind,
			message,
			run: this.#snapshot(job),
			command: job.command,
		};
		void Promise.resolve(this.#onEvent(event)).catch(() => {
			// Swallow notifier errors to avoid destabilizing run supervision.
		});
	}

	#touch(job: InternalRunJob): void {
		job.snapshot.updated_at_ms = Math.trunc(this.#nowMs());
	}

	#markRootIssueId(job: InternalRunJob, rootIssueId: string): void {
		const normalized = normalizeIssueId(rootIssueId);
		if (!normalized) {
			return;
		}
		if (job.snapshot.root_issue_id === normalized) {
			return;
		}
		job.snapshot.root_issue_id = normalized;
		this.#jobIdByRootIssueId.set(normalized, job.snapshot.job_id);
		this.#touch(job);
		this.#emit("run_root_discovered", job, `🧩 Run root identified: ${normalized}`);
	}

	#handleLine(job: InternalRunJob, stream: "stdout" | "stderr", line: string): void {
		if (stream === "stdout") {
			pushBounded(job.stdout_lines, line, this.#maxStoredLines);
		} else {
			pushBounded(job.stderr_lines, line, this.#maxStoredLines);
		}

		const rootMatch = ROOT_RE.exec(line);
		if (rootMatch?.[1]) {
			this.#markRootIssueId(job, rootMatch[1]);
		}

		const logHintMatch = LOG_HINT_RE.exec(line);
		if (logHintMatch?.[1]) {
			job.log_hints.add(logHintMatch[1]);
			this.#touch(job);
		}

		if (STEP_RE.test(line)) {
			job.snapshot.last_progress = line.trim();
			this.#touch(job);
			this.#emit("run_progress", job, `📈 ${line.trim()}`);
		}
	}

	/**
	 * Executes one queue-activated run job.
	 *
	 * Queue contract expectation: caller has already persisted/activated the queue item and associated
	 * this launch with exactly one root slot under the active inter-root policy.
	 */
	async #launch(opts: {
		mode: ControlPlaneRunMode;
		prompt: string | null;
		rootIssueId: string | null;
		maxSteps: number;
		argv: string[];
		command: CommandRecord | null;
		commandId?: string | null;
		source: "command" | "api";
	}): Promise<ControlPlaneRunSnapshot> {
		const nowMs = Math.trunc(this.#nowMs());
		const process = this.#spawnProcess({ argv: opts.argv, cwd: this.#repoRoot });
		const snapshot: ControlPlaneRunSnapshot = {
			job_id: this.#nextJobId(),
			mode: opts.mode,
			status: "running",
			prompt: opts.prompt,
			root_issue_id: opts.rootIssueId,
			max_steps: opts.maxSteps,
			command_id: opts.command?.command_id ?? opts.commandId ?? null,
			source: opts.source,
			started_at_ms: nowMs,
			updated_at_ms: nowMs,
			finished_at_ms: null,
			exit_code: null,
			pid: process.pid,
			last_progress: null,
		};

		const job: InternalRunJob = {
			snapshot,
			command: opts.command,
			process,
			stdout_lines: [],
			stderr_lines: [],
			log_hints: new Set<string>(),
			interrupt_requested: false,
			hard_kill_timer: null,
		};

		this.#jobsById.set(snapshot.job_id, job);
		if (snapshot.root_issue_id) {
			this.#jobIdByRootIssueId.set(snapshot.root_issue_id, snapshot.job_id);
		}

		this.#emit(
			"run_started",
			job,
			`🚀 Started ${describeRun(snapshot)} (job ${snapshot.job_id}, pid ${snapshot.pid ?? "?"})`,
		);

		void (async () => {
			const stdoutTask = consumeStreamLines(process.stdout, (line) => this.#handleLine(job, "stdout", line));
			const stderrTask = consumeStreamLines(process.stderr, (line) => this.#handleLine(job, "stderr", line));
			const exitCode = await process.exited.catch(() => -1);
			await Promise.allSettled([stdoutTask, stderrTask]);

			if (job.hard_kill_timer) {
				clearTimeout(job.hard_kill_timer);
				job.hard_kill_timer = null;
			}

			job.snapshot.exit_code = exitCode;
			job.snapshot.finished_at_ms = Math.trunc(this.#nowMs());
			job.snapshot.updated_at_ms = job.snapshot.finished_at_ms;

			if (job.interrupt_requested) {
				job.snapshot.status = "cancelled";
				this.#emit("run_cancelled", job, `🛑 ${describeRun(job.snapshot)} interrupted (exit ${exitCode}).`);
			} else if (exitCode === 0) {
				job.snapshot.status = "completed";
				this.#emit("run_completed", job, `✅ ${describeRun(job.snapshot)} completed successfully.`);
			} else {
				job.snapshot.status = "failed";
				this.#emit("run_failed", job, `❌ ${describeRun(job.snapshot)} failed (exit ${exitCode}).`);
			}

			this.#pruneHistory();
		})();

		return this.#snapshot(job);
	}

	/**
	 * Compatibility adapter entrypoint for run-start intent.
	 * Default architecture should enqueue first, then call this after lease acquisition.
	 */
	public async launchStart(opts: {
		prompt: string;
		maxSteps?: number;
		command?: CommandRecord | null;
		commandId?: string | null;
		source?: "command" | "api";
	}): Promise<ControlPlaneRunSnapshot> {
		const prompt = opts.prompt.trim();
		if (prompt.length === 0) {
			throw new Error("run_start_prompt_required");
		}
		const maxSteps = toPositiveInt(opts.maxSteps, DEFAULT_MAX_STEPS);
		const argv = ["mu", "_run-direct", prompt, "--max-steps", String(maxSteps), "--raw-stream"];
		return await this.#launch({
			mode: "run_start",
			prompt,
			rootIssueId: null,
			maxSteps,
			argv,
			command: opts.command ?? null,
			commandId: opts.commandId ?? null,
			source: opts.source ?? "api",
		});
	}

	/**
	 * Compatibility adapter entrypoint for run-resume intent.
	 * No feature-flag branch: queue-first reconcile remains the canonical path.
	 */
	public async launchResume(opts: {
		rootIssueId: string;
		maxSteps?: number;
		command?: CommandRecord | null;
		commandId?: string | null;
		source?: "command" | "api";
	}): Promise<ControlPlaneRunSnapshot> {
		const rootIssueId = normalizeIssueId(opts.rootIssueId);
		if (!rootIssueId) {
			throw new Error("run_resume_invalid_root_issue_id");
		}
		const maxSteps = toPositiveInt(opts.maxSteps, DEFAULT_MAX_STEPS);
		const argv = ["mu", "resume", rootIssueId, "--max-steps", String(maxSteps), "--raw-stream"];
		return await this.#launch({
			mode: "run_resume",
			prompt: null,
			rootIssueId,
			maxSteps,
			argv,
			command: opts.command ?? null,
			commandId: opts.commandId ?? null,
			source: opts.source ?? "api",
		});
	}

	public list(opts: { status?: ControlPlaneRunStatus; limit?: number } = {}): ControlPlaneRunSnapshot[] {
		const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
		const filtered = this.#allJobsSorted().filter((job) =>
			opts.status ? job.snapshot.status === opts.status : true,
		);
		return filtered.slice(0, limit).map((job) => this.#snapshot(job));
	}

	#resolveJob(idOrRoot: string): InternalRunJob | null {
		const trimmed = idOrRoot.trim();
		if (trimmed.length === 0) {
			return null;
		}
		const byId = this.#jobsById.get(trimmed);
		if (byId) {
			return byId;
		}
		const root = normalizeIssueId(trimmed);
		if (!root) {
			return null;
		}
		const jobId = this.#jobIdByRootIssueId.get(root);
		if (!jobId) {
			return null;
		}
		return this.#jobsById.get(jobId) ?? null;
	}

	public get(idOrRoot: string): ControlPlaneRunSnapshot | null {
		const job = this.#resolveJob(idOrRoot);
		return job ? this.#snapshot(job) : null;
	}

	public async trace(idOrRoot: string, opts: { limit?: number } = {}): Promise<ControlPlaneRunTrace | null> {
		const job = this.#resolveJob(idOrRoot);
		if (!job) {
			return null;
		}
		const limit = Math.max(1, Math.min(2_000, Math.trunc(opts.limit ?? 200)));
		const rootIssueId = job.snapshot.root_issue_id;
		const traceFiles: string[] = [];
		if (rootIssueId) {
			const rootLogsDir = join(this.#repoRoot, ".mu", "logs", rootIssueId);
			try {
				const entries = await readdir(rootLogsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isFile()) continue;
					if (!entry.name.endsWith(".jsonl")) continue;
					traceFiles.push(relative(this.#repoRoot, join(rootLogsDir, entry.name)).replaceAll("\\", "/"));
				}
			} catch {
				// best effort only
			}
		}

		return {
			run: this.#snapshot(job),
			stdout: job.stdout_lines.slice(-limit),
			stderr: job.stderr_lines.slice(-limit),
			log_hints: [...job.log_hints],
			trace_files: traceFiles.sort((a, b) => a.localeCompare(b)),
		};
	}

	public interrupt(opts: { jobId?: string | null; rootIssueId?: string | null }): ControlPlaneRunInterruptResult {
		const target = opts.jobId?.trim() || opts.rootIssueId?.trim() || "";
		if (target.length === 0) {
			return { ok: false, reason: "missing_target", run: null };
		}
		const job = this.#resolveJob(target);
		if (!job) {
			return { ok: false, reason: "not_found", run: null };
		}
		if (job.snapshot.status !== "running") {
			return { ok: false, reason: "not_running", run: this.#snapshot(job) };
		}
		job.interrupt_requested = true;
		this.#touch(job);
		try {
			job.process.kill("SIGINT");
		} catch {
			// best effort
		}
		job.hard_kill_timer = setTimeout(() => {
			if (job.snapshot.status !== "running") {
				return;
			}
			try {
				job.process.kill("SIGKILL");
			} catch {
				// best effort
			}
		}, 5_000);
		const root = job.snapshot.root_issue_id ?? job.snapshot.job_id;
		this.#emit("run_interrupt_requested", job, `⚠️ Interrupt requested for ${root}.`);
		return { ok: true, reason: null, run: this.#snapshot(job) };
	}

	public async startFromCommand(command: CommandRecord): Promise<ControlPlaneRunSnapshot | null> {
		switch (command.target_type) {
			case "run start": {
				const prompt = command.command_args.join(" ").trim();
				if (prompt.length === 0) {
					throw new Error("run_start_prompt_required");
				}
				return await this.launchStart({ prompt, command, source: "command" });
			}
			case "run resume": {
				const fallbackRoot = normalizeIssueId(command.target_id);
				const explicitRoot = normalizeIssueId(command.command_args[0] ?? "") ?? fallbackRoot;
				if (!explicitRoot) {
					throw new Error("run_resume_invalid_root_issue_id");
				}
				const maxSteps = toPositiveInt(command.command_args[1], DEFAULT_MAX_STEPS);
				return await this.launchResume({
					rootIssueId: explicitRoot,
					maxSteps,
					command,
					source: "command",
				});
			}
			default:
				return null;
		}
	}

	public async stop(): Promise<void> {
		for (const job of this.#jobsById.values()) {
			if (job.hard_kill_timer) {
				clearTimeout(job.hard_kill_timer);
				job.hard_kill_timer = null;
			}
			if (job.snapshot.status === "running") {
				try {
					job.process.kill("SIGTERM");
				} catch {
					// best effort
				}
			}
		}
	}
}
