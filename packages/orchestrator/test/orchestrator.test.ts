import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJsonlStore, fsEventLog, getStorePaths } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import type { BackendRunner, BackendRunOpts } from "@femtomc/mu-orchestrator";
import {
	buildRoleCatalog,
	DagRunner,
	PiStreamRenderer,
	piStreamHasError,
	renderPromptTemplate,
} from "@femtomc/mu-orchestrator";

async function mkTempRepo(): Promise<{ repoRoot: string; store: IssueStore; forum: ForumStore }> {
	const repoRoot = await mkdtemp(join(tmpdir(), "mu-orchestrator-"));
	await mkdir(join(repoRoot, ".mu"), { recursive: true });

	const paths = getStorePaths(repoRoot);
	const events = fsEventLog(paths.eventsPath);
	const store = new IssueStore(new FsJsonlStore(paths.issuesPath), { events });
	const forum = new ForumStore(new FsJsonlStore(paths.forumPath), { events });
	return { repoRoot, store, forum };
}

async function writeRole(
	repoRoot: string,
	name: string,
	opts: { cli?: string; model?: string; reasoning?: string; description?: string },
	body: string,
): Promise<void> {
	const lines: string[] = [];
	if (opts.cli) lines.push(`cli: ${opts.cli}`);
	if (opts.model) lines.push(`model: ${opts.model}`);
	if (opts.reasoning) lines.push(`reasoning: ${opts.reasoning}`);
	if (opts.description) lines.push(`description: ${opts.description}`);
	const frontmatter = lines.join("\n");

	const rolesDir = join(repoRoot, ".mu", "roles");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

async function writeOrchestratorPrompt(repoRoot: string): Promise<void> {
	await writeFile(
		join(repoRoot, ".mu", "orchestrator.md"),
		`---\ncli: pi\nmodel: orch-model\nreasoning: orch-think\n---\n{{PROMPT}}\n\n{{ROLES}}\n`,
		"utf8",
	);
}

class StubBackend implements BackendRunner {
	public readonly runs: BackendRunOpts[] = [];
	#handlers = new Map<string, (opts: BackendRunOpts) => Promise<number>>();

	public on(issueId: string, handler: (opts: BackendRunOpts) => Promise<number>): void {
		this.#handlers.set(issueId, handler);
	}

	public async run(opts: BackendRunOpts): Promise<number> {
		this.runs.push(opts);
		const handler = this.#handlers.get(opts.issueId);
		if (!handler) {
			return 0;
		}
		return await handler(opts);
	}
}

describe("piStreamHasError", () => {
	test("detects assistantMessageEvent error", () => {
		expect(piStreamHasError(`{"type":"message_update","assistantMessageEvent":{"type":"error"}}`)).toBe(true);
	});

	test("detects assistant message_end stopReason error/aborted", () => {
		expect(piStreamHasError(`{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}`)).toBe(true);
		expect(piStreamHasError(`{"type":"message_end","message":{"role":"assistant","stopReason":"aborted"}}`)).toBe(
			true,
		);
		expect(piStreamHasError(`{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}`)).toBe(false);
	});

	test("ignores non-json lines", () => {
		expect(piStreamHasError("not json")).toBe(false);
	});
});

describe("prompt templates", () => {
	test("renders {{PROMPT}}, {{ISSUE_ID}}, and {{ROLES}}", async () => {
		const { repoRoot, store } = await mkTempRepo();
		await writeRole(
			repoRoot,
			"worker",
			{
				cli: "pi",
				model: "worker-model",
				reasoning: "worker-think",
				description: "Do work.",
			},
			"Worker role.\n",
		);
		await writeRole(
			repoRoot,
			"reviewer",
			{
				cli: "pi",
				model: "reviewer-model",
				reasoning: "reviewer-think",
				description: "Review work.",
			},
			"Reviewer role.\n",
		);

		const cat = await buildRoleCatalog(repoRoot);
		expect(cat).toContain("### reviewer");
		expect(cat).toContain("prompt: .mu/roles/reviewer.md");
		expect(cat).toContain("description_source: frontmatter");

		const issue = await store.create("T", { body: "B" });
		const tpl = join(repoRoot, "tpl.md");
		await writeFile(tpl, `---\n---\nID={{ISSUE_ID}}\n\n{{PROMPT}}\n\n{{ROLES}}\n`, "utf8");
		const rendered = await renderPromptTemplate(tpl, issue, { repoRoot });
		expect(rendered).toContain(`ID=${issue.id}`);
		expect(rendered).toContain("T");
		expect(rendered).toContain("B");
		expect(rendered).toContain("### worker");
	});
});

describe("PiStreamRenderer", () => {
	test("renders assistant text deltas and a newline on assistant message_end", () => {
		const r = new PiStreamRenderer();
		const lines = [
			`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}`,
			`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" world"}}`,
			`{"type":"message_end","message":{"role":"assistant"}}`,
		];
		const out = lines
			.map((l) => r.renderLine(l))
			.filter((x): x is string => x != null)
			.join("");
		expect(out).toBe("Hello world\n");
	});

	test("passes through non-json lines", () => {
		const r = new PiStreamRenderer();
		expect(r.renderLine("warning: not json")).toBe("warning: not json\n");
	});

	test("renders tool start events when enabled", () => {
		const r = new PiStreamRenderer({ showToolEvents: true });
		const lines = [
			`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hi"}}`,
			`{"type":"tool_execution_start","toolName":"apply_patch"}`,
		];
		const out = lines
			.map((l) => r.renderLine(l))
			.filter((x): x is string => x != null)
			.join("");
		expect(out).toBe("Hi\n[tool] apply_patch\n");
	});
});

describe("DagRunner", () => {
	test("marks failure when backend doesn't close, and reopens for orchestration", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();
		await writeOrchestratorPrompt(repoRoot);
		await writeRole(repoRoot, "worker", { cli: "pi", model: "worker-model", reasoning: "worker-think" }, "Worker.\n");

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf", { tags: ["node:agent"], executionSpec: { role: "worker" } });
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();
		// Intentionally do nothing: runner should close as failure, then reopen for orchestration.

		const runner = new DagRunner(store, forum, repoRoot, { backend });
		const result = await runner.run(root.id, 1, { review: false });
		expect(result.status).toBe("max_steps_exhausted");

		const updated = await store.get(leaf.id);
		expect(updated?.status).toBe("open");
		expect(updated?.outcome).toBeNull();
		expect((updated?.execution_spec as any)?.role).toBe("orchestrator");

		const msgs = await forum.read(`issue:${leaf.id}`, 10);
		expect(msgs.some((m) => m.author === "orchestrator")).toBe(true);
	});

	test("auto-skips explicit leaf reviewer issues (review is runner-managed)", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();
		await writeOrchestratorPrompt(repoRoot);
		await writeRole(
			repoRoot,
			"reviewer",
			{ cli: "pi", model: "reviewer-model", reasoning: "reviewer-think" },
			"Reviewer.\n",
		);

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("review leaf", { tags: ["node:agent"], executionSpec: { role: "reviewer" } });
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();

		const runner = new DagRunner(store, forum, repoRoot, { backend });
		const result = await runner.run(root.id, 2, { review: false });
		expect(result.status).toBe("root_final");

		// No backend execution: leaf is auto-closed as a no-op terminal node.
		expect(backend.runs.length).toBe(0);

		const updated = await store.get(leaf.id);
		expect(updated?.status).toBe("closed");
		expect(updated?.outcome).toBe("skipped");

		const msgs = await forum.read(`issue:${leaf.id}`, 20);
		expect(msgs.some((m) => m.body.includes('"type":"skip-reviewer-leaf"'))).toBe(true);
	});

	test("heals reviewer failures to skipped instead of reopening for orchestration", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();
		await writeOrchestratorPrompt(repoRoot);

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("review leaf", { tags: ["node:agent"], executionSpec: { role: "reviewer" } });
		await store.add_dep(leaf.id, "parent", root.id);
		await store.update(leaf.id, { status: "closed", outcome: "failure" });

		const backend = new StubBackend();
		const runner = new DagRunner(store, forum, repoRoot, { backend });
		const result = await runner.run(root.id, 1, { review: false });
		expect(result.status).toBe("root_final");
		expect(backend.runs.length).toBe(0);

		const updated = await store.get(leaf.id);
		expect(updated?.status).toBe("closed");
		expect(updated?.outcome).toBe("skipped");
	});

	test("reviewer can set needs_work which triggers re-orchestration", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();
		await writeOrchestratorPrompt(repoRoot);
		await writeRole(repoRoot, "worker", { cli: "pi", model: "worker-model", reasoning: "worker-think" }, "Worker.\n");
		await writeRole(
			repoRoot,
			"reviewer",
			{ cli: "pi", model: "reviewer-model", reasoning: "reviewer-think" },
			"Reviewer.\n",
		);

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf", { tags: ["node:agent"], executionSpec: { role: "worker" } });
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();
		backend.on(leaf.id, async (opts) => {
			if (opts.model === "worker-model") {
				await store.close(leaf.id, "success");
				return 0;
			}
			if (opts.model === "reviewer-model") {
				await store.update(leaf.id, { outcome: "needs_work" });
				return 0;
			}
			return 0;
		});

		const runner = new DagRunner(store, forum, repoRoot, { backend });
		const result = await runner.run(root.id, 1, { review: true });
		expect(result.status).toBe("max_steps_exhausted");

		const updated = await store.get(leaf.id);
		expect(updated?.status).toBe("open");
		expect((updated?.execution_spec as any)?.role).toBe("orchestrator");
		expect(updated?.outcome).toBeNull();

		const msgs = await forum.read(`issue:${leaf.id}`, 20);
		expect(msgs.some((m) => m.author === "reviewer")).toBe(true);
	});

	test("unstick repair pass runs orchestrator on root when there are no executable leaves", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();
		await writeOrchestratorPrompt(repoRoot);
		await writeRole(repoRoot, "worker", { cli: "pi", model: "worker-model", reasoning: "worker-think" }, "Worker.\n");

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		// Blocked child chain: P -> C, but C is blocked by B. Only C/P are tagged node:agent.
		const blocker = await store.create("blocker", { tags: [] });
		await store.add_dep(blocker.id, "parent", root.id);

		const parent = await store.create("parent", { tags: ["node:agent"], executionSpec: { role: "worker" } });
		await store.add_dep(parent.id, "parent", root.id);

		const child = await store.create("child", { tags: ["node:agent"], executionSpec: { role: "worker" } });
		await store.add_dep(child.id, "parent", parent.id);

		// blocker blocks child until blocker is closed.
		await store.add_dep(blocker.id, "blocks", child.id);

		const backend = new StubBackend();
		backend.on(root.id, async (opts) => {
			// This is the repair invocation (`logSuffix=unstick`).
			if (opts.logSuffix === "unstick") {
				await store.close(blocker.id, "success");
			}
			return 0;
		});
		backend.on(child.id, async () => {
			await store.close(child.id, "success");
			return 0;
		});
		backend.on(parent.id, async () => {
			await store.close(parent.id, "success");
			return 0;
		});

		const runner = new DagRunner(store, forum, repoRoot, { backend });
		const result = await runner.run(root.id, 10, { review: false });
		expect(result.status).toBe("root_final");

		// Ensure the orchestrator repair pass happened.
		expect(backend.runs.some((r) => r.issueId === root.id && r.logSuffix === "unstick")).toBe(true);
	});

	test("collapse review promotes expanded parent to success when reviewer makes no changes", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();
		await writeOrchestratorPrompt(repoRoot);
		await writeRole(
			repoRoot,
			"reviewer",
			{ cli: "pi", model: "reviewer-model", reasoning: "reviewer-think" },
			"Reviewer.\n",
		);

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const parent = await store.create("parent", { tags: [], body: "spec" });
		await store.add_dep(parent.id, "parent", root.id);
		await store.update(parent.id, { status: "closed", outcome: "expanded" });

		const child = await store.create("child", { tags: [] });
		await store.add_dep(child.id, "parent", parent.id);
		await store.update(child.id, { status: "closed", outcome: "success" });

		const backend = new StubBackend();
		backend.on(parent.id, async () => {
			// Collapse review prompt is executed against the parent issue id.
			// Reviewer makes no changes: runner should promote parent outcome to success.
			return 0;
		});

		const runner = new DagRunner(store, forum, repoRoot, { backend });
		const result = await runner.run(root.id, 5, { review: true });
		expect(result.status).toBe("root_final");

		const updatedParent = await store.get(parent.id);
		expect(updatedParent?.outcome).toBe("success");
	});

	test("invokes step hooks and wires backend onLine (including reviewer streaming)", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();
		await writeOrchestratorPrompt(repoRoot);
		await writeRole(repoRoot, "worker", { cli: "pi", model: "worker-model", reasoning: "worker-think" }, "Worker.\n");
		await writeRole(
			repoRoot,
			"reviewer",
			{ cli: "pi", model: "reviewer-model", reasoning: "reviewer-think" },
			"Reviewer.\n",
		);

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf", { tags: ["node:agent"], executionSpec: { role: "worker" } });
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();
		backend.on(leaf.id, async (opts) => {
			if (opts.model === "worker-model") {
				opts.onLine?.("L1");
				opts.onLine?.("L2");
				await store.close(leaf.id, "success");
				return 0;
			}
			if (opts.model === "reviewer-model") {
				opts.onLine?.("R1");
				return 0;
			}
			return 0;
		});

		const calls: string[] = [];
		const runner = new DagRunner(store, forum, repoRoot, { backend });
		const result = await runner.run(root.id, 1, {
			review: true,
			hooks: {
				onStepStart: ({ step, issueId }) => {
					calls.push(`step.start:${step}:${issueId}`);
				},
				onBackendLine: ({ logSuffix, line }) => {
					calls.push(`line:${logSuffix}:${line}`);
				},
				onStepEnd: ({ outcome }) => {
					calls.push(`step.end:${outcome}`);
				},
			},
		});

		expect(result.status).toBe("max_steps_exhausted");
		expect(calls).toEqual([`step.start:1:${leaf.id}`, "line::L1", "line::L2", "line:review:R1", "step.end:success"]);
	});
});
