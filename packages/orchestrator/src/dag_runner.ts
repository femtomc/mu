import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { type BackendRunner, type MuRole, SdkBackend, roleFromTags, systemPromptForRole } from "@femtomc/mu-agent";
import type { Issue } from "@femtomc/mu-core";
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
import { reconcileDagTurn, type DagRootPhase, withRootPhaseTag } from "./dag_reconcile.js";
import type { ModelOverrides, ResolvedModelConfig } from "./model_resolution.js";
import { resolveModelConfig } from "./model_resolution.js";

/**
 * Orchestration reconcile contract for `DagRunner`.
 *
 * Reconcile behavior is always on (no feature-flag fork) and must preserve
 * the durable state transitions and emitted events defined below.
 */
export type DagRunnerReconcilePhase =
	| "turn_start"
	| "unstick_retryable"
	| "validate_root"
	| "select_leaf"
	| "dispatch_issue"
	| "repair_deadlock"
	| "postcondition_reconcile"
	| "requeue_retryable"
	| "turn_end";

/** Review/refinement control loop that reconcile implementations must honor. */
export type DagRunnerReviewLoopPhase = "plan" | "execute" | "review" | "accept" | "refine";

/**
 * Enumerated invariants (kept implementation-facing so tests can assert these explicitly).
 */
export const DAG_RUNNER_CONTRACT_INVARIANTS = [
	"ORCH-RECON-001: Reconcile is default-on and must not branch behind rollout flags.",
	"ORCH-RECON-002: At most one issue is claimed+dispatched per reconcile step for a root.",
	"ORCH-RECON-003: A dispatched issue must end closed; otherwise the runner force-closes with outcome=failure.",
	"ORCH-RECON-004: failure/needs_work outcomes may be retried only up to the per-issue attempt budget (currently 3).",
	"ORCH-RECON-005: Root finality check (`validate(root).is_final`) runs before dispatch each step.",
	"ORCH-RECON-006: Review loop semantics are plan -> execute -> review -> (accept | refine).",
	"ORCH-RECON-007: Refine loops are budgeted (default max_refine_rounds_per_root=3); exhaustion is terminal.",
	"ORCH-RECON-008: Integrations must preserve this state machine and emitted events.",
] as const;

/** Default refine-loop budget for upcoming reviewer integration modules. */
export const DEFAULT_MAX_REFINE_ROUNDS_PER_ROOT = 3;

/**
 * Reviewer semantics contract:
 * - accept => review step closes with `success`; root can move to terminal validation
 * - refine => review step closes with `needs_work` or `refine`, then orchestrator schedules follow-up work
 */
export const REVIEW_DECISION_TO_OUTCOME = {
	accept: "success",
	refine: "refine",
} as const;

export const DAG_RUNNER_BUDGET_INVARIANTS = [
	"ORCH-BUDGET-001: max_steps is a hard upper bound on reconcile turns per run invocation.",
	"ORCH-BUDGET-002: per-issue re-orchestration attempts are capped at 3.",
	"ORCH-BUDGET-003: reviewer refine rounds are capped per root (default 3).",
] as const;

const MAX_REORCHESTRATION_ATTEMPTS = 3;
const REVIEWER_ROLE_TAG = "role:reviewer";
const ORCHESTRATOR_ROLE_TAG = "role:orchestrator";
const REVIEWER_ACCEPT_OUTCOMES = new Set(["accept", "success"]);
const REVIEWER_REFINE_OUTCOMES = new Set(["failure", "needs_work", "refine"]);

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

