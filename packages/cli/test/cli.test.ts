import { expect, test } from "bun:test";
import { getStorePaths } from "@femtomc/mu-core/node";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@femtomc/mu";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-cli-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

function workspaceStoreDir(repoRoot: string): string {
	return getStorePaths(repoRoot).storeDir;
}

async function writeConfigWithOperatorDefaults(
	dir: string,
	provider: string,
	model: string,
	thinking?: string,
): Promise<void> {
	const storeDir = workspaceStoreDir(dir);
	const configPath = join(storeDir, "config.json");
	await mkdir(storeDir, { recursive: true });
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				version: 1,
				control_plane: {
					adapters: {
						slack: { signing_secret: null },
						discord: { signing_secret: null },
						telegram: { webhook_secret: null, bot_token: null, bot_username: null },
						neovim: { shared_secret: null },
					},
					operator: {
						enabled: true,
						provider,
						model,
						thinking: thinking ?? null,
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

async function writeOperatorSessionFile(
	dir: string,
	opts: { id: string; timestamp: string; message?: string },
): Promise<{ id: string; path: string }> {
	const sessionDir = join(workspaceStoreDir(dir), "operator", "sessions");
	await mkdir(sessionDir, { recursive: true });
	const filename = `${opts.timestamp.replace(/[:.]/g, "-")}_${opts.id}.jsonl`;
	const path = join(sessionDir, filename);
	const entries: Record<string, unknown>[] = [
		{
			type: "session",
			version: 3,
			id: opts.id,
			timestamp: opts.timestamp,
			cwd: dir,
		},
	];
	if (opts.message) {
		entries.push({
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: opts.timestamp,
			message: {
				role: "user",
				content: opts.message,
			},
		});
	}
	await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	return { id: opts.id, path };
}

async function expectStoreBootstrapped(dir: string): Promise<void> {
	const storeDir = workspaceStoreDir(dir);
	for (const relPath of ["issues.jsonl", "forum.jsonl", "events.jsonl"] as const) {
		await readFile(join(storeDir, relPath), "utf8");
	}

	const gitignore = await readFile(join(storeDir, ".gitignore"), "utf8");
	expect(gitignore).toContain("*");
	expect(gitignore).toContain("!.gitignore");
	expect(await Bun.file(join(storeDir, "roles", "operator.md")).exists()).toBe(false);
	expect(await Bun.file(join(storeDir, "roles", "soul.md")).exists()).toBe(false);
}

test("mu --help", async () => {
	const dir = await mkTempRepo();
	const result = await run(["--help"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.includes("Usage:")).toBe(true);
	expect(result.stdout.includes("mu <command>")).toBe(true);
	expect(result.stdout.includes("mu guide")).toBe(true);
	expect(result.stdout.includes("store <subcmd>")).toBe(true);
	expect(result.stdout.includes("serve")).toBe(true);
	expect(result.stdout.includes("session")).toBe(true);
	expect(result.stdout.includes("exec")).toBe(true);
	expect(result.stdout.includes("Getting started")).toBe(true);
	expect(result.stdout.includes("Agent quick navigation")).toBe(true);
	expect(result.stdout.includes("mu memory index status")).toBe(true);
});

test("mu guide", async () => {
	const dir = await mkTempRepo();
	const result = await run(["guide"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.includes("Quickstart")).toBe(true);
	expect(result.stdout.includes("Command Overview")).toBe(true);
	expect(result.stdout.includes("Workspace Store Layout")).toBe(true);
	expect(result.stdout.includes("~/.mu/workspaces/")).toBe(true);
	expect(result.stdout.includes("mu store <subcmd>")).toBe(true);
	expect(result.stdout.includes("mu control diagnose-operator")).toBe(true);
	expect(result.stdout.includes("Agent Navigation (by intent)")).toBe(true);
	expect(result.stdout.includes("mu memory index status")).toBe(true);
	expect(result.stdout.includes("mu exec <prompt...>")).toBe(true);
	expect(result.stdout).toContain("Removed engine commands");
	expect(result.stdout).not.toContain("/mu-setup");
});

test("mu memory help surfaces filters, timeline anchors, and index workflows", async () => {
	const dir = await mkTempRepo();

	const memoryHelp = await run(["memory", "--help"], { cwd: dir });
	expect(memoryHelp.exitCode).toBe(0);
	expect(memoryHelp.stdout).toContain("Common filters:");
	expect(memoryHelp.stdout).toContain("Timeline note:");
	expect(memoryHelp.stdout).toContain("mu memory index <status|rebuild>");

	const indexHelp = await run(["memory", "index", "--help"], { cwd: dir });
	expect(indexHelp.exitCode).toBe(0);
	expect(indexHelp.stdout).toContain("Rebuild filters:");
	expect(indexHelp.stdout).toContain("mu memory index rebuild --sources issues,forum,events");

	const contextAliasHelp = await run(["context", "--help"], { cwd: dir });
	expect(contextAliasHelp.exitCode).toBe(0);
	expect(contextAliasHelp.stdout).toContain("mu memory - cross-store memory retrieval + index management");
	expect(contextAliasHelp.stdout).toContain("`mu context ...` remains available as an alias to `mu memory ...`.");
});

test("mu heartbeats help surfaces telegram setup and subcommand guidance", async () => {
	const dir = await mkTempRepo();

	const rootHelp = await run(["heartbeats", "--help"], { cwd: dir });
	expect(rootHelp.exitCode).toBe(0);
	expect(rootHelp.stdout).toContain("Telegram quick setup:");
	expect(rootHelp.stdout).toContain("mu control link --channel telegram --actor-id <chat-id> --tenant-id telegram-bot");
	expect(rootHelp.stdout).toContain("Run `mu heartbeats <subcommand> --help`");

	const createHelp = await run(["heartbeats", "create", "--help"], { cwd: dir });
	expect(createHelp.exitCode).toBe(0);
	expect(createHelp.stdout).toContain("mu heartbeats create - create a heartbeat program");
	expect(createHelp.stdout).toContain("--prompt <text>");
	expect(createHelp.stdout).toContain("--every-ms N");
	expect(createHelp.stdout).toContain("Telegram prerequisites:");

	const listHelp = await run(["heartbeats", "list", "--help"], { cwd: dir });
	expect(listHelp.exitCode).toBe(0);
	expect(listHelp.stdout).toContain("--enabled true|false");
	expect(listHelp.stdout).toContain("--limit N");
});

test("mu command-group help is self-explanatory across events/cron/control/turn/replay", async () => {
	const dir = await mkTempRepo();

	const checks: Array<{ argv: string[]; contains: string[] }> = [
		{
			argv: ["events", "--help"],
			contains: ["Subcommands:", "Examples:", "mu events <subcommand> --help"],
		},
		{
			argv: ["events", "list", "--help"],
			contains: ["mu events list - bounded event listing", "--type TYPE", "Examples:"],
		},
		{
			argv: ["events", "trace", "--help"],
			contains: ["mu events trace - deeper bounded trace view", "Defaults:", "--limit 40"],
		},
		{
			argv: ["cron", "--help"],
			contains: ["Commands:", "Examples:", "mu cron <subcommand> --help"],
		},
		{
			argv: ["cron", "create", "--help"],
			contains: ["mu cron create - create a cron program", "Schedule flags:", "--expr <cron-expr>"],
		},
		{
			argv: ["cron", "trigger", "--help"],
			contains: ["mu cron trigger - trigger a cron program immediately", "--reason <text>"],
		},
		{
			argv: ["control", "--help"],
			contains: ["Examples:", "mu control <subcommand> --help", "operator"],
		},
		{
			argv: ["control", "operator", "models", "--help"],
			contains: ["mu control operator models - list provider model catalogs", "Usage:", "Examples:"],
		},
		{
			argv: ["control", "operator", "set", "--help"],
			contains: ["mu control operator set - set provider/model/thinking defaults", "Usage:", "workspace config.json"],
		},
		{
			argv: ["turn", "--help"],
			contains: [
				"mu turn - inject one prompt turn",
				"Examples:",
				"--session-id <id> --body <text>",
				"defaults to control-plane operator sessions",
			],
		},
		{
			argv: ["exec", "--help"],
			contains: ["one-shot operator prompt", "durable workflows", "mu exec <prompt...>"],
		},
		{
			argv: ["replay", "--help"],
			contains: ["Target resolution:", "Examples:", "<root-id>/<issue-id-or-log-file>"],
		},
	];

	for (const check of checks) {
		const result = await run(check.argv, { cwd: dir });
		expect(result.exitCode).toBe(0);
		for (const token of check.contains) {
			expect(result.stdout).toContain(token);
		}
	}
});

test("mu store paths/ls/tail provide workspace-store navigation tools", async () => {
	const dir = await mkTempRepo();
	const storeDir = workspaceStoreDir(dir);
	await mkdir(join(storeDir, "control-plane"), { recursive: true });
	await writeFile(
		join(storeDir, "control-plane", "operator_turns.jsonl"),
		`${JSON.stringify({
			kind: "operator.turn",
			ts_ms: 123,
			repo_root: dir,
			channel: "telegram",
			request_id: "req-1",
			session_id: "session-1",
			turn_id: "turn-1",
			outcome: "invalid_directive",
			reason: "operator_empty_response",
			message_preview: null,
			command: null,
		})}\n`,
		"utf8",
	);

	const paths = await run(["store", "paths"], { cwd: dir });
	expect(paths.exitCode).toBe(0);
	expect(paths.stdout).toContain("cp_operator_turns");
	expect(paths.stdout).toContain("control-plane/operator_turns.jsonl");

	const lsJson = await run(["store", "ls", "--all", "--json", "--pretty"], { cwd: dir });
	expect(lsJson.exitCode).toBe(0);
	const lsPayload = JSON.parse(lsJson.stdout) as {
		files: Array<{ key: string; exists: boolean }>;
	};
	expect(lsPayload.files.some((f) => f.key === "issues")).toBe(true);
	expect(lsPayload.files.some((f) => f.key === "cp_operator_turns" && f.exists)).toBe(true);

	const tailJson = await run(["store", "tail", "cp_operator_turns", "--limit", "1", "--json", "--pretty"], {
		cwd: dir,
	});
	expect(tailJson.exitCode).toBe(0);
	const tailPayload = JSON.parse(tailJson.stdout) as {
		returned: number;
		entries: Array<{ kind: string; outcome: string }>;
	};
	expect(tailPayload.returned).toBe(1);
	expect(tailPayload.entries[0]?.kind).toBe("operator.turn");
	expect(tailPayload.entries[0]?.outcome).toBe("invalid_directive");
});

test("mu control diagnose-operator reports missing audit with actionable hints", async () => {
	const dir = await mkTempRepo();
	const result = await run(["control", "diagnose-operator", "--json", "--pretty"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	const payload = JSON.parse(result.stdout) as {
		operator_turn_audit: { exists: boolean };
		hints: string[];
	};
	expect(payload.operator_turn_audit.exists).toBe(false);
	expect(payload.hints.some((hint) => hint.includes("operator_turns.jsonl is missing"))).toBe(true);
});

test("mu control operator set persists config and reports live reload status", async () => {
	const dir = await mkTempRepo();

	const modelsResult = await run(["control", "operator", "models", "--json", "--pretty"], { cwd: dir });
	expect(modelsResult.exitCode).toBe(0);
	const catalog = JSON.parse(modelsResult.stdout) as {
		providers: Array<{
			provider: string;
			models: Array<{ id: string; thinking_levels: string[] }>;
		}>;
	};
	const providerEntry = catalog.providers.find((entry) => entry.models.length > 0);
	expect(providerEntry).toBeTruthy();
	if (!providerEntry) {
		throw new Error("expected at least one provider with models");
	}
	const modelEntry = providerEntry.models[0]!;
	const thinking =
		modelEntry.thinking_levels.find((level) => level === "xhigh") ??
		modelEntry.thinking_levels.find((level) => level === "high") ??
		modelEntry.thinking_levels[modelEntry.thinking_levels.length - 1] ??
		"minimal";

	const setResult = await run(
		["control", "operator", "set", providerEntry.provider, modelEntry.id, thinking, "--json", "--pretty"],
		{ cwd: dir },
	);
	expect(setResult.exitCode).toBe(0);
	const payload = JSON.parse(setResult.stdout) as {
		ok: boolean;
		operator: { provider: string | null; model: string | null; thinking: string | null };
		reload: { attempted: boolean; ok: boolean; message: string };
	};
	expect(payload.ok).toBe(true);
	expect(payload.operator.provider).toBe(providerEntry.provider);
	expect(payload.operator.model).toBe(modelEntry.id);
	expect(payload.operator.thinking).toBe(thinking);
	expect(payload.reload.attempted).toBe(false);

	const config = JSON.parse(await readFile(join(workspaceStoreDir(dir), "config.json"), "utf8")) as {
		control_plane: {
			operator: { provider: string | null; model: string | null; thinking: string | null };
		};
	};
	expect(config.control_plane.operator.provider).toBe(providerEntry.provider);
	expect(config.control_plane.operator.model).toBe(modelEntry.id);
	expect(config.control_plane.operator.thinking).toBe(thinking);
});

test("mu init is disabled", async () => {
	const dir = await mkTempRepo();

	const help = await run(["--help"], { cwd: dir });
	expect(help.exitCode).toBe(0);
	expect(help.stdout).not.toContain("init [--force]");

	const initCmd = await run(["init"], { cwd: dir });
	expect(initCmd.exitCode).toBe(1);

	const statusHelp = await run(["status", "--help"], { cwd: dir });
	expect(statusHelp.exitCode).toBe(0);
	expect(statusHelp.stdout).toContain("--json");
	expect(statusHelp.stdout).toContain("--pretty");
	expect(statusHelp.stdout).toContain("If counts look wrong");
});

test("mu issues/forum help reflects operator-first workflows", async () => {
	const dir = await mkTempRepo();

	const issuesHelp = await run(["issues", "--help"], { cwd: dir });
	expect(issuesHelp.exitCode).toBe(0);
	expect(issuesHelp.stdout).toContain("Operator flow");
	expect(issuesHelp.stdout).toContain("Planning flow");
	expect(issuesHelp.stdout).toContain("Dependency semantics");
	expect(issuesHelp.stdout).toContain("mu issues dep <task-a> blocks <task-b>");

	const createHelp = await run(["issues", "create", "--help"], { cwd: dir });
	expect(createHelp.exitCode).toBe(0);
	expect(createHelp.stdout).toContain("--parent <id-or-prefix>");
	expect(createHelp.stdout).not.toContain("--role");
	expect(createHelp.stdout).toContain('mu issues create "Implement parser" --parent <root-id> --priority 2');

	const depHelp = await run(["issues", "dep", "--help"], { cwd: dir });
	expect(depHelp.exitCode).toBe(0);
	expect(depHelp.stdout).toContain("<src> blocks <dst>");
	expect(depHelp.stdout).toContain("<child> parent <root>");

	const forumHelp = await run(["forum", "--help"], { cwd: dir });
	expect(forumHelp.exitCode).toBe(0);
	expect(forumHelp.stdout).toContain("Common topic patterns:");
	expect(forumHelp.stdout).toContain("issue:<id>");
	expect(forumHelp.stdout).toContain("mu forum topics --prefix issue: --limit 20");

	const forumPostHelp = await run(["forum", "post", "--help"], { cwd: dir });
	expect(forumPostHelp.exitCode).toBe(0);
	expect(forumPostHelp.stdout).toContain("--author <NAME>");
	expect(forumPostHelp.stdout).toContain("--author operator");

	const forumReadHelp = await run(["forum", "read", "--help"], { cwd: dir });
	expect(forumReadHelp.exitCode).toBe(0);
	expect(forumReadHelp.stdout).toContain("--limit <N>");
	expect(forumReadHelp.stdout).toContain("mu forum read issue:<id>");

	const forumTopicsHelp = await run(["forum", "topics", "--help"], { cwd: dir });
	expect(forumTopicsHelp.exitCode).toBe(0);
	expect(forumTopicsHelp.stdout).toContain("--prefix <PREFIX>");
	expect(forumTopicsHelp.stdout).toContain("mu forum topics --prefix issue:");
});

test("mu chat removed - returns unknown command", async () => {
	const dir = await mkTempRepo();
	const chatResult = await run(["chat"], { cwd: dir });
	expect(chatResult.exitCode).toBe(1);
	expect(chatResult.stdout).toContain("unknown command");
});

test("mu exec runs one-shot operator prompt without queuing orchestration", async () => {
	const dir = await mkTempRepo();
	const factoryCalls: Array<{ cwd: string; provider?: string; model?: string; thinking?: string }> = [];
	let seenPrompt = "";
	let disposed = false;

	const result = await run(["exec", "summarize", "ready", "issues"], {
		cwd: dir,
		operatorSessionFactory: async (opts) => {
			factoryCalls.push({
				cwd: opts.cwd,
				provider: opts.provider,
				model: opts.model,
				thinking: opts.thinking,
			});
			let listener: ((event: unknown) => void) | null = null;
			return {
				subscribe(next: (event: unknown) => void) {
					listener = next;
					return () => {
						if (listener === next) {
							listener = null;
						}
					};
				},
				prompt: async (text: string) => {
					seenPrompt = text;
					listener?.({
						type: "message_end",
						message: { role: "assistant", text: "exec-ok" },
					});
				},
				dispose: () => {
					disposed = true;
				},
				bindExtensions: async () => {},
				agent: { waitForIdle: async () => {} },
			};
		},
	});

	expect(result.exitCode).toBe(0);
	expect(seenPrompt).toBe("summarize ready issues");
	expect(result.stdout).toBe("exec-ok\n");
	expect(disposed).toBe(true);
	expect(factoryCalls).toHaveLength(1);
	expect(factoryCalls[0]?.cwd).toBe(dir);
});

test("mu exec help and empty invocation", async () => {
	const dir = await mkTempRepo();
	const help = await run(["exec", "--help"], { cwd: dir });
	expect(help.exitCode).toBe(0);
	expect(help.stdout).toContain("one-shot operator prompt");
	expect(help.stdout).toContain("durable workflows");

	const empty = await run(["exec"], { cwd: dir });
	expect(empty.exitCode).toBe(0);
	expect(empty.stdout).toContain("one-shot operator prompt");
});

test("mu serve help text", async () => {
	const dir = await mkTempRepo();
	const serveHelp = await run(["serve", "--help"], { cwd: dir });
	expect(serveHelp.exitCode).toBe(0);
	expect(serveHelp.stdout).toContain("start background server + attach terminal operator session");
	expect(serveHelp.stdout).toContain("--port");
	expect(serveHelp.stdout).toContain("Use direct CLI commands in the operator session for capability discovery");
	expect(serveHelp.stdout).toContain("Use `mu session` to reconnect");
	expect(serveHelp.stdout).not.toContain("/mu-setup");
	expect(serveHelp.stdout.includes("--api-port")).toBe(false);
});

test("mu session list reports persisted operator sessions", async () => {
	const dir = await mkTempRepo();
	await writeOperatorSessionFile(dir, {
		id: "sess-alpha-11111111",
		timestamp: "2026-02-19T12:00:00.000Z",
		message: "first",
	});
	await writeOperatorSessionFile(dir, {
		id: "sess-beta-22222222",
		timestamp: "2026-02-19T13:00:00.000Z",
		message: "second",
	});

	const result = await run(["session", "list", "--json", "--pretty"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	const payload = JSON.parse(result.stdout) as {
		session_dir: string;
		total: number;
		sessions: Array<{ id: string; rel_path: string }>;
	};
	expect(payload.session_dir).toBe(join(workspaceStoreDir(dir), "operator", "sessions"));
	expect(payload.total).toBe(2);
	expect(payload.sessions.length).toBe(2);
	expect(payload.sessions.some((session) => session.id === "sess-alpha-11111111")).toBe(true);
	expect(payload.sessions.some((session) => session.id === "sess-beta-22222222")).toBe(true);
	expect(payload.sessions[0]?.rel_path).toContain("operator/sessions/");
});

test("mu session defaults to a new operator session when no persisted sessions exist", async () => {
	const dir = await mkTempRepo();
	let seenSessionMode: string | undefined;
	let seenSessionDir: string | undefined;
	let seenSessionFile: string | undefined;
	const result = await run(["session", "--port", "3310"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: async ({ onReady, sessionMode, sessionDir, sessionFile }) => {
				seenSessionMode = sessionMode;
				seenSessionDir = sessionDir;
				seenSessionFile = sessionFile;
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	expect(seenSessionMode).toBe("new");
	expect(seenSessionDir).toBe(join(workspaceStoreDir(dir), "operator", "sessions"));
	expect(seenSessionFile).toBeUndefined();
});

test("mu session defaults to opening the most recent persisted operator session when available", async () => {
	const dir = await mkTempRepo();
	await writeOperatorSessionFile(dir, {
		id: "sess-old-11111111",
		timestamp: "2026-02-19T10:00:00.000Z",
		message: "older",
	});
	const newest = await writeOperatorSessionFile(dir, {
		id: "sess-new-22222222",
		timestamp: "2026-02-19T11:00:00.000Z",
		message: "newer",
	});

	let seenSessionMode: string | undefined;
	let seenSessionDir: string | undefined;
	let seenSessionFile: string | undefined;
	const result = await run(["session", "--port", "3310"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: async ({ onReady, sessionMode, sessionDir, sessionFile }) => {
				seenSessionMode = sessionMode;
				seenSessionDir = sessionDir;
				seenSessionFile = sessionFile;
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	expect(seenSessionMode).toBe("open");
	expect(seenSessionDir).toBe(join(workspaceStoreDir(dir), "operator", "sessions"));
	expect(seenSessionFile).toBe(newest.path);
});

test("mu session <id-prefix> resolves and opens a specific persisted operator session", async () => {
	const dir = await mkTempRepo();
	const persisted = await writeOperatorSessionFile(dir, {
		id: "sess-open-33333333",
		timestamp: "2026-02-19T14:00:00.000Z",
		message: "resume me",
	});

	let seenSessionMode: string | undefined;
	let seenSessionFile: string | undefined;
	const result = await run(["session", "sess-open-333", "--port", "3311"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: async ({ onReady, sessionMode, sessionFile }) => {
				seenSessionMode = sessionMode;
				seenSessionFile = sessionFile;
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	expect(seenSessionMode).toBe("open");
	expect(seenSessionFile).toBe(persisted.path);
});


test("mu serve auto-initializes store layout", async () => {
	const dir = await mkTempRepo();
	const result = await run(["serve", "--port", "3309"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: async ({ onReady }) => {
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	await expectStoreBootstrapped(dir);
});

test("mu issues ready preserves DAG scheduling semantics", async () => {
	const dir = await mkTempRepo();
	const root = JSON.parse((await run(["issues", "create", "Root", "--json"], { cwd: dir })).stdout) as any;
	const a = JSON.parse((await run(["issues", "create", "Worker A", "--json"], { cwd: dir })).stdout) as any;
	const b = JSON.parse((await run(["issues", "create", "Worker B", "--json"], { cwd: dir })).stdout) as any;

	expect((await run(["issues", "dep", a.id, "parent", root.id], { cwd: dir })).exitCode).toBe(0);
	expect((await run(["issues", "dep", b.id, "parent", root.id], { cwd: dir })).exitCode).toBe(0);
	expect((await run(["issues", "dep", a.id, "blocks", b.id], { cwd: dir })).exitCode).toBe(0);

	const ready0 = JSON.parse((await run(["issues", "ready", "--root", root.id, "--json"], { cwd: dir })).stdout) as any[];
	expect(ready0.map((issue) => issue.id)).toEqual([a.id]);

	expect((await run(["issues", "close", a.id, "--outcome", "success"], { cwd: dir })).exitCode).toBe(0);
	const ready1 = JSON.parse((await run(["issues", "ready", "--root", root.id, "--json"], { cwd: dir })).stdout) as any[];
	expect(ready1.map((issue) => issue.id)).toEqual([b.id]);

	expect((await run(["issues", "close", b.id, "--outcome", "success"], { cwd: dir })).exitCode).toBe(0);
	const ready2 = JSON.parse((await run(["issues", "ready", "--root", root.id, "--json"], { cwd: dir })).stdout) as any[];
	expect(ready2.map((issue) => issue.id)).toEqual([root.id]);

	expect((await run(["issues", "close", root.id, "--outcome", "success"], { cwd: dir })).exitCode).toBe(0);
	const ready3 = JSON.parse((await run(["issues", "ready", "--root", root.id, "--json"], { cwd: dir })).stdout) as any[];
	expect(ready3).toHaveLength(0);
});

test("mu issues create outputs JSON and writes to store", async () => {
	const dir = await mkTempRepo();

	const created = await run(["issues", "create", "Hello", "--json"], { cwd: dir });
	expect(created.exitCode).toBe(0);

	const issue = JSON.parse(created.stdout) as any;
	expect(typeof issue.id).toBe("string");
	expect(issue.id.startsWith("mu-")).toBe(true);
	expect(issue.title).toBe("Hello");
	expect(issue.tags.includes("node:agent")).toBe(true);

	const text = await readFile(join(workspaceStoreDir(dir), "issues.jsonl"), "utf8");
	const rows = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as any);
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(issue.id);

	const posted = await run(["forum", "post", `issue:${issue.id}`, "-m", "hello", "--author", "operator", "--json"], { cwd: dir });
	expect(posted.exitCode).toBe(0);

	const msg = JSON.parse(posted.stdout) as any;
	expect(msg).toMatchObject({ topic: `issue:${issue.id}`, body: "hello", author: "operator" });

	const forumText = await readFile(join(workspaceStoreDir(dir), "forum.jsonl"), "utf8");
	expect(forumText.includes(`"topic":"issue:${issue.id}"`)).toBe(true);
});

test("mu issue/forum/event read interfaces default to compact output with opt-in --json", async () => {
	const dir = await mkTempRepo();
	const created = await run(["issues", "create", "Compact defaults", "--json"], { cwd: dir });
	expect(created.exitCode).toBe(0);
	const issue = JSON.parse(created.stdout) as { id: string };

	const readyCompact = await run(["issues", "ready"], { cwd: dir });
	expect(readyCompact.exitCode).toBe(0);
	expect(readyCompact.stdout).toContain("STATUS");
	expect(readyCompact.stdout).toContain("TITLE");
	expect(readyCompact.stdout).toContain(issue.id.slice(0, 10));

	const readyJson = await run(["issues", "ready", "--json"], { cwd: dir });
	expect(readyJson.exitCode).toBe(0);
	const readyRows = JSON.parse(readyJson.stdout) as Array<{ id: string }>;
	expect(readyRows.some((row) => row.id === issue.id)).toBe(true);

	expect((await run(["forum", "post", `issue:${issue.id}`, "-m", "first line\nsecond line"], { cwd: dir })).exitCode).toBe(0);

	const forumCompact = await run(["forum", "read", `issue:${issue.id}`], { cwd: dir });
	expect(forumCompact.exitCode).toBe(0);
	expect(forumCompact.stdout).toContain(`Topic: issue:${issue.id}`);
	expect(forumCompact.stdout).toContain("AUTHOR");

	const forumJson = await run(["forum", "read", `issue:${issue.id}`, "--json"], { cwd: dir });
	expect(forumJson.exitCode).toBe(0);
	const forumRows = JSON.parse(forumJson.stdout) as Array<{ topic: string }>;
	expect(forumRows.some((row) => row.topic === `issue:${issue.id}`)).toBe(true);

	const topicsCompact = await run(["forum", "topics", "--prefix", "issue:"], { cwd: dir });
	expect(topicsCompact.exitCode).toBe(0);
	expect(topicsCompact.stdout).toContain("TOPIC");
	expect(topicsCompact.stdout).toContain("MSG");

	const topicsJson = await run(["forum", "topics", "--prefix", "issue:", "--json"], { cwd: dir });
	expect(topicsJson.exitCode).toBe(0);
	const topicRows = JSON.parse(topicsJson.stdout) as Array<{ topic: string }>;
	expect(topicRows.some((row) => row.topic === `issue:${issue.id}`)).toBe(true);

	const eventsCompact = await run(["events", "list", "--limit", "10"], { cwd: dir });
	expect(eventsCompact.exitCode).toBe(0);
	expect(eventsCompact.stdout).toContain("Events:");
	expect(eventsCompact.stdout).toContain("TYPE");

	const eventsJson = await run(["events", "list", "--limit", "10", "--json"], { cwd: dir });
	expect(eventsJson.exitCode).toBe(0);
	const eventsPayload = JSON.parse(eventsJson.stdout) as { count: number; events: Array<{ type: string }> };
	expect(eventsPayload.count).toBeGreaterThan(0);
	expect(eventsPayload.events.length).toBeGreaterThan(0);
});

test("mu issue/forum mutation interfaces default to compact output with opt-in --json", async () => {
	const dir = await mkTempRepo();

	const createCompact = await run(["issues", "create", "Mutation compact"], { cwd: dir });
	expect(createCompact.exitCode).toBe(0);
	expect(createCompact.stdout).toContain("created:");
	const createdId = /created:\s+(mu-[a-z0-9]+)/i.exec(createCompact.stdout)?.[1];
	expect(createdId).toBeTruthy();
	if (!createdId) throw new Error("missing created issue id in compact output");

	const updateCompact = await run(["issues", "update", createdId, "--status", "in_progress"], { cwd: dir });
	expect(updateCompact.exitCode).toBe(0);
	expect(updateCompact.stdout).toContain("updated:");

	const updateJson = await run(["issues", "update", createdId, "--status", "open", "--json"], { cwd: dir });
	expect(updateJson.exitCode).toBe(0);
	expect((JSON.parse(updateJson.stdout) as { status: string }).status).toBe("open");

	const claimCompact = await run(["issues", "claim", createdId], { cwd: dir });
	expect(claimCompact.exitCode).toBe(0);
	expect(claimCompact.stdout).toContain("claimed:");

	const closeCompact = await run(["issues", "close", createdId], { cwd: dir });
	expect(closeCompact.exitCode).toBe(0);
	expect(closeCompact.stdout).toContain("closed:");

	const closeJson = await run(["issues", "close", createdId, "--outcome", "success", "--json"], { cwd: dir });
	expect(closeJson.exitCode).toBe(0);
	expect((JSON.parse(closeJson.stdout) as { status: string }).status).toBe("closed");

	const depTarget = JSON.parse((await run(["issues", "create", "Dep target", "--json"], { cwd: dir })).stdout) as {
		id: string;
	};
	const depCompact = await run(["issues", "dep", depTarget.id, "blocks", createdId], { cwd: dir });
	expect(depCompact.exitCode).toBe(0);
	expect(depCompact.stdout).toContain("dep added:");

	const depJson = await run(["issues", "dep", depTarget.id, "parent", createdId, "--json"], { cwd: dir });
	expect(depJson.exitCode).toBe(0);
	expect((JSON.parse(depJson.stdout) as { ok: boolean; type: string }).ok).toBe(true);

	const undepCompact = await run(["issues", "undep", depTarget.id, "blocks", createdId], { cwd: dir });
	expect(undepCompact.exitCode).toBe(0);
	expect(undepCompact.stdout).toContain("dep removed:");

	const postCompact = await run(["forum", "post", `issue:${createdId}`, "-m", "mutation update", "--author", "operator"], {
		cwd: dir,
	});
	expect(postCompact.exitCode).toBe(0);
	expect(postCompact.stdout).toContain("posted:");

	const postJson = await run(["forum", "post", `issue:${createdId}`, "-m", "json post", "--json"], { cwd: dir });
	expect(postJson.exitCode).toBe(0);
	expect((JSON.parse(postJson.stdout) as { topic: string }).topic).toBe(`issue:${createdId}`);
});

function mkSignalHarness(): {
	register: (signal: NodeJS.Signals, handler: () => void) => () => void;
	emit: (signal: NodeJS.Signals) => void;
	ready: Promise<void>;
} {
	const handlers = new Map<NodeJS.Signals, Set<() => void>>();
	let registrationCount = 0;
	let resolveReady: (() => void) | null = null;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	return {
		register: (signal, handler) => {
			let set = handlers.get(signal);
			if (!set) {
				set = new Set();
				handlers.set(signal, set);
			}
			set.add(handler);
			registrationCount += 1;
			if (registrationCount >= 2) {
				resolveReady?.();
				resolveReady = null;
			}
			return () => {
				set?.delete(handler);
			};
		},
		emit: (signal) => {
			const set = handlers.get(signal);
			if (!set) {
				return;
			}
			for (const handler of [...set]) {
				handler();
			}
		},
		ready,
	};
}

function mkCaptureIo(): {
	io: { stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } };
	chunks: { stdout: string; stderr: string };
} {
	const chunks = { stdout: "", stderr: "" };
	return {
		chunks,
		io: {
			stdout: {
				write: (s: string) => {
					chunks.stdout += s;
				},
			},
			stderr: {
				write: (s: string) => {
					chunks.stderr += s;
				},
			},
		},
	};
}

test("mu serve spawns background server, attaches TUI, and leaves server running on TUI exit", async () => {
	const dir = await mkTempRepo();
	const events: string[] = [];
	let seenSessionMode: string | undefined;
	let seenSessionDir: string | undefined;
	let seenSessionFile: string | undefined;
	const { io, chunks } = mkCaptureIo();
	const result = await run(["serve", "--port", "3300"], {
		cwd: dir,
		io,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => {
				events.push(`server:spawn:${port}`);
				return { pid: 99999, url: `http://localhost:${port}` };
			},
			runOperatorSession: async ({ onReady, sessionMode, sessionDir, sessionFile }) => {
				events.push("operator:start");
				seenSessionMode = sessionMode;
				seenSessionDir = sessionDir;
				seenSessionFile = sessionFile;
				onReady();
				events.push("operator:end");
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	// Server is NOT stopped when TUI exits — it's a background process
	expect(events).toEqual(["server:spawn:3300", "operator:start", "operator:end"]);
	expect(seenSessionMode).toBe("new");
	expect(seenSessionDir).toBe(join(workspaceStoreDir(dir), "operator", "sessions"));
	expect(seenSessionFile).toBeUndefined();
	expect(chunks.stderr).toContain("started background server");
});

test("mu serve passes operator provider/model/thinking defaults from workspace config.json to terminal operator session", async () => {
	const dir = await mkTempRepo();
	await writeConfigWithOperatorDefaults(dir, "openai-codex", "gpt-5.3-codex", "xhigh");

	let seenProvider: string | undefined;
	let seenModel: string | undefined;
	let seenThinking: string | undefined;
	const result = await run(["serve", "--port", "3301"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: async ({ onReady, provider, model, thinking }) => {
				seenProvider = provider;
				seenModel = model;
				seenThinking = thinking;
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	expect(seenProvider).toBe("openai-codex");
	expect(seenModel).toBe("gpt-5.3-codex");
	expect(seenThinking).toBe("xhigh");
});

test("mu serve surfaces operator-session startup failure (server keeps running)", async () => {
	const dir = await mkTempRepo();
	const { io, chunks } = mkCaptureIo();
	const result = await run(["serve", "--port", "3302"], {
		cwd: dir,
		io,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: async () => ({
				stdout: '{"error":"interactive operator session requires a TTY"}\n',
				stderr: "",
				exitCode: 1,
			}),
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("interactive operator session requires a TTY");
	expect(chunks.stderr).toContain("mu: operator terminal failed to connect.");
});

test("mu serve forwards SIGINT lifecycle and exits cleanly (server keeps running)", async () => {
	const dir = await mkTempRepo();
	const harness = mkSignalHarness();
	let operatorResolveFn: (() => void) | null = null;

	const servePromise = run(["serve", "--port", "3302"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: ({ onReady }) => {
				onReady();
				// Simulate a long-running operator session that resolves when we tell it to.
				return new Promise((resolve) => {
					operatorResolveFn = () => resolve({ stdout: "", stderr: "", exitCode: 0 });
				});
			},
			registerSignalHandler: harness.register,
		},
	});

	await harness.ready;
	// Simulate SIGINT; serve's signal handler races against operatorPromise.
	(operatorResolveFn as (() => void) | null)?.();
	harness.emit("SIGINT");

	const result = await servePromise;
	// Either operator session finishes first (exit 0) or signal wins (exit 130) — both valid.
	expect(result.exitCode === 0 || result.exitCode === 130).toBe(true);
});

test("mu serve reports server startup errors without launching operator session", async () => {
	const dir = await mkTempRepo();
	let operatorCalls = 0;
	const result = await run(["serve", "--port", "3303"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async () => {
				throw new Error("EADDRINUSE");
			},
			runOperatorSession: async () => {
				operatorCalls += 1;
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		},
	});

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("failed to start server");
	expect(result.stdout).toContain("EADDRINUSE");
	expect(operatorCalls).toBe(0);
});

test("mu serve reports startup failure when background server fails to spawn", async () => {
	const dir = await mkTempRepo();
	let operatorCalls = 0;
	const result = await run(["serve", "--port", "3306"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async () => {
				throw new Error("server did not become healthy within 15000ms");
			},
			runOperatorSession: async () => {
				operatorCalls += 1;
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		},
	});

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("failed to start server");
	expect(operatorCalls).toBe(0);
});

test("mu serve connects to existing server instead of spawning new one", async () => {
	const dir = await mkTempRepo();
	await mkdir(join(workspaceStoreDir(dir), "control-plane"), { recursive: true });
	// Write a server.json pointing to current PID (so process.kill(pid,0) succeeds)
	await writeFile(
		join(workspaceStoreDir(dir), "control-plane", "server.json"),
		`${JSON.stringify({ pid: process.pid, port: 23456, url: "http://localhost:23456" })}\n`,
		"utf8",
	);
	await writeOperatorSessionFile(dir, {
		id: "sess-existing-55555555",
		timestamp: "2026-02-19T16:00:00.000Z",
		message: "persisted",
	});

	let spawnCalls = 0;
	let seenSessionMode: string | undefined;
	const { io, chunks } = mkCaptureIo();

	// Mock fetch for health check
	const origFetch = globalThis.fetch;
	const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "http://localhost:23456/healthz") {
			return new Response("ok", { status: 200 });
		}
		return origFetch(input, init);
	};
	mockFetch.preconnect = origFetch.preconnect;
	globalThis.fetch = mockFetch;

	try {
		const result = await run(["serve", "--port", "3307"], {
			cwd: dir,
			io,
			serveDeps: {
				spawnBackgroundServer: async () => {
					spawnCalls += 1;
					return { pid: 99999, url: "http://localhost:3307" };
				},
				runOperatorSession: async ({ onReady, sessionMode }) => {
					seenSessionMode = sessionMode;
					onReady();
					return { stdout: "", stderr: "", exitCode: 0 };
				},
				registerSignalHandler: () => () => {},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spawnCalls).toBe(0);
		expect(seenSessionMode).toBe("new");
		expect(chunks.stderr).toContain("connecting to existing server");
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("mu stop --help shows usage", async () => {
	const dir = await mkTempRepo();
	const result = await run(["stop", "--help"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("mu stop");
	expect(result.stdout).toContain("--force");
});

test("mu stop errors when no server is running", async () => {
	const dir = await mkTempRepo();
	const result = await run(["stop"], { cwd: dir });
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("no running server found");
});
