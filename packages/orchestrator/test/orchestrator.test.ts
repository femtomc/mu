import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJsonlStore, fsEventLog, getStorePaths } from "@mu/core/node";
import { ForumStore } from "@mu/forum";
import { IssueStore } from "@mu/issue";
import type { BackendRunner, BackendRunOpts } from "@mu/orchestrator";
import { buildRoleCatalog, DagRunner, piStreamHasError, renderPromptTemplate } from "@mu/orchestrator";

async function mkTempRepo(): Promise<{ repoRoot: string; store: IssueStore; forum: ForumStore }> {
	const repoRoot = await mkdtemp(join(tmpdir(), "mu-orchestrator-"));
	await mkdir(join(repoRoot, ".inshallah"), { recursive: true });

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

	const rolesDir = join(repoRoot, ".inshallah", "roles");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

async function writeOrchestratorPrompt(repoRoot: string): Promise<void> {
	await writeFile(
		join(repoRoot, ".inshallah", "orchestrator.md"),
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
		expect(cat).toContain("prompt: .inshallah/roles/reviewer.md");
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
		expect(updated?.execution_spec).toBeNull();

		const msgs = await forum.read(`issue:${leaf.id}`, 10);
		expect(msgs.some((m) => m.author === "orchestrator")).toBe(true);
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
		expect(updated?.execution_spec).toBeNull();
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
});
