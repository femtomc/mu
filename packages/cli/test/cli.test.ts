import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@femtomc/mu";
import { DEFAULT_OPERATOR_SYSTEM_PROMPT, type BackendRunner, type BackendRunOpts } from "@femtomc/mu-agent";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-cli-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("failed to resolve occupied port");
	}

	return {
		port: address.port,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) {
						reject(err);
						return;
					}
					resolve();
				});
			});
		},
	};
}

async function writeConfigWithActiveAdapter(dir: string): Promise<void> {
	const configPath = join(dir, ".mu", "config.json");
	await mkdir(join(dir, ".mu"), { recursive: true });
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				version: 1,
				control_plane: {
					adapters: {
						slack: { signing_secret: "slack-secret" },
						discord: { signing_secret: null },
						telegram: { webhook_secret: null, bot_token: null, bot_username: null },
						gmail: {
							enabled: false,
							webhook_secret: null,
							client_id: null,
							client_secret: null,
							refresh_token: null,
						},
					},
					operator: {
						enabled: false,
						run_triggers_enabled: false,
						provider: null,
						model: null,
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
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
						gmail: {
							enabled: false,
							webhook_secret: null,
							client_id: null,
							client_secret: null,
							refresh_token: null,
						},
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

function mkMockOperatorSessionFactory(response: string) {
	let promptCalls = 0;
	let lastPrompt = "";
	let lastFactoryOpts: {
		cwd: string;
		systemPrompt: string;
		provider?: string;
		model?: string;
		thinking?: string;
	} | null = null;
	const factory = async (opts: {
		cwd: string;
		systemPrompt: string;
		provider?: string;
		model?: string;
		thinking?: string;
	}) => {
		lastFactoryOpts = opts;
		const listeners = new Set<(event: any) => void>();
		return {
			subscribe: (listener: (event: any) => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			prompt: async (text: string) => {
				promptCalls += 1;
				lastPrompt = text;
				for (const listener of listeners) {
					listener({
						type: "message_end",
						message: { role: "assistant", text: response },
					});
				}
			},
			dispose: () => {},
			bindExtensions: async () => {},
			agent: { waitForIdle: async () => {} },
		};
	};
	return {
		factory,
		get promptCalls() {
			return promptCalls;
		},
		get lastPrompt() {
			return lastPrompt;
		},
		get lastFactoryOpts() {
			return lastFactoryOpts;
		},
	};
}

async function expectStoreBootstrapped(dir: string): Promise<void> {
	for (const relPath of ["issues.jsonl", "forum.jsonl", "events.jsonl"] as const) {
		await readFile(join(dir, ".mu", relPath), "utf8");
	}

	const orchestratorPrompt = await readFile(join(dir, ".mu", "roles", "orchestrator.md"), "utf8");
	const workerPrompt = await readFile(join(dir, ".mu", "roles", "worker.md"), "utf8");
	const gitignore = await readFile(join(dir, ".mu", ".gitignore"), "utf8");
	expect(orchestratorPrompt).toContain("# Mu Orchestrator");
	expect(workerPrompt).toContain("# Mu Worker");
	expect(gitignore).toContain("*");
	expect(gitignore).toContain("!.gitignore");
}

test("mu --help", async () => {
	const dir = await mkTempRepo();
	const result = await run(["--help"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.includes("Usage:")).toBe(true);
	expect(result.stdout.includes("mu <command>")).toBe(true);
	expect(result.stdout.includes("mu guide")).toBe(true);
	expect(result.stdout.includes("store <subcmd>")).toBe(true);
	expect(result.stdout.includes("chat [--message TEXT]")).toBe(true);
	expect(result.stdout.includes("Getting started")).toBe(true);
	expect(result.stdout.includes("Store discovery:")).toBe(true);
	expect(result.stdout.includes("Common workflow:")).toBe(true);
	expect(result.stdout.includes("When commands fail:")).toBe(true);
	expect(result.stdout.includes("mu replay <root-id>/<issue-id>")).toBe(true);
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
			reason: "operator_command_directive_invalid_json",
			message_preview: "MU_COMMAND: {\"kind\":\"run_start\",\"prompt\":}",
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

test("mu init is disabled and help still documents store layout", async () => {
	const dir = await mkTempRepo();

	const help = await run(["--help"], { cwd: dir });
	expect(help.exitCode).toBe(0);
	expect(help.stdout).toContain("Store discovery:");
	expect(help.stdout).toContain("State is stored at <repo-root>/.mu/");
	expect(help.stdout).not.toContain("init [--force]");

	const initCmd = await run(["init"], { cwd: dir });
	expect(initCmd.exitCode).toBe(1);
	expect(initCmd.stdout).toContain("`mu init` has been removed");

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

test("mu chat/serve help text", async () => {
	const dir = await mkTempRepo();

	const chatHelp = await run(["chat", "--help"], { cwd: dir });
	expect(chatHelp.exitCode).toBe(0);
	expect(chatHelp.stdout).toContain("interactive operator session");
	expect(chatHelp.stdout).toContain("--message");
	expect(chatHelp.stdout).toContain("--provider");
	expect(chatHelp.stdout).toContain("--system-prompt");

	const serveHelp = await run(["serve", "--help"], { cwd: dir });
	expect(serveHelp.exitCode).toBe(0);
	expect(serveHelp.stdout).toContain("start server + terminal operator session + web UI");
	expect(serveHelp.stdout).toContain("--port");
	expect(serveHelp.stdout.includes("--api-port")).toBe(false);
});

test("mu run auto-initializes store layout", async () => {
	const dir = await mkTempRepo();
	const backend: BackendRunner = { run: async () => 0 };

	const result = await run(["run", "hello", "--max-steps", "1", "--json"], { cwd: dir, backend });
	expect(result.exitCode).toBe(1);
	await expectStoreBootstrapped(dir);
});

test("mu serve auto-initializes store layout", async () => {
	const dir = await mkTempRepo();
	const result = await run(["serve", "--port", "3309", "--no-open"], {
		cwd: dir,
		serveDeps: {
			startServer: async () => ({
				activeAdapters: [],
				stop: async () => {},
			}),
			runOperatorSession: async ({ onReady }) => {
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
			isHeadless: () => true,
			openBrowser: () => {},
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

test("mu chat one-shot uses operator defaults in operatorSessionFactory", async () => {
	const dir = await mkTempRepo();
	const mock = mkMockOperatorSessionFactory("Hello from mu chat!");
	const result = await run(["chat", "--message", "hello"], {
		cwd: dir,
		operatorSessionFactory: mock.factory,
	});

	expect(result.exitCode).toBe(0);
	expect(mock.promptCalls).toBe(1);
	expect(mock.lastFactoryOpts?.systemPrompt).toBe(DEFAULT_OPERATOR_SYSTEM_PROMPT);
});

test("mu chat rejects empty message", async () => {
	const dir = await mkTempRepo();
	const result = await run(["chat", "--message", "   "], { cwd: dir });
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("message must not be empty");
});

test("mu chat --json requires --message", async () => {
	const dir = await mkTempRepo();
	const result = await run(["chat", "--json"], { cwd: dir });
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("--json requires --message");
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

test("mu serve starts server + terminal session and shuts both down on operator session exit", async () => {
	const dir = await mkTempRepo();
	const events: string[] = [];
	let stopCalls = 0;
	const { io, chunks } = mkCaptureIo();
	const result = await run(["serve", "--port", "3300", "--no-open"], {
		cwd: dir,
		io,
		serveDeps: {
			startServer: async ({ port }) => {
				events.push(`server:start:${port}`);
				return {
					activeAdapters: [],
					stop: async () => {
						stopCalls += 1;
						events.push("server:stop");
					},
				};
			},
			runOperatorSession: async ({ onReady }) => {
				events.push("operator:start");
				onReady();
				events.push("operator:end");
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
			isHeadless: () => true,
			openBrowser: () => {
				throw new Error("browser should not open in no-open mode");
			},
		},
	});

	expect(result.exitCode).toBe(0);
	expect(stopCalls).toBe(1);
	expect(events).toEqual(["server:start:3300", "operator:start", "operator:end", "server:stop"]);
	expect(chunks.stderr).toContain("Operator terminal: connecting");
	expect(chunks.stderr).toContain("Operator terminal: connected");
	expect(chunks.stderr).toContain("Operator terminal: disconnected");
	expect(chunks.stderr).toContain("mu server disconnected.");
});

test("mu serve passes operator provider/model defaults from .mu/config.json to terminal operator session", async () => {
	const dir = await mkTempRepo();
	await writeConfigWithOperatorDefaults(dir, "openai-codex", "gpt-5.3-codex");

	let seenProvider: string | undefined;
	let seenModel: string | undefined;
	let stopCalls = 0;
	const result = await run(["serve", "--port", "3301", "--no-open"], {
		cwd: dir,
		serveDeps: {
			startServer: async () => ({
				activeAdapters: [],
				stop: async () => {
					stopCalls += 1;
				},
			}),
			runOperatorSession: async ({ onReady, provider, model }) => {
				seenProvider = provider;
				seenModel = model;
				onReady();
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			registerSignalHandler: () => () => {},
			isHeadless: () => true,
			openBrowser: () => {},
		},
	});

	expect(result.exitCode).toBe(0);
	expect(stopCalls).toBe(1);
	expect(seenProvider).toBe("openai-codex");
	expect(seenModel).toBe("gpt-5.3-codex");
});

test("mu serve surfaces operator-session startup failure and still stops server", async () => {
	const dir = await mkTempRepo();
	let stopCalls = 0;
	const { io, chunks } = mkCaptureIo();
	const result = await run(["serve", "--port", "3302", "--no-open"], {
		cwd: dir,
		io,
		serveDeps: {
			startServer: async () => ({
				activeAdapters: [],
				stop: async () => {
					stopCalls += 1;
				},
			}),
			runOperatorSession: async () => ({
				stdout: '{"error":"interactive operator session requires a TTY"}\n',
				stderr: "",
				exitCode: 1,
			}),
			registerSignalHandler: () => () => {},
			isHeadless: () => true,
			openBrowser: () => {
				throw new Error("browser should not open in no-open mode");
			},
		},
	});

	expect(result.exitCode).toBe(1);
	expect(stopCalls).toBe(1);
	expect(result.stdout).toContain("interactive operator session requires a TTY");
	expect(chunks.stderr).toContain("Operator terminal: failed to connect.");
});

test("mu serve forwards SIGINT lifecycle and exits cleanly", async () => {
	const dir = await mkTempRepo();
	const harness = mkSignalHarness();
	let stopCalls = 0;
	let operatorResolveFn: (() => void) | null = null;

	const servePromise = run(["serve", "--port", "3302", "--no-open"], {
		cwd: dir,
		serveDeps: {
			startServer: async () => ({
				activeAdapters: [],
				stop: async () => {
					stopCalls += 1;
				},
			}),
			runOperatorSession: ({ onReady }) => {
				onReady();
				// Simulate a long-running operator session that resolves when we tell it to.
				return new Promise((resolve) => {
					operatorResolveFn = () => resolve({ stdout: "", stderr: "", exitCode: 0 });
				});
			},
			registerSignalHandler: harness.register,
			isHeadless: () => true,
			openBrowser: () => {
				throw new Error("browser should not open in no-open mode");
			},
		},
	});

	await harness.ready;
	// Simulate SIGINT; serve's signal handler races against operatorPromise.
	(operatorResolveFn as (() => void) | null)?.();
	harness.emit("SIGINT");

	const result = await servePromise;
	expect(stopCalls).toBe(1);
	// Either operator session finishes first (exit 0) or signal wins (exit 130) — both valid.
	expect(result.exitCode === 0 || result.exitCode === 130).toBe(true);
});

test("mu serve reports server startup errors without launching operator session", async () => {
	const dir = await mkTempRepo();
	let operatorCalls = 0;
	const result = await run(["serve", "--port", "3303", "--no-open"], {
		cwd: dir,
		serveDeps: {
			startServer: async () => {
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

test("mu serve releases control-plane writer lock when bind fails", async () => {
	const dir = await mkTempRepo();
	await writeConfigWithActiveAdapter(dir);

	const occupied = await occupyPort();
	try {
		let operatorCalls = 0;
		const result = await run(["serve", "--port", String(occupied.port), "--no-open"], {
			cwd: dir,
			serveDeps: {
				runOperatorSession: async () => {
					operatorCalls += 1;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("failed to start server");
		expect(operatorCalls).toBe(0);

		const lockPath = join(dir, ".mu", "control-plane", "writer.lock");
		expect(await Bun.file(lockPath).exists()).toBe(false);
	} finally {
		await occupied.close();
	}
});

test("mu run streams step headers + rendered assistant output (default human mode)", async () => {
	const dir = await mkTempRepo();
	const backend: BackendRunner = {
		run: async (opts: BackendRunOpts) => {
			// Emit pi-style JSON events; CLI should render assistant text deltas.
			opts.onLine?.(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}`);
			opts.onLine?.(`{"type":"message_end","message":{"role":"assistant"}}`);
			return 0;
		},
	};

	const { io, chunks } = mkCaptureIo();
	const result = await run(["run", "Hello", "--max-steps", "1"], { cwd: dir, io, backend });

	// The runner doesn't close the issue (stub backend), so the DagRunner marks failure.
	expect(result.exitCode).toBe(1);

	expect(chunks.stdout).toBe("Hello\n");
	expect(chunks.stderr.includes("Step 1/1")).toBe(true);
	expect(chunks.stderr.includes("role=")).toBe(true);
	expect(chunks.stderr.includes("Done 1/1")).toBe(true);
	expect(chunks.stderr.includes("outcome=failure")).toBe(true);
	expect(chunks.stderr.includes("Recovery:")).toBe(true);
	expect(chunks.stderr.includes("mu replay")).toBe(true);
});

test("mu run pretty TTY mode renders markdown + tool events", async () => {
	const dir = await mkTempRepo();
	const backend: BackendRunner = {
		run: async (opts: BackendRunOpts) => {
			opts.onLine?.(
				`{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"echo hi"}}`,
			);
			opts.onLine?.(`{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":[],"isError":false}`);
			opts.onLine?.(
				'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"# Hello\\n\\n- a\\n- b\\n\\n`code`\\n"}}',
			);
			opts.onLine?.(`{"type":"message_end","message":{"role":"assistant"}}`);
			return 0;
		},
	};

	const { io, chunks } = mkCaptureIo();
	// Mark these as TTY so the CLI switches into pretty rendering mode.
	(io.stdout as any).isTTY = true;
	(io.stderr as any).isTTY = true;

	const result = await run(["run", "Hello", "--max-steps", "1"], { cwd: dir, io, backend });
	expect(result.exitCode).toBe(1);

	// Tool events go to stderr and should be concise.
	expect(chunks.stderr.includes("bash")).toBe(true);
	expect(chunks.stderr.includes("echo hi")).toBe(true);

	// Assistant markdown should be rendered (no raw '# ' heading marker) and styled with ANSI.
	expect(chunks.stdout.includes("\u001b[")).toBe(process.env.NO_COLOR == null);
	const plain = chunks.stdout.replaceAll(new RegExp("\\u001b\\[[0-9;]*m", "g"), "");
	expect(plain.includes("# Hello")).toBe(false);
	expect(plain.includes("Hello")).toBe(true);
	expect(plain.includes("- a")).toBe(true);
	expect(plain.includes("code")).toBe(true);
});

test("mu run --raw-stream prints raw pi JSONL to stdout", async () => {
	const dir = await mkTempRepo();
	const backend: BackendRunner = {
		run: async (opts: BackendRunOpts) => {
			opts.onLine?.(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}`);
			opts.onLine?.(`{"type":"message_end","message":{"role":"assistant"}}`);
			return 0;
		},
	};

	const { io, chunks } = mkCaptureIo();
	const result = await run(["run", "Hello", "--max-steps", "1", "--raw-stream"], { cwd: dir, io, backend });
	expect(result.exitCode).toBe(1);

	expect(chunks.stdout.includes(`"type":"message_update"`)).toBe(true);
	expect(chunks.stdout.includes(`"type":"message_end"`)).toBe(true);
	// Raw stream should not be the rendered assistant text.
	expect(chunks.stdout).not.toBe("Hello\n");
});

test("mu run --json stays clean even when io is provided", async () => {
	const dir = await mkTempRepo();
	const backend: BackendRunner = { run: async () => 0 };
	const { io, chunks } = mkCaptureIo();
	const result = await run(["run", "Hello", "--max-steps", "1", "--json"], { cwd: dir, io, backend });

	expect(chunks.stdout).toBe("");
	expect(chunks.stderr).toBe("");

	const payload = JSON.parse(result.stdout) as any;
	expect(payload).toMatchObject({
		root_id: expect.any(String),
		status: expect.any(String),
		steps: expect.any(Number),
	});
});