function normalizeOutcome(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
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
	readonly #maxRefineRoundsPerRoot: number;

	readonly #reorchestrateOutcomes = new Set(["failure", "needs_work"]);
	readonly #attempts = new Map<string, number>();

	public constructor(
		store: IssueStore,
		forum: ForumStore,
		repoRoot: string,
		opts: {
			backend?: BackendRunner;
			events?: EventLog;
			modelOverrides?: ModelOverrides;
			maxRefineRoundsPerRoot?: number;
		} = {},
	) {
		this.#store = store;
		this.#forum = forum;
		this.#repoRoot = repoRoot;
		this.#events = opts.events ?? fsEventLogFromRepoRoot(repoRoot);
		this.#backend = opts.backend ?? new SdkBackend();
		this.#modelOverrides = opts.modelOverrides ?? {};
		this.#maxRefineRoundsPerRoot = Math.max(1, Math.trunc(opts.maxRefineRoundsPerRoot ?? DEFAULT_MAX_REFINE_ROUNDS_PER_ROOT));
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

		const tagsWithoutRole = before.tags.filter((t) => !t.startsWith("role:"));
		const tagsWithAgent = tagsWithoutRole.includes("node:agent")
			? tagsWithoutRole
			: [...tagsWithoutRole, "node:agent"];
		const reopened = await this.#store.update(issueId, {
			status: "open",
			outcome: null,
			tags: [...tagsWithAgent, ORCHESTRATOR_ROLE_TAG],
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

	async #setRootPhase(rootId: string, phase: DagRootPhase): Promise<Issue | null> {
		const root = await this.#store.get(rootId);
		if (!root) {
			return null;
		}
		const nextTags = withRootPhaseTag(root.tags, phase);
		if (sameTags(root.tags, nextTags)) {
			return root;
		}
		return await this.#store.update(rootId, { tags: nextTags });
	}

	async #ensureReviewerIssue(rootId: string, round: number, step: number, rows: readonly Issue[]): Promise<Issue | null> {
		const hasParent = (issue: Issue): boolean => issue.deps.some((dep) => dep.type === "parent" && dep.target === rootId);
		const pending = rows
			.filter((issue) => issue.tags.includes(REVIEWER_ROLE_TAG) && hasParent(issue) && issue.status !== "closed")
			.sort((a, b) => {
				if (a.created_at !== b.created_at) {
					return a.created_at - b.created_at;
				}
				return a.id.localeCompare(b.id);
			})
			.pop();
		if (pending) {
			return pending;
		}

		const root = rows.find((row) => row.id === rootId) ?? null;
		if (!root) {
			return null;
		}

		const created = await this.#store.create(`Review round ${round}: ${root.title}`, {
			body:
				`Review the completed execution for root ${rootId}.\n\n` +
				`Close with outcome=success to accept, or outcome=refine/needs_work to request follow-up worker work.\n` +
				`Do not create child issues; refinement scheduling is orchestrator-owned.`,
			tags: ["node:agent", REVIEWER_ROLE_TAG, `review:round:${round}`],
			priority: Math.max(1, (root.priority ?? 3) - 1),
		});
		await this.#store.add_dep(created.id, "parent", rootId);

		await this.#events.emit("dag.review.issue_created", {
			source: "dag_runner",
			issueId: rootId,
			payload: { root_id: rootId, step, round, review_issue_id: created.id },
		});
		await this.#forum.post(
			`issue:${rootId}`,
			JSON.stringify({
				step,
				issue_id: rootId,
				type: "review_requested",
				round,
				review_issue_id: created.id,
			}),
			"orchestrator",
		);
		return created;
	}

	/**
	 * Reconcile entrypoint for one root DAG.
	 *
	 * Turn state machine (default path, no rollout flag branch):
	 *   turn_start
	 *     -> unstick_retryable
	 *     -> validate_root
	 *     -> select_leaf
	 *        -> (none) repair_deadlock -> turn_end
	 *        -> (leaf) dispatch_issue -> postcondition_reconcile -> requeue_retryable -> turn_end
	 *
	 * Reviewer/refinement loop contract:
	 *   plan -> execute -> review -> (accept | refine)
	 *   refine -> execute (after orchestrator persists follow-up executable work)
	 */
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

					const rows = await this.#store.list();
					const decision = reconcileDagTurn({
						issues: rows,
						rootId,
						attemptsByIssueId: this.#attempts,
						maxReorchestrationAttempts: MAX_REORCHESTRATION_ATTEMPTS,
						maxRefineRoundsPerRoot: this.#maxRefineRoundsPerRoot,
						dispatchTags: ["node:agent"],
					});

					if (decision.kind === "reopen_retryable") {
						await this.#reopenForOrchestration(decision.issue.id, {
							reason: decision.reason,
							step,
						});
						continue;
					}

					if (decision.kind === "enter_waiting_review") {
						const phased = await this.#setRootPhase(rootId, "waiting_review");
						if (!phased) {
							final = { status: "error", steps: step, error: "root vanished" };
							return final;
						}
						const reviewIssue = await this.#ensureReviewerIssue(rootId, decision.round, step, rows);
						if (!reviewIssue) {
							final = { status: "error", steps: step, error: "review_issue_create_failed" };
							return final;
						}
						await this.#events.emit("dag.review.waiting", {
							source: "dag_runner",
							issueId: rootId,
							payload: {
								root_id: rootId,
								step,
								round: decision.round,
								review_issue_id: reviewIssue.id,
								reason: decision.reason,
							},
						});
						continue;
					}

					if (decision.kind === "review_accept") {
						await this.#setRootPhase(rootId, "done");
						await this.#store.update(rootId, { status: "closed", outcome: "success" });
						await this.#events.emit("dag.review.accept", {
							source: "dag_runner",
							issueId: rootId,
							payload: { root_id: rootId, step, round: decision.round, review_issue_id: decision.issue.id },
						});
						await this.#forum.post(
							`issue:${rootId}`,
							JSON.stringify({
								step,
								issue_id: rootId,
								type: "review_accept",
								round: decision.round,
								review_issue_id: decision.issue.id,
							}),
							"orchestrator",
						);
						continue;
					}

					if (decision.kind === "review_refine") {
						await this.#setRootPhase(rootId, "refining");
						const normalized = normalizeOutcome(decision.issue.outcome);
						if (normalized !== REVIEW_DECISION_TO_OUTCOME.refine) {
							await this.#store.update(decision.issue.id, { outcome: REVIEW_DECISION_TO_OUTCOME.refine });
						}
						await this.#events.emit("dag.review.refine", {
							source: "dag_runner",
							issueId: rootId,
							payload: {
								root_id: rootId,
								step,
								round: decision.round,
								review_issue_id: decision.issue.id,
								reason: decision.reason,
							},
						});
						await this.#forum.post(
							`issue:${rootId}`,
							JSON.stringify({
								step,
								issue_id: rootId,
								type: "review_refine",
								round: decision.round,
								review_issue_id: decision.issue.id,
								reason: decision.reason,
							}),
							"orchestrator",
						);
						continue;
					}

					if (decision.kind === "review_budget_exhausted") {
						await this.#setRootPhase(rootId, "done");
						await this.#store.update(rootId, { status: "closed", outcome: "budget_exhausted" });
						await this.#events.emit("dag.review.budget_exhausted", {
							source: "dag_runner",
							issueId: rootId,
							payload: {
								root_id: rootId,
								step,
								round: decision.round,
								max_rounds: decision.max_rounds,
								review_issue_id: decision.issue.id,
							},
						});
						final = {
							status: "error",
							steps: step,
							error: `review_budget_exhausted:${decision.max_rounds}`,
						};
						return final;
					}

					if (decision.kind === "resume_active") {
						await this.#setRootPhase(rootId, "active");
						await this.#reopenForOrchestration(rootId, {
							reason: decision.reason,
							step,
						});
						await this.#events.emit("dag.review.resume_active", {
							source: "dag_runner",
							issueId: rootId,
							payload: { root_id: rootId, step, reason: decision.reason },
						});
						continue;
					}

					if (decision.kind === "root_final") {
						final = { status: "root_final", steps: i, error: "" };
						return final;
					}

					if (decision.kind === "repair_deadlock") {
						// repair_deadlock phase: run orchestrator on root to create executable leaf work.
						await this.#events.emit("dag.unstick.start", {
							source: "dag_runner",
							issueId: rootId,
							payload: { root_id: rootId, step },
						});

						const rootIssue = rows.find((row) => row.id === rootId) ?? null;
						if (!rootIssue) {
							final = { status: "error", steps: i, error: "root vanished" };
							return final;
						}

						const idsInScope = new Set(await this.#store.subtree_ids(rootId));
						const openIssues = rows.filter((row) => idsInScope.has(row.id) && row.status === "open");

						const diag =
							`- open_issues: ${openIssues.length}\n` +
							`- reconcile_reason: ${decision.reason}\n` +
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

					const issue = decision.issue;
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

					// dispatch_issue: claim leaf
					await this.#events.emit("dag.claim", {
						source: "dag_runner",
						issueId,
						payload: { root_id: rootId, step },
					});
					await this.#store.claim(issueId);

					// Track attempt count for circuit breaker.
					const attempt = (this.#attempts.get(issueId) ?? 0) + 1;
					this.#attempts.set(issueId, attempt);

					// dispatch_issue: resolve model + execute backend
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

					// postcondition_reconcile
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

					if (role === "reviewer") {
						const normalized = normalizeOutcome(updated.outcome);
						let canonicalOutcome: string | null = null;
						if (normalized && REVIEWER_ACCEPT_OUTCOMES.has(normalized)) {
							canonicalOutcome = REVIEW_DECISION_TO_OUTCOME.accept;
						} else if (normalized && REVIEWER_REFINE_OUTCOMES.has(normalized)) {
							canonicalOutcome = REVIEW_DECISION_TO_OUTCOME.refine;
						}
						if (canonicalOutcome && updated.outcome !== canonicalOutcome) {
							updated = await this.#store.update(issueId, { outcome: canonicalOutcome });
						}
					}

					// turn_end: persist execution record
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

					// requeue_retryable (bounded by attempt budget)
					if (role !== "reviewer" && updated.outcome && this.#reorchestrateOutcomes.has(updated.outcome)) {
						if (attempt < MAX_REORCHESTRATION_ATTEMPTS) {
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
