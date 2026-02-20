import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@femtomc/mu";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-cli-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

async function writeConfigWithOperatorDefaults(dir: string, provider: string, model: string): Promise<void> {
	const configPath = join(dir, ".mu", "config.json");
	await mkdir(join(dir, ".mu"), { recursive: true });
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
						run_triggers_enabled: true,
						provider,
						model,
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
	const sessionDir = join(dir, ".mu", "operator", "sessions");
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
	for (const relPath of ["issues.jsonl", "forum.jsonl", "events.jsonl"] as const) {
		await readFile(join(dir, ".mu", relPath), "utf8");
	}

	const gitignore = await readFile(join(dir, ".mu", ".gitignore"), "utf8");
	expect(gitignore).toContain("*");
	expect(gitignore).toContain("!.gitignore");
	expect(await Bun.file(join(dir, ".mu", "roles", "orchestrator.md")).exists()).toBe(false);
	expect(await Bun.file(join(dir, ".mu", "roles", "worker.md")).exists()).toBe(false);
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
	expect(result.stdout.includes("Getting started")).toBe(true);
});

test("mu guide", async () => {
	const dir = await mkTempRepo();
	const result = await run(["guide"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.includes("Quickstart")).toBe(true);
	expect(result.stdout.includes("Command Overview")).toBe(true);
	expect(result.stdout.includes(".mu Store Layout")).toBe(true);
	expect(result.stdout.includes(".mu/")).toBe(true);
	expect(result.stdout.includes("mu store <subcmd>")).toBe(true);
	expect(result.stdout.includes("mu control diagnose-operator")).toBe(true);
	expect(result.stdout).toContain("Use direct CLI commands in chat (for example: mu control status, mu session list)");
	expect(result.stdout).not.toContain("/mu-setup");
});

test("mu store paths/ls/tail provide .mu navigation tools", async () => {
	const dir = await mkTempRepo();
	await mkdir(join(dir, ".mu", "control-plane"), { recursive: true });
	await writeFile(
		join(dir, ".mu", "control-plane", "operator_turns.jsonl"),
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

test("mu issues/forum help includes orchestrator + worker workflows", async () => {
	const dir = await mkTempRepo();

	const issuesHelp = await run(["issues", "--help"], { cwd: dir });
	expect(issuesHelp.exitCode).toBe(0);
	expect(issuesHelp.stdout).toContain("Worker flow");
	expect(issuesHelp.stdout).toContain("Orchestrator flow");
	expect(issuesHelp.stdout).toContain("Dependency semantics");
	expect(issuesHelp.stdout).toContain("mu issues dep <task-a> blocks <task-b>");

	const createHelp = await run(["issues", "create", "--help"], { cwd: dir });
	expect(createHelp.exitCode).toBe(0);
	expect(createHelp.stdout).toContain("--parent <id-or-prefix>");
	expect(createHelp.stdout).toContain("--role, -r <orchestrator|worker>");
	expect(createHelp.stdout).toContain(
		'mu issues create "Implement parser" --parent <root-id> --role worker --priority 2',
	);

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
	expect(forumPostHelp.stdout).toContain("--author worker");

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
	expect(payload.session_dir).toContain(".mu/operator/sessions");
	expect(payload.total).toBe(2);
	expect(payload.sessions.length).toBe(2);
	expect(payload.sessions.some((session) => session.id === "sess-alpha-11111111")).toBe(true);
	expect(payload.sessions.some((session) => session.id === "sess-beta-22222222")).toBe(true);
	expect(payload.sessions[0]?.rel_path).toContain(".mu/operator/sessions/");
});

test("mu session defaults to reconnecting most recent persisted operator session", async () => {
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
	expect(seenSessionMode).toBe("continue-recent");
	expect(seenSessionDir).toContain(".mu/operator/sessions");
	expect(seenSessionFile).toBeUndefined();
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

test("mu run auto-initializes store layout", async () => {
	const dir = await mkTempRepo();
	let seenSessionMode: string | undefined;
	let seenSessionDir: string | undefined;
	let seenSessionFile: string | undefined;
	const result = await run(["run", "hello", "--max-steps", "1"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			queueRun: async ({ maxSteps }) => ({
				job_id: "run-job-init",
				root_issue_id: "mu-root-init",
				max_steps: maxSteps,
				mode: "run_start",
				status: "running",
				source: "api",
			}),
			registerRunHeartbeat: async () => ({ program_id: "hb-init", created: true }),
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
	expect(seenSessionMode).toBe("continue-recent");
	expect(seenSessionDir).toContain(".mu/operator/sessions");
	expect(seenSessionFile).toBeUndefined();
	await expectStoreBootstrapped(dir);
});

test("mu run uses shared serve lifecycle and queues run + heartbeat before operator attach", async () => {
	const dir = await mkTempRepo();
	const events: string[] = [];
	let queuedArgs: {
		serverUrl: string;
		prompt: string;
		maxSteps: number;
		provider?: string;
		model?: string;
		reasoning?: string;
	} | null = null;
	let heartbeatRun: { job_id: string; root_issue_id: string | null; max_steps: number } | null = null;
	let seenOperator: { provider?: string; model?: string; thinking?: string } | null = null;
	const { io, chunks } = mkCaptureIo();

	const result = await run(
		[
			"run",
			"Ship",
			"release",
			"--max-steps",
			"7",
			"--provider",
			"openai-codex",
			"--model",
			"gpt-5.3-codex",
			"--reasoning",
			"high",
			"--port",
			"3311",
		],
		{
			cwd: dir,
			io,
			serveDeps: {
				spawnBackgroundServer: async ({ port }) => {
					events.push(`server:spawn:${port}`);
					return { pid: 99999, url: `http://localhost:${port}` };
				},
				queueRun: async (opts) => {
					events.push("run:queue");
					queuedArgs = opts;
					return {
						job_id: "run-job-1",
						root_issue_id: "mu-root1234",
						max_steps: opts.maxSteps,
						mode: "run_start",
						status: "running",
						source: "api",
					};
				},
				registerRunHeartbeat: async ({ run }) => {
					events.push("run:heartbeat");
					heartbeatRun = run;
					return { program_id: "hb-1", created: true };
				},
				runOperatorSession: async ({ onReady, provider, model, thinking }) => {
					events.push("operator:start");
					seenOperator = { provider, model, thinking };
					onReady();
					events.push("operator:end");
					return { stdout: "", stderr: "", exitCode: 0 };
				},
				registerSignalHandler: () => () => {},
			},
		},
	);

	expect(result.exitCode).toBe(0);
	// Server is NOT stopped — it runs in the background
	expect(events).toEqual(["server:spawn:3311", "run:queue", "run:heartbeat", "operator:start", "operator:end"]);
	expect(queuedArgs).toMatchObject({
		serverUrl: "http://localhost:3311",
		prompt: "Ship release",
		maxSteps: 7,
		provider: "openai-codex",
		model: "gpt-5.3-codex",
		reasoning: "high",
	});
	expect(heartbeatRun).toMatchObject({
		job_id: "run-job-1",
		root_issue_id: "mu-root1234",
		max_steps: 7,
	});
	expect(seenOperator!).toEqual({
		provider: "openai-codex",
		model: "gpt-5.3-codex",
		thinking: "high",
	});
	expect(chunks.stderr).toContain("Queued run: run-job-1 root=mu-root1234 max_steps=7");
	expect(chunks.stderr).toContain("Run heartbeat: registered (hb-1)");
});

test("mu run rejects removed --json/--raw-stream flows with recovery guidance", async () => {
	const dir = await mkTempRepo();
	const jsonMode = await run(["run", "hello", "--json"], { cwd: dir });
	expect(jsonMode.exitCode).toBe(1);
	expect(jsonMode.stdout).toContain("--json");
	expect(jsonMode.stdout).toContain("has been removed");
	expect(jsonMode.stdout).toContain("mu serve");

	const rawMode = await run(["run", "hello", "--raw-stream"], { cwd: dir });
	expect(rawMode.exitCode).toBe(1);
	expect(rawMode.stdout).toContain("--raw-stream");
	expect(rawMode.stdout).toContain("has been removed");
	expect(rawMode.stdout).toContain("mu resume <root-id> --raw-stream");
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
	const root = JSON.parse((await run(["issues", "create", "Root"], { cwd: dir })).stdout) as any;
	const a = JSON.parse((await run(["issues", "create", "Worker A"], { cwd: dir })).stdout) as any;
	const b = JSON.parse((await run(["issues", "create", "Worker B"], { cwd: dir })).stdout) as any;

	expect((await run(["issues", "dep", a.id, "parent", root.id], { cwd: dir })).exitCode).toBe(0);
	expect((await run(["issues", "dep", b.id, "parent", root.id], { cwd: dir })).exitCode).toBe(0);
	expect((await run(["issues", "dep", a.id, "blocks", b.id], { cwd: dir })).exitCode).toBe(0);

	const ready0 = JSON.parse((await run(["issues", "ready", "--root", root.id], { cwd: dir })).stdout) as any[];
	expect(ready0.map((issue) => issue.id)).toEqual([a.id]);

	expect((await run(["issues", "close", a.id, "--outcome", "success"], { cwd: dir })).exitCode).toBe(0);
	const ready1 = JSON.parse((await run(["issues", "ready", "--root", root.id], { cwd: dir })).stdout) as any[];
	expect(ready1.map((issue) => issue.id)).toEqual([b.id]);

	expect((await run(["issues", "close", b.id, "--outcome", "success"], { cwd: dir })).exitCode).toBe(0);
	const ready2 = JSON.parse((await run(["issues", "ready", "--root", root.id], { cwd: dir })).stdout) as any[];
	expect(ready2.map((issue) => issue.id)).toEqual([root.id]);

	expect((await run(["issues", "close", root.id, "--outcome", "success"], { cwd: dir })).exitCode).toBe(0);
	const ready3 = JSON.parse((await run(["issues", "ready", "--root", root.id], { cwd: dir })).stdout) as any[];
	expect(ready3).toHaveLength(0);
});

test("mu issues create outputs JSON and writes to store", async () => {
	const dir = await mkTempRepo();

	const created = await run(["issues", "create", "Hello"], { cwd: dir });
	expect(created.exitCode).toBe(0);

	const issue = JSON.parse(created.stdout) as any;
	expect(typeof issue.id).toBe("string");
	expect(issue.id.startsWith("mu-")).toBe(true);
	expect(issue.title).toBe("Hello");
	expect(issue.tags.includes("node:agent")).toBe(true);

	const text = await readFile(join(dir, ".mu", "issues.jsonl"), "utf8");
	const rows = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as any);
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(issue.id);

	const posted = await run(["forum", "post", `issue:${issue.id}`, "-m", "hello", "--author", "worker"], { cwd: dir });
	expect(posted.exitCode).toBe(0);

	const msg = JSON.parse(posted.stdout) as any;
	expect(msg).toMatchObject({ topic: `issue:${issue.id}`, body: "hello", author: "worker" });

	const forumText = await readFile(join(dir, ".mu", "forum.jsonl"), "utf8");
	expect(forumText.includes(`"topic":"issue:${issue.id}"`)).toBe(true);
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
	expect(seenSessionMode).toBe("continue-recent");
	expect(seenSessionDir).toContain(".mu/operator/sessions");
	expect(seenSessionFile).toBeUndefined();
	expect(chunks.stderr).toContain("started background server");
});

test("mu serve passes operator provider/model defaults from .mu/config.json to terminal operator session", async () => {
	const dir = await mkTempRepo();
	await writeConfigWithOperatorDefaults(dir, "openai-codex", "gpt-5.3-codex");

	let seenProvider: string | undefined;
	let seenModel: string | undefined;
	const result = await run(["serve", "--port", "3301"], {
		cwd: dir,
		serveDeps: {
			spawnBackgroundServer: async ({ port }) => ({ pid: 99999, url: `http://localhost:${port}` }),
			runOperatorSession: async ({ onReady, provider, model }) => {
				seenProvider = provider;
				seenModel = model;
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	expect(seenProvider).toBe("openai-codex");
	expect(seenModel).toBe("gpt-5.3-codex");
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
	await mkdir(join(dir, ".mu", "control-plane"), { recursive: true });
	// Write a server.json pointing to current PID (so process.kill(pid,0) succeeds)
	await writeFile(
		join(dir, ".mu", "control-plane", "server.json"),
		`${JSON.stringify({ pid: process.pid, port: 23456, url: "http://localhost:23456" })}\n`,
		"utf8",
	);

	let spawnCalls = 0;
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
				runOperatorSession: async ({ onReady }) => {
					onReady();
					return { stdout: "", stderr: "", exitCode: 0 };
				},
				registerSignalHandler: () => () => {},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spawnCalls).toBe(0);
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
