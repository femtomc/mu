import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FsJsonlStore, fsEventLog, getStorePaths } from "@femtomc/mu-core/node";
import { ForumStore } from "@femtomc/mu-forum";
import { IssueStore } from "@femtomc/mu-issue";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { BackendRunner, BackendRunOpts } from "@femtomc/mu-orchestrator";
import { createMuResourceLoader, DagRunner, PiStreamRenderer, piStreamHasError, resolveModelConfig } from "@femtomc/mu-orchestrator";
import { buildPiCliArgv } from "../src/pi_backend.js";

const TEST_MODEL_OVERRIDES = { model: "gpt-5.3-codex" };

function pickProviderModel(): { provider: string; modelId: string } {
	const providers = getProviders();
	const preferredProvider = "openai-codex";
	const ordered = providers.includes(preferredProvider as any)
		? [preferredProvider, ...providers.filter((p) => p !== preferredProvider)]
		: providers;

	for (const provider of ordered) {
		const models = getModels(provider as any);
		if (models.length === 0) continue;
		const preferredModel = models.find((m) => m.id === "gpt-5.3-codex")?.id;
		return { provider, modelId: preferredModel ?? models[0]!.id };
	}

	throw new Error("No providers with models in pi-ai registry.");
}

async function mkTempRepo(): Promise<{ repoRoot: string; store: IssueStore; forum: ForumStore }> {
	const repoRoot = await mkdtemp(join(tmpdir(), "mu-orchestrator-"));
	await mkdir(join(repoRoot, ".mu"), { recursive: true });

	const paths = getStorePaths(repoRoot);
	const events = fsEventLog(paths.eventsPath);
	const store = new IssueStore(new FsJsonlStore(paths.issuesPath), { events });
	const forum = new ForumStore(new FsJsonlStore(paths.forumPath), { events });
	return { repoRoot, store, forum };
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

describe("buildPiCliArgv", () => {
	test("includes provider and systemPrompt flags (role system prompt must not be dropped)", () => {
		const argv = buildPiCliArgv({
			prompt: "USER_PROMPT",
			systemPrompt: "SYSTEM_PROMPT",
			provider: "openai-codex",
			model: "gpt-5.3-codex",
			thinking: "xhigh",
		});

		expect(argv).toContain("--provider");
		expect(argv[argv.indexOf("--provider") + 1]).toBe("openai-codex");

		expect(argv).toContain("--system-prompt");
		expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("SYSTEM_PROMPT");

		expect(argv.at(-1)).toBe("USER_PROMPT");
	});
});

describe("createMuResourceLoader", () => {
	test("filters context files to AGENTS.md only (never CLAUDE.md)", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "mu-orchestrator-context-"));
		const agentDir = await mkdtemp(join(tmpdir(), "mu-orchestrator-agentdir-"));

		// Only CLAUDE.md: should be filtered out, leaving no context files.
		await writeFile(join(repoRoot, "CLAUDE.md"), "claude", "utf8");
		{
			const loader = createMuResourceLoader({ cwd: repoRoot, agentDir, systemPrompt: "X" });
			await loader.reload();
			const agentsFiles = loader.getAgentsFiles().agentsFiles;
			expect(agentsFiles.length).toBe(0);
		}

		// AGENTS.md present: should be included (and CLAUDE.md still excluded).
		await writeFile(join(repoRoot, "AGENTS.md"), "agents", "utf8");
		{
			const loader = createMuResourceLoader({ cwd: repoRoot, agentDir, systemPrompt: "X" });
			await loader.reload();
			const agentsFiles = loader.getAgentsFiles().agentsFiles;
			expect(agentsFiles.map((f) => basename(f.path))).toEqual(["AGENTS.md"]);
			expect(loader.getSystemPrompt()).toBe("X");
		}
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

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf", { tags: ["node:agent", "role:worker"] });
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();
		// Intentionally do nothing: runner should close as failure, then reopen for orchestration.

		const runner = new DagRunner(store, forum, repoRoot, { backend, modelOverrides: TEST_MODEL_OVERRIDES });
		const result = await runner.run(root.id, 1);
		expect(result.status).toBe("max_steps_exhausted");

		const updated = await store.get(leaf.id);
		expect(updated?.status).toBe("open");
		expect(updated?.outcome).toBeNull();
		expect(updated?.tags.includes("role:orchestrator")).toBe(true);

		const msgs = await forum.read(`issue:${leaf.id}`, 10);
		expect(msgs.some((m) => m.author === "orchestrator")).toBe(true);
	});

	test("passes role-specific systemPrompt and issue-only user prompt to backend", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf-title", {
			tags: ["node:agent", "role:worker"],
			body: "leaf-body",
		});
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();
		backend.on(leaf.id, async () => {
			await store.close(leaf.id, "success");
			return 0;
		});

		const runner = new DagRunner(store, forum, repoRoot, { backend, modelOverrides: TEST_MODEL_OVERRIDES });
		await runner.run(root.id, 1);

		expect(backend.runs.length).toBe(1);
		const run = backend.runs[0]!;
		expect(run.role).toBe("worker");
		expect(run.systemPrompt).toContain("mu's worker");

		// User prompt is just the issue spec + mu run context (not role/system instructions).
		expect(run.prompt).toContain("leaf-title");
		expect(run.prompt).toContain("leaf-body");
		expect(run.prompt).toContain("## Mu Run Context");
		expect(run.prompt).not.toContain("ORCH_TEMPLATE_MARKER");
	});

	test("threads resolved provider through to backend opts", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf", { tags: ["node:agent", "role:worker"] });
		await store.add_dep(leaf.id, "parent", root.id);

		const { provider, modelId } = pickProviderModel();

		const backend = new StubBackend();
		backend.on(leaf.id, async () => {
			await store.close(leaf.id, "success");
			return 0;
		});

		const runner = new DagRunner(store, forum, repoRoot, { backend, modelOverrides: { model: modelId, provider } });
		await runner.run(root.id, 1);

		expect(backend.runs.length).toBe(1);
		const run = backend.runs[0]!;
		expect(run.provider).toBe(provider);
		expect(run.model).toBe(modelId);
	});

	test("defaults role to orchestrator when no role tag present", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf", { tags: ["node:agent"], body: "B" });
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();
		backend.on(leaf.id, async () => {
			await store.close(leaf.id, "success");
			return 0;
		});

		const runner = new DagRunner(store, forum, repoRoot, { backend, modelOverrides: TEST_MODEL_OVERRIDES });
		await runner.run(root.id, 1);

		expect(backend.runs.length).toBe(1);
		const run = backend.runs[0]!;
		expect(run.role).toBe("orchestrator");
		expect(run.systemPrompt).toContain("mu's orchestrator");
		expect(run.systemPrompt).toContain("You MUST NOT execute work directly");
		expect(run.systemPrompt).toContain("No code changes, no file edits, no git commits");
		expect(run.systemPrompt).toContain("MUST decompose the assigned issue into worker child issues");
		expect(run.systemPrompt).toContain("--outcome expanded");
		expect(run.systemPrompt).toContain("deterministic and minimal");
		expect(run.systemPrompt).toContain("blocks");
		expect(run.systemPrompt).not.toContain("You are mu's worker");
		expect(run.systemPrompt).not.toContain("Implement: edit files");
		expect(run.systemPrompt).not.toContain("Implement the work described in your assigned issue");
	});

	test("unstick repair pass runs orchestrator on root when there are no executable leaves", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		// Blocked child chain: P -> C, but C is blocked by B. Only C/P are tagged node:agent.
		const blocker = await store.create("blocker", { tags: [] });
		await store.add_dep(blocker.id, "parent", root.id);

		const parent = await store.create("parent", { tags: ["node:agent", "role:worker"] });
		await store.add_dep(parent.id, "parent", root.id);

		const child = await store.create("child", { tags: ["node:agent", "role:worker"] });
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

		const runner = new DagRunner(store, forum, repoRoot, { backend, modelOverrides: TEST_MODEL_OVERRIDES });
		const result = await runner.run(root.id, 10);
		expect(result.status).toBe("root_final");

		// Ensure the orchestrator repair pass happened.
		expect(backend.runs.some((r) => r.issueId === root.id && r.logSuffix === "unstick")).toBe(true);
	});

	test("invokes step hooks and wires backend onLine", async () => {
		const { repoRoot, store, forum } = await mkTempRepo();

		const root = await store.create("root", { tags: [] });
		await store.update(root.id, { status: "closed", outcome: "expanded" });

		const leaf = await store.create("leaf", { tags: ["node:agent", "role:worker"] });
		await store.add_dep(leaf.id, "parent", root.id);

		const backend = new StubBackend();
		backend.on(leaf.id, async (opts) => {
			opts.onLine?.("L1");
			opts.onLine?.("L2");
			await store.close(leaf.id, "success");
			return 0;
		});

		const calls: string[] = [];
		const runner = new DagRunner(store, forum, repoRoot, { backend, modelOverrides: TEST_MODEL_OVERRIDES });
		const result = await runner.run(root.id, 1, {
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
		expect(calls).toEqual([`step.start:1:${leaf.id}`, "line::L1", "line::L2", "step.end:success"]);
	});
});

