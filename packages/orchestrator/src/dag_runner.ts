import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { type BackendRunner, type MuRole, SdkBackend, roleFromTags, systemPromptForRole } from "@femtomc/mu-agent";
import type { Issue, ValidationResult } from "@femtomc/mu-core";
import {
	currentRunId,
	type EventLog,
	fsEventLogFromRepoRoot,
	getStorePaths,
	newRunId,
	runContext,
} from "@femtomc/mu-core/node";
import type { ForumStore } from "@femtomc/mu-forum";
import type { IssueStore } from "@femtomc/mu-issue";
import type { ModelOverrides, ResolvedModelConfig } from "./model_resolution.js";
import { resolveModelConfig } from "./model_resolution.js";

export type DagResult = {
	status: "root_final" | "no_executable_leaf" | "max_steps_exhausted" | "error";
	steps: number;
	error: string;
};

export type DagRunnerStepStartEvent = {
	rootId: string;
	step: number;
	issueId: string;
	role: string | null;
	title: string;
};

export type DagRunnerStepEndEvent = {
	rootId: string;
	step: number;
	issueId: string;
	exitCode: number;
	elapsedS: number;
	outcome: string | null;
};

export type DagRunnerBackendLineEvent = {
	rootId: string;
	step: number;
	issueId: string;
	logSuffix: string;
	line: string;
};

export type DagRunnerHooks = {
	onStepStart?: (ev: DagRunnerStepStartEvent) => void | Promise<void>;
	onStepEnd?: (ev: DagRunnerStepEndEvent) => void | Promise<void>;
	onBackendLine?: (ev: DagRunnerBackendLineEvent) => void;
};

export type DagRunnerRunOpts = {
	hooks?: DagRunnerHooks;
};

type ResolvedConfig = ResolvedModelConfig;

type AgentSelfMetadata = {
	model?: string | null;
	thinkingLevel?: string | null;
};

