import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Issue, ValidationResult } from "@mu/core";
import {
	currentRunId,
	type EventLog,
	executionSpecFromDict,
	fsEventLogFromRepoRoot,
	getStorePaths,
	newRunId,
	runContext,
} from "@mu/core/node";
import type { ForumStore } from "@mu/forum";
import type { IssueStore } from "@mu/issue";
import type { BackendRunner } from "./pi_backend";
import { PiCliBackend } from "./pi_backend";
import { readPromptMeta, renderPromptTemplate } from "./prompt";

export type DagResult = {
	status: "root_final" | "no_executable_leaf" | "max_steps_exhausted" | "error";
	steps: number;
	error: string;
};

type ResolvedConfig = {
	cli: string;
	model: string;
	reasoning: string;
	promptPath: string | null;
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

export class DagRunner {
	// Hardcoded fallbacks if neither execution_spec nor orchestrator.md provide config.
	readonly #fallbackCli = "pi";
	readonly #fallbackModel = "gpt-5.3-codex";
	readonly #fallbackReasoning = "xhigh";

	readonly #store: IssueStore;
	readonly #forum: ForumStore;
	readonly #repoRoot: string;
	readonly #events: EventLog;
	readonly #backend: BackendRunner;

	readonly #reorchestrateOutcomes = new Set(["failure", "needs_work"]);

	public constructor(
		store: IssueStore,
		forum: ForumStore,
		repoRoot: string,
		opts: { backend?: BackendRunner; events?: EventLog } = {},
	) {
		this.#store = store;
		this.#forum = forum;
		this.#repoRoot = repoRoot;
		this.#events = opts.events ?? fsEventLogFromRepoRoot(repoRoot);
		this.#backend = opts.backend ?? new PiCliBackend();
	}

	async #resolveConfig(issue: Pick<Issue, "execution_spec">): Promise<ResolvedConfig> {
		let cli = this.#fallbackCli;
		let model = this.#fallbackModel;
		let reasoning = this.#fallbackReasoning;
		let promptPath: string | null = null;

		// Tier 1: orchestrator.md frontmatter (global defaults).
		const { orchestratorPath } = getStorePaths(this.#repoRoot);
		if (existsSync(orchestratorPath)) {
			const meta = await readPromptMeta(orchestratorPath);
			if (typeof meta.cli === "string") cli = meta.cli;
			if (typeof meta.model === "string") model = meta.model;
			if (typeof meta.reasoning === "string") reasoning = meta.reasoning;
			promptPath = orchestratorPath;
		}

		// Parse execution spec (may set role + explicit fields).
		const specDict = issue.execution_spec ?? null;
		const spec = specDict ? executionSpecFromDict(specDict, this.#repoRoot) : null;

		// Tier 2: role file frontmatter (role-specific defaults).
		if (spec?.role) {
			const rolePath = join(this.#repoRoot, ".inshallah", "roles", `${spec.role}.md`);
			if (existsSync(rolePath)) {
				const roleMeta = await readPromptMeta(rolePath);
				if (typeof roleMeta.cli === "string") cli = roleMeta.cli;
				if (typeof roleMeta.model === "string") model = roleMeta.model;
				if (typeof roleMeta.reasoning === "string") reasoning = roleMeta.reasoning;
			}
		}

		// Tier 3: execution_spec explicit fields (highest priority).
		if (spec) {
			if (spec.cli != null) cli = spec.cli;
			if (spec.model != null) model = spec.model;
			if (spec.reasoning != null) reasoning = spec.reasoning;
			if (spec.prompt_path != null) promptPath = spec.prompt_path;
		}

		return { cli, model, reasoning, promptPath };
	}

	async #renderPrompt(issue: Pick<Issue, "id" | "title" | "body">, promptPath: string | null, rootId: string) {
		let rendered: string;
		if (promptPath && existsSync(promptPath)) {
			rendered = await renderPromptTemplate(promptPath, issue, { repoRoot: this.#repoRoot });
		} else {
			rendered = issue.title;
			if (issue.body) {
				rendered += `\n\n${issue.body}`;
			}
		}

		rendered += `\n\n## Inshallah Context\nRoot: ${rootId}\nAssigned issue: ${issue.id}\n`;
		return rendered;
	}

	async #executeBackend(
		issue: Pick<Issue, "id" | "title" | "body">,
		cfg: ResolvedConfig,
		rootId: string,
		opts: { logSuffix?: string } = {},
	): Promise<{ exitCode: number; elapsedS: number }> {
		const logSuffix = opts.logSuffix ?? "";
		const rendered = await this.#renderPrompt(issue, cfg.promptPath, rootId);

		const { logsDir } = getStorePaths(this.#repoRoot);
		await mkdir(logsDir, { recursive: true });

		const suffix = logSuffix ? `.${logSuffix}` : "";
		const teePath = join(logsDir, `${issue.id}${suffix}.jsonl`);

		await this.#events.emit("backend.run.start", {
			source: "backend",
			issueId: issue.id,
			payload: {
				cli: cfg.cli,
				model: cfg.model,
				reasoning: cfg.reasoning,
				prompt_path: cfg.promptPath,
				tee_path: relPath(this.#repoRoot, teePath),
				log_suffix: logSuffix,
			},
		});

		const t0 = Date.now();
		const exitCode = await this.#backend.run({
			issueId: issue.id,
			prompt: rendered,
			model: cfg.model,
			thinking: cfg.reasoning,
			cwd: this.#repoRoot,
			cli: cfg.cli,
			promptPath: cfg.promptPath,
			logSuffix,
			teePath,
		});
		const elapsedS = (Date.now() - t0) / 1000;

		await this.#events.emit("backend.run.end", {
			source: "backend",
			issueId: issue.id,
			payload: {
				cli: cfg.cli,
				exit_code: exitCode,
				elapsed_s: roundTo(elapsedS, 3),
				tee_path: relPath(this.#repoRoot, teePath),
				log_suffix: logSuffix,
			},
		});

		return { exitCode, elapsedS };
	}

	#hasReviewer(): boolean {
		return existsSync(join(this.#repoRoot, ".inshallah", "roles", "reviewer.md"));
	}

	async #maybeReview(issue: Issue, rootId: string, step: number): Promise<Issue> {
		const issueId = issue.id;

		// Guards.
		if (issue.outcome !== "success") {
			return issue;
		}
		if (!this.#hasReviewer()) {
			return issue;
		}

		await this.#events.emit("dag.review.start", {
			source: "dag_runner",
			issueId,
			payload: { root_id: rootId, step },
		});

		const reviewIssue: Issue = { ...issue, execution_spec: { role: "reviewer" } as any };
		const cfg = await this.#resolveConfig(reviewIssue);
		const { exitCode, elapsedS } = await this.#executeBackend(reviewIssue, cfg, rootId, { logSuffix: "review" });

		await this.#forum.post(
			`issue:${issueId}`,
			JSON.stringify({
				step,
				issue_id: issueId,
				title: issue.title,
				exit_code: exitCode,
				elapsed_s: roundTo(elapsedS, 1),
				type: "review",
			}),
			"reviewer",
		);

		const updated = (await this.#store.get(issueId)) ?? issue;
		await this.#events.emit("dag.review.end", {
			source: "dag_runner",
			issueId,
			payload: { root_id: rootId, step, outcome: updated.outcome },
		});

		return updated;
	}

	async #reopenForOrchestration(issueId: string, opts: { reason: string; step: number }): Promise<void> {
		const reopened = await this.#store.update(issueId, { status: "open", outcome: null, execution_spec: null });
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

	async #collapseReview(issue: Issue, rootId: string, step: number): Promise<void> {
		const issueId = issue.id;

		await this.#events.emit("dag.collapse_review.start", {
			source: "dag_runner",
			issueId,
			payload: { root_id: rootId, step },
		});

		const kids = await this.#store.children(issueId);
		const lines: string[] = [];
		for (const kid of kids) {
			lines.push(`- [${kid.outcome ?? "?"}] ${kid.id}: ${kid.title}`);
		}
		const childrenSummary = lines.join("\n");

		const originalBody = issue.body || "";
		const collapsePrompt =
			`# Collapse Review\n\n` +
			`## Original Specification\n\n` +
			`**${issue.title}**\n\n` +
			`${originalBody}\n\n` +
			`## Children Outcomes\n\n` +
			`${childrenSummary}\n\n` +
			`## Instructions\n\n` +
			`All children of this issue have completed. Review whether their aggregate work satisfies the original specification above.\n\n` +
			`If satisfied: no action needed (the issue will be marked successful).\n\n` +
			`If NOT satisfied: mark the parent as needing work by running:\n\n` +
			`  \`inshallah issues update ${issueId} --outcome needs_work\`\n\n` +
			`Then explain the gaps in the forum topic (issue:${issueId}).\n\n` +
			`Do NOT create child issues yourself; the orchestrator will re-expand the issue into remediation children.\n`;

		const reviewIssue: Issue = {
			...issue,
			title: `Collapse review: ${issue.title}`,
			body: collapsePrompt,
			execution_spec: { role: "reviewer" } as any,
		};

		const cfg = await this.#resolveConfig(reviewIssue);
		const { exitCode, elapsedS } = await this.#executeBackend(reviewIssue, { ...cfg, promptPath: null }, rootId, {
			logSuffix: "collapse-review",
		});

		await this.#forum.post(
			`issue:${issueId}`,
			JSON.stringify({
				step,
				issue_id: issueId,
				title: issue.title,
				exit_code: exitCode,
				elapsed_s: roundTo(elapsedS, 1),
				type: "collapse-review",
			}),
			"reviewer",
		);

		const newKids = await this.#store.children(issueId);
		const openKids = newKids.filter((k) => k.status !== "closed");
		const updated = (await this.#store.get(issueId)) ?? issue;

		if (updated.status !== "closed") {
			await this.#events.emit("dag.collapse_review.end", {
				source: "dag_runner",
				issueId,
				payload: { root_id: rootId, step, status: updated.status, outcome: updated.outcome },
			});
			return;
		}
		if (updated.outcome && this.#reorchestrateOutcomes.has(updated.outcome)) {
			await this.#events.emit("dag.collapse_review.end", {
				source: "dag_runner",
				issueId,
				payload: { root_id: rootId, step, status: updated.status, outcome: updated.outcome },
			});
			return;
		}
		if (openKids.length > 0) {
			await this.#events.emit("dag.collapse_review.end", {
				source: "dag_runner",
				issueId,
				payload: {
					root_id: rootId,
					step,
					status: updated.status,
					outcome: updated.outcome,
					open_kids: openKids.length,
				},
			});
			return;
		}

		await this.#store.update(issueId, { outcome: "success" });
		await this.#events.emit("dag.collapse_review.end", {
			source: "dag_runner",
			issueId,
			payload: { root_id: rootId, step, outcome: "success" },
		});
	}

	async run(rootId: string, maxSteps: number = 20, opts: { review?: boolean } = {}): Promise<DagResult> {
		const review = opts.review ?? true;
		const runId = currentRunId() ?? newRunId();

		return await runContext({ runId }, async () => {
			await this.#events.emit("dag.run.start", {
				source: "dag_runner",
				issueId: rootId,
				payload: { root_id: rootId, max_steps: maxSteps, review },
			});

			let final: DagResult | null = null;
			try {
				for (let i = 0; i < maxSteps; i++) {
					const step = i + 1;

					// 0. Unstick: failures / needs_work trigger re-orchestration.
					await this.#maybeUnstick(rootId, step);

					// 1. Collapse review (before termination check).
					if (review && this.#hasReviewer()) {
						const collapsible = await this.#store.collapsible(rootId);
						if (collapsible.length > 0) {
							await this.#collapseReview(collapsible[0]!, rootId, step);
							continue;
						}
					}

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
							`- hint: run \`inshallah issues ready --root ${rootId}\` and \`inshallah issues list --root ${rootId}\`\n`;

						const repairIssue: Issue = {
							...rootIssue,
							title: `Repair stuck DAG: ${rootIssue.title}`,
							body: `${(rootIssue.body || "").trim()}\n\n## Runner Diagnostics\n\n${diag}`.trim(),
							execution_spec: null,
						};

						const cfg = await this.#resolveConfig(repairIssue);
						const { exitCode, elapsedS } = await this.#executeBackend(repairIssue, cfg, rootId, {
							logSuffix: "unstick",
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

					await this.#events.emit("dag.step.start", {
						source: "dag_runner",
						issueId,
						payload: { root_id: rootId, step, title: issue.title ?? "" },
					});

					// 3. Claim.
					await this.#events.emit("dag.claim", {
						source: "dag_runner",
						issueId,
						payload: { root_id: rootId, step },
					});
					await this.#store.claim(issueId);

					// 4. Route + 5. Render + 6. Execute.
					const cfg = await this.#resolveConfig(issue);
					const { exitCode, elapsedS } = await this.#executeBackend(issue, cfg, rootId);

					// 7. Check postconditions.
					let updated = await this.#store.get(issueId);
					if (!updated) {
						final = { status: "error", steps: step, error: "issue vanished" };
						return final;
					}

					if (updated.status !== "closed") {
						updated = await this.#store.close(issueId, "failure");
					}

					// 7b. Review phase.
					if (review && updated.status === "closed") {
						updated = await this.#maybeReview(updated, rootId, step);
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

					// 9. Re-orchestrate on failure / needs_work.
					if (updated.outcome && this.#reorchestrateOutcomes.has(updated.outcome)) {
						await this.#reopenForOrchestration(issueId, { reason: `outcome=${updated.outcome}`, step });
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