describe("resolveModelConfig", () => {
	test("resolves explicit model", () => {
		const cfg = resolveModelConfig({ model: "gpt-5.3-codex" });
		expect(cfg.cli).toBe("pi");
		expect(typeof cfg.provider).toBe("string");
		expect(cfg.model).toBe("gpt-5.3-codex");
		expect(typeof cfg.reasoning).toBe("string");
	});

	test("resolves provider-constrained model and preserves provider", () => {
		const { provider, modelId } = pickProviderModel();
		const cfg = resolveModelConfig({ model: modelId, provider });
		expect(cfg.provider).toBe(provider);
		expect(cfg.model).toBe(modelId);
	});

	test("resolves provider-only override and includes provider", () => {
		const { provider } = pickProviderModel();
		const authStub = { hasAuth: (p: string) => p === provider } as any;
		const cfg = resolveModelConfig({ provider }, authStub);
		expect(cfg.provider).toBe(provider);
	});

	test("throws for unknown model", () => {
		expect(() => resolveModelConfig({ model: "nonexistent-model-xyz" })).toThrow(/not found/);
	});

	test("passes explicit reasoning level through", () => {
		const cfg = resolveModelConfig({ model: "gpt-5.3-codex", reasoning: "medium" });
		expect(cfg.reasoning).toBe("medium");
	});
});