function roundTo(n: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

function relPath(repoRoot: string, path: string): string {
	try {
		const rel = relative(repoRoot, path);
		return rel || path;
	} catch {
		return path;
	}
}

function normalizeSelfMetadataValue(value: string | null | undefined): string {
	if (typeof value !== "string") {
		return "unknown";
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : "unknown";
}

export function renderAgentSelfMetadata(meta: AgentSelfMetadata): string {
	const model = normalizeSelfMetadataValue(meta.model);
	const thinkingLevel = normalizeSelfMetadataValue(meta.thinkingLevel);
	return `Model: ${model}\nThinking level: ${thinkingLevel}\n`;
}

export class DagRunner {
	readonly #store: IssueStore;
	readonly #forum: ForumStore;
	readonly #repoRoot: string;
	readonly #events: EventLog;
	readonly #backend: BackendRunner;
	readonly #modelOverrides: ModelOverrides;

	readonly #reorchestrateOutcomes = new Set(["failure", "needs_work"]);
	readonly #attempts = new Map<string, number>();

	public constructor(
		store: IssueStore,
		forum: ForumStore,
		repoRoot: string,
		opts: { backend?: BackendRunner; events?: EventLog; modelOverrides?: ModelOverrides } = {},
	) {
		this.#store = store;
		this.#forum = forum;
		this.#repoRoot = repoRoot;
		this.#events = opts.events ?? fsEventLogFromRepoRoot(repoRoot);
		this.#backend = opts.backend ?? new SdkBackend();
		this.#modelOverrides = opts.modelOverrides ?? {};
	}

	async #resolveConfig(): Promise<ResolvedConfig> {
		return resolveModelConfig(this.#modelOverrides);
	}

	async #renderUserPrompt(
		issue: Pick<Issue, "id" | "title" | "body">,
		rootId: string,
		step: number,
		attempt: number = 1,
		selfMetadata: AgentSelfMetadata = {},
	) {
		let rendered = issue.title ?? "";
		if (issue.body) {
			rendered += `\n\n${issue.body}`;
		}

		const runId = currentRunId();
		rendered += `\n\n## Mu Run Context\nRoot: ${rootId}\nAssigned issue: ${issue.id}\nStep: ${step}\n`;
		if (runId) {
			rendered += `Run: ${runId}\n`;
		}
		rendered += renderAgentSelfMetadata(selfMetadata);
		if (attempt > 1) {
			rendered += `\nAttempt: ${attempt} (previous attempt failed — check \`mu forum read issue:${issue.id}\` for context)\n`;
		}
		return rendered;
	}

	async #executeBackend(
		issue: Pick<Issue, "id" | "title" | "body" | "tags">,
		cfg: ResolvedConfig,
		rootId: string,
		step: number,
		opts: { logSuffix?: string; attempt?: number; onLine?: (line: string) => void } = {},
	): Promise<{ exitCode: number; elapsedS: number }> {
		const role: MuRole = roleFromTags(issue.tags);
		const logSuffix = opts.logSuffix ?? "";
		const rendered = await this.#renderUserPrompt(issue, rootId, step, opts.attempt ?? 1, {
			model: cfg.model,
			thinkingLevel: cfg.reasoning,
		});
		const systemPrompt = await systemPromptForRole(role, this.#repoRoot);

		const { logsDir } = getStorePaths(this.#repoRoot);
		const rootLogsDir = join(logsDir, rootId);
		await mkdir(rootLogsDir, { recursive: true });

		const suffix = logSuffix ? `.${logSuffix}` : "";
		const teePath = join(rootLogsDir, `${issue.id}${suffix}.jsonl`);

		await this.#events.emit("backend.run.start", {
			source: "backend",
			issueId: issue.id,
			payload: {
				role,
				provider: cfg.provider,
				model: cfg.model,
				reasoning: cfg.reasoning,
				tee_path: relPath(this.#repoRoot, teePath),
				log_suffix: logSuffix,
			},
		});

		const t0 = Date.now();
		const exitCode = await this.#backend.run({
			issueId: issue.id,
			role,
			systemPrompt,
			prompt: rendered,
			provider: cfg.provider,
			model: cfg.model,
			thinking: cfg.reasoning,
			cwd: this.#repoRoot,
			logSuffix,
			teePath,
			onLine: opts.onLine,
		});
		const elapsedS = (Date.now() - t0) / 1000;

		await this.#events.emit("backend.run.end", {
			source: "backend",
			issueId: issue.id,
			payload: {
				exit_code: exitCode,
				elapsed_s: roundTo(elapsedS, 3),
				tee_path: relPath(this.#repoRoot, teePath),
				log_suffix: logSuffix,
			},
		});

		return { exitCode, elapsedS };
	}

	async #reopenForOrchestration(issueId: string, opts: { reason: string; step: number }): Promise<void> {
		const before = await this.#store.get(issueId);
		if (!before) {
			return;
		}

		const reopened = await this.#store.update(issueId, {
			status: "open",
			outcome: null,
			tags: [...before.tags.filter((t) => !t.startsWith("role:")), "role:orchestrator"],
		});
		await this.#events.emit("dag.unstick.reopen", {
			source: "dag_runner",
			issueId,
			payload: { reason: opts.reason, step: opts.step },
		});

		await this.#forum.post(
			`issue:${issueId}`,
			JSON.stringify({
				step: opts.step,
				issue_id: issueId,
				title: reopened.title ?? "",
				type: "reorchestrate",
				reason: opts.reason,
			}),
			"orchestrator",
		);
	}

	async #maybeUnstick(rootId: string, step: number): Promise<boolean> {
		const idsInScope = new Set(await this.#store.subtree_ids(rootId));
		const rows = await this.#store.list();

		// Build children mapping once.
		const childrenOf = new Map<string, Issue[]>();
		for (const row of rows) {
			for (const dep of row.deps ?? []) {
				if (dep.type !== "parent") continue;
				const list = childrenOf.get(dep.target) ?? [];
				list.push(row);
				childrenOf.set(dep.target, list);
			}
		}

		const hasOpenChildren = (issueId: string): boolean =>
			(childrenOf.get(issueId) ?? []).some((child) => child.status !== "closed");

		const candidates: Issue[] = [];
		for (const row of rows) {
			if (!idsInScope.has(row.id)) continue;
			if (row.status !== "closed") continue;
			// Circuit breaker: skip issues that have exhausted their attempts.
			if ((this.#attempts.get(row.id) ?? 0) >= 3) continue;

			const outcome = row.outcome;
			if (outcome && this.#reorchestrateOutcomes.has(outcome)) {
				if (hasOpenChildren(row.id)) continue;
				candidates.push(row);
				continue;
			}

			if (outcome === "expanded" && (childrenOf.get(row.id)?.length ?? 0) === 0) {
				candidates.push(row);
			}
		}

		if (candidates.length === 0) {
			return false;
		}

		candidates.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
		const target = candidates[0]!;
		await this.#reopenForOrchestration(target.id, { reason: `was outcome=${target.outcome}`, step });
		return true;
	}

	async run(rootId: string, maxSteps: number = 20, opts: DagRunnerRunOpts = {}): Promise<DagResult> {
		const hooks = opts.hooks;
		const runId = currentRunId() ?? newRunId();

		return await runContext({ runId }, async () => {
			await this.#events.emit("dag.run.start", {
				source: "dag_runner",
				issueId: rootId,
				payload: { root_id: rootId, max_steps: maxSteps },
			});

			let final: DagResult | null = null;
			try {
				for (let i = 0; i < maxSteps; i++) {
					const step = i + 1;

					// 0. Unstick: failures / needs_work trigger re-orchestration.
					await this.#maybeUnstick(rootId, step);

					// 2. Check termination.
					const v: ValidationResult = await this.#store.validate(rootId);
					if (v.is_final) {
						final = { status: "root_final", steps: i, error: "" };
						return final;
					}

					// 3. Select next ready leaf.
					const candidates = await this.#store.ready(rootId, { tags: ["node:agent"] });
					if (candidates.length === 0) {
						// Repair pass on the root to resolve deadlocks / bad expansions.
						await this.#events.emit("dag.unstick.start", {
							source: "dag_runner",
							issueId: rootId,
							payload: { root_id: rootId, step },
						});

						const rootIssue = await this.#store.get(rootId);
						if (!rootIssue) {
							final = { status: "error", steps: i, error: "root vanished" };
							return final;
						}

						const idsInScope = new Set(await this.#store.subtree_ids(rootId));
						const openIssues = (await this.#store.list({ status: "open" })).filter((r) => idsInScope.has(r.id));

						const diag =
							`- open_issues: ${openIssues.length}\n` +
							`- action: diagnose deadlocks or missing expansions and create executable leaf work\n` +
							`- hint: run \`mu issues ready --root ${rootId}\` and \`mu issues list --root ${rootId}\`\n`;

						const repairIssue: Issue = {
							...rootIssue,
							title: `Repair stuck DAG: ${rootIssue.title}`,
							body: `${(rootIssue.body || "").trim()}\n\n## Runner Diagnostics\n\n${diag}`.trim(),
						};

						const cfg = await this.#resolveConfig();
						const logSuffix = "unstick";
						const onBackendLine = hooks?.onBackendLine;
						const { exitCode, elapsedS } = await this.#executeBackend(repairIssue, cfg, rootId, step, {
							logSuffix,
							onLine: onBackendLine
								? (line) => onBackendLine({ rootId, step, issueId: rootId, logSuffix, line })
								: undefined,
						});

						await this.#forum.post(
							`issue:${rootId}`,
							JSON.stringify({
								step,
								issue_id: rootId,
								title: rootIssue.title ?? "",
								exit_code: exitCode,
								elapsed_s: roundTo(elapsedS, 1),
								type: "unstick",
							}),
							"orchestrator",
						);

						await this.#events.emit("dag.unstick.end", {
							source: "dag_runner",
							issueId: rootId,
							payload: { root_id: rootId, step, exit_code: exitCode, elapsed_s: roundTo(elapsedS, 3) },
						});

						continue;
					}

					const issue = candidates[0]!;
					const issueId = issue.id;
					const role = roleFromTags(issue.tags);

					await this.#events.emit("dag.step.start", {
						source: "dag_runner",
						issueId,
						payload: { root_id: rootId, step, title: issue.title ?? "" },
					});

					if (hooks?.onStepStart) {
						await hooks.onStepStart({ rootId, step, issueId, role, title: issue.title ?? "" });
					}

					// 3. Claim.
					await this.#events.emit("dag.claim", {
						source: "dag_runner",
						issueId,
						payload: { root_id: rootId, step },
					});
					await this.#store.claim(issueId);

					// Track attempt count for circuit breaker.
					const attempt = (this.#attempts.get(issueId) ?? 0) + 1;
					this.#attempts.set(issueId, attempt);

					// 4. Route + 5. Render + 6. Execute.
					const cfg = await this.#resolveConfig();
					const logSuffix = attempt > 1 ? `attempt-${attempt}` : "";
					const onBackendLine = hooks?.onBackendLine;
					const { exitCode, elapsedS } = await this.#executeBackend(issue, cfg, rootId, step, {
						logSuffix,
						attempt,
						onLine: onBackendLine
							? (line) => onBackendLine({ rootId, step, issueId, logSuffix, line })
							: undefined,
					});

					// 7. Check postconditions.
					let updated = await this.#store.get(issueId);
					if (!updated) {
						final = { status: "error", steps: step, error: "issue vanished" };
						return final;
					}

					if (updated.status !== "closed") {
						await this.#events.emit("dag.step.force_close", {
							source: "dag_runner",
							issueId,
							payload: { root_id: rootId, step, role, attempt, reason: "agent_did_not_close" },
						});
						updated = await this.#store.close(issueId, "failure");
					}

					// 8. Log to forum.
					await this.#forum.post(
						`issue:${issueId}`,
						JSON.stringify({
							step,
							issue_id: issueId,
							title: issue.title,
							exit_code: exitCode,
							outcome: updated.outcome,
							elapsed_s: roundTo(elapsedS, 1),
						}),
						"orchestrator",
					);

					if (hooks?.onStepEnd) {
						await hooks.onStepEnd({
							rootId,
							step,
							issueId,
							exitCode,
							elapsedS: roundTo(elapsedS, 3),
							outcome: updated.outcome ?? null,
						});
					}

					await this.#events.emit("dag.step.end", {
						source: "dag_runner",
						issueId,
						payload: {
							root_id: rootId,
							step,
							exit_code: exitCode,
							elapsed_s: roundTo(elapsedS, 3),
							outcome: updated.outcome,
						},
					});

					// 9. Re-orchestrate on failure / needs_work (circuit breaker: max 3 attempts).
					if (updated.outcome && this.#reorchestrateOutcomes.has(updated.outcome)) {
						if (attempt < 3) {
							await this.#reopenForOrchestration(issueId, { reason: `outcome=${updated.outcome}`, step });
						} else {
							await this.#events.emit("dag.circuit_breaker", {
								source: "dag_runner",
								issueId,
								payload: { root_id: rootId, step, attempt, outcome: updated.outcome },
							});
						}
					}
				}

				final = { status: "max_steps_exhausted", steps: maxSteps, error: "" };
				return final;
			} catch (err) {
				final = { status: "error", steps: 0, error: err instanceof Error ? err.message : String(err) };
				return final;
			} finally {
				if (final) {
					await this.#events.emit("dag.run.end", {
						source: "dag_runner",
						issueId: rootId,
						payload: { root_id: rootId, status: final.status, steps: final.steps, error: final.error },
					});
				}
			}
		});
	}
}
