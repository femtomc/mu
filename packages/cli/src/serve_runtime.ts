import { existsSync, openSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getStorePaths as resolveStorePaths } from "@femtomc/mu-core/node";

export type ServeRuntimeRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type ServeRuntimeWriter = {
	write: (chunk: string) => void;
};

export type ServeRuntimeIO = {
	stdout?: ServeRuntimeWriter;
	stderr?: ServeRuntimeWriter;
};

export type ServeActiveAdapter = {
	name: string;
	route: string;
};

export type ServeServerHandle = {
	activeAdapters: readonly ServeActiveAdapter[];
	stop: () => Promise<void>;
};

export type OperatorSessionStartMode = "in-memory" | "continue-recent" | "new" | "open";

export type OperatorSessionStartOpts = {
	mode: OperatorSessionStartMode;
	sessionDir?: string;
	sessionFile?: string;
};

export type ServeDeps = {
	startServer: (opts: { repoRoot: string; port: number }) => Promise<ServeServerHandle>;
	spawnBackgroundServer: (opts: { repoRoot: string; port: number }) => Promise<{ pid: number; url: string }>;
	requestServerShutdown: (opts: { serverUrl: string }) => Promise<{ ok: boolean }>;
	runOperatorSession: (opts: {
		onReady: () => void;
		provider?: string;
		model?: string;
		thinking?: string;
		sessionMode?: OperatorSessionStartMode;
		sessionDir?: string;
		sessionFile?: string;
	}) => Promise<ServeRuntimeRunResult>;
	registerSignalHandler: (signal: NodeJS.Signals, handler: () => void) => () => void;
	registerProcessExitHandler: (handler: () => void) => () => void;
};

export type ServeLifecycleOptions = {
	commandName: "serve" | "run" | "session";
	port: number;
	operatorProvider?: string;
	operatorModel?: string;
	operatorThinking?: string;
	operatorSession?: OperatorSessionStartOpts;
	beforeOperatorSession?: (opts: {
		serverUrl: string;
		deps: ServeDeps;
		io: ServeRuntimeIO | undefined;
	}) => Promise<void>;
};

type BuildServeDepsOptions<Ctx extends { repoRoot: string; serveDeps?: Partial<ServeDeps> }> = {
	defaultOperatorSessionStart: (repoRoot: string) => OperatorSessionStartOpts;
	runOperatorSession: (
		ctx: Ctx,
		opts: {
			onReady: () => void;
			provider?: string;
			model?: string;
			thinking?: string;
			sessionMode?: OperatorSessionStartMode;
			sessionDir?: string;
			sessionFile?: string;
		},
	) => Promise<ServeRuntimeRunResult>;
};

type RunServeLifecycleDeps<Ctx extends { repoRoot: string; io?: ServeRuntimeIO; paths: unknown }> = {
	ensureStoreInitialized: (ctx: Pick<Ctx, "paths">) => Promise<void>;
	readServeOperatorDefaults: (repoRoot: string) => Promise<{ provider?: string; model?: string; thinking?: string }>;
	defaultOperatorSessionStart: (repoRoot: string) => OperatorSessionStartOpts;
	buildServeDeps: (ctx: Ctx) => ServeDeps;
	detectRunningServer: (repoRoot: string) => Promise<{ url: string; port: number; pid: number } | null>;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => ServeRuntimeRunResult;
	describeError: (err: unknown) => string;
	signalExitCode: (signal: NodeJS.Signals) => number;
	delayMs: (ms: number) => Promise<void>;
};

function storePathForRepoRoot(repoRoot: string, ...parts: string[]): string {
	return join(resolveStorePaths(repoRoot).storeDir, ...parts);
}

function resolveServerCliPath(): string {
	// Resolve the mu-server CLI entry point from the @femtomc/mu-server package.
	// In the workspace, the source entry is src/cli.ts; in a dist build, dist/cli.js.
	const pkgDir = dirname(require.resolve("@femtomc/mu-server/package.json"));
	const srcCli = join(pkgDir, "src", "cli.ts");
	if (existsSync(srcCli)) return srcCli;
	return join(pkgDir, "dist", "cli.js");
}

function delayMs(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function pollUntilHealthy(url: string, timeoutMs: number, intervalMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) });
			if (res.ok) return;
		} catch {
			// not ready yet
		}
		await delayMs(intervalMs);
	}
	throw new Error(
		`server at ${url} did not become healthy within ${timeoutMs}ms — check the workspace control-plane server log`,
	);
}

export function buildServeDeps<Ctx extends { repoRoot: string; serveDeps?: Partial<ServeDeps> }>(
	ctx: Ctx,
	options: BuildServeDepsOptions<Ctx>,
): ServeDeps {
	const defaults: ServeDeps = {
		startServer: async ({ repoRoot, port }) => {
			const { composeServerRuntime, createServerFromRuntime } = await import("@femtomc/mu-server");
			const runtime = await composeServerRuntime({ repoRoot });
			const serverConfig = createServerFromRuntime(runtime, { port });

			let server: ReturnType<typeof Bun.serve>;
			try {
				server = Bun.serve(serverConfig);
			} catch (err) {
				try {
					await runtime.controlPlane?.stop();
				} catch {
					// Best effort cleanup. Preserve the original startup error.
				}
				throw err;
			}

			const discoveryPath = storePathForRepoRoot(repoRoot, "control-plane", "server.json");
			await mkdir(dirname(discoveryPath), { recursive: true });
			await Bun.write(
				discoveryPath,
				JSON.stringify({ pid: process.pid, port, url: `http://localhost:${port}` }) + "\n",
			);

			return {
				activeAdapters: runtime.controlPlane?.activeAdapters ?? [],
				stop: async () => {
					try {
						rmSync(discoveryPath, { force: true });
					} catch {
						// best-effort
					}
					await runtime.controlPlane?.stop();
					server.stop();
				},
			};
		},
		spawnBackgroundServer: async ({ repoRoot, port }) => {
			const serverCliPath = resolveServerCliPath();
			const logDir = storePathForRepoRoot(repoRoot, "control-plane");
			await mkdir(logDir, { recursive: true });
			const logFile = join(logDir, "server.log");
			const logFd = openSync(logFile, "w");

			const proc = Bun.spawn({
				cmd: [process.execPath, serverCliPath, "--port", String(port), "--repo-root", repoRoot],
				cwd: repoRoot,
				stdin: "ignore",
				stdout: logFd,
				stderr: logFd,
				detached: true,
			});
			proc.unref();

			const url = `http://localhost:${port}`;
			await pollUntilHealthy(url, 15_000, 200);
			return { pid: proc.pid, url };
		},
		requestServerShutdown: async ({ serverUrl }) => {
			try {
				const res = await fetch(`${serverUrl}/api/server/shutdown`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
					signal: AbortSignal.timeout(5_000),
				});
				if (res.ok) return { ok: true };
				return { ok: false };
			} catch {
				return { ok: false };
			}
		},
		runOperatorSession: async ({ onReady, provider, model, thinking, sessionMode, sessionDir, sessionFile }) => {
			const requestedSession: OperatorSessionStartOpts = sessionMode
				? {
						mode: sessionMode,
						sessionDir,
						sessionFile,
					}
				: options.defaultOperatorSessionStart(ctx.repoRoot);
			return await options.runOperatorSession(ctx, {
				onReady,
				provider,
				model,
				thinking,
				sessionMode: requestedSession.mode,
				sessionDir: requestedSession.sessionDir,
				sessionFile: requestedSession.sessionFile,
			});
		},
		registerSignalHandler: (signal, handler) => {
			process.on(signal, handler);
			return () => {
				if (typeof process.off === "function") {
					process.off(signal, handler);
					return;
				}
				process.removeListener(signal, handler);
			};
		},
		registerProcessExitHandler: (handler) => {
			process.on("exit", handler);
			return () => {
				if (typeof process.off === "function") {
					process.off("exit", handler);
					return;
				}
				process.removeListener("exit", handler);
			};
		},
	};
	return { ...defaults, ...ctx.serveDeps };
}

export async function runServeLifecycle<Ctx extends { repoRoot: string; io?: ServeRuntimeIO; paths: unknown }>(
	ctx: Ctx,
	opts: ServeLifecycleOptions,
	deps: RunServeLifecycleDeps<Ctx>,
): Promise<ServeRuntimeRunResult> {
	await deps.ensureStoreInitialized(ctx);
	const operatorDefaults = await deps.readServeOperatorDefaults(ctx.repoRoot);
	const operatorProvider = opts.operatorProvider ?? operatorDefaults.provider;
	const operatorModel =
		opts.operatorModel ??
		(opts.operatorProvider != null && opts.operatorProvider.length > 0 ? undefined : operatorDefaults.model);
	const operatorThinking = opts.operatorThinking ?? operatorDefaults.thinking;
	const operatorSession = opts.operatorSession ?? deps.defaultOperatorSessionStart(ctx.repoRoot);

	const io = ctx.io;
	const serveDeps = deps.buildServeDeps(ctx);

	// Step 1: Discover or spawn a background server
	let serverUrl: string;
	const existingServer = await deps.detectRunningServer(ctx.repoRoot);
	if (existingServer) {
		serverUrl = existingServer.url;
		io?.stderr?.write(`mu: connecting to existing server at ${serverUrl} (pid ${existingServer.pid})\n`);
	} else {
		// Spawn server as a detached background process
		try {
			const spawned = await serveDeps.spawnBackgroundServer({ repoRoot: ctx.repoRoot, port: opts.port });
			serverUrl = spawned.url;
			io?.stderr?.write(`mu: started background server at ${serverUrl} (pid ${spawned.pid})\n`);
		} catch (err) {
			return deps.jsonError(`failed to start server: ${deps.describeError(err)}`, {
				recovery: [
					`mu ${opts.commandName} --port 3000`,
					`mu ${opts.commandName} --help`,
					"check workspace control-plane server.log",
				],
			});
		}
	}

	Bun.env.MU_SERVER_URL = serverUrl;

	// Step 2: Run pre-operator hooks before operator attach
	if (opts.beforeOperatorSession) {
		try {
			await opts.beforeOperatorSession({ serverUrl, deps: serveDeps, io });
		} catch (err) {
			return deps.jsonError(`failed to prepare serve lifecycle: ${deps.describeError(err)}`, {
				recovery: [`mu ${opts.commandName} --help`, "mu serve --help"],
			});
		}
	}

	// Step 3: Run operator TUI (blocks until Ctrl+D / exit)
	let operatorConnected = false;
	const onOperatorReady = (): void => {
		if (operatorConnected) return;
		operatorConnected = true;
	};

	let resolveSignal: ((signal: NodeJS.Signals) => void) | null = null;
	const signalPromise = new Promise<NodeJS.Signals>((resolve) => {
		resolveSignal = resolve;
	});
	let receivedSignal: NodeJS.Signals | null = null;
	const onSignal = (signal: NodeJS.Signals): void => {
		if (receivedSignal != null) return;
		receivedSignal = signal;
		resolveSignal?.(signal);
	};
	const removeSignalHandlers = [
		serveDeps.registerSignalHandler("SIGINT", () => onSignal("SIGINT")),
		serveDeps.registerSignalHandler("SIGTERM", () => onSignal("SIGTERM")),
	];
	const unregisterSignals = () => {
		for (const remove of removeSignalHandlers) {
			try {
				remove();
			} catch {
				/* no-op */
			}
		}
	};

	let result: ServeRuntimeRunResult;
	try {
		const operatorPromise = serveDeps
			.runOperatorSession({
				onReady: onOperatorReady,
				provider: operatorProvider,
				model: operatorModel,
				thinking: operatorThinking,
				sessionMode: operatorSession.mode,
				sessionDir: operatorSession.sessionDir,
				sessionFile: operatorSession.sessionFile,
			})
			.catch((err) =>
				deps.jsonError(`operator session crashed: ${deps.describeError(err)}`, {
					recovery: [`mu ${opts.commandName} --help`, "mu serve --help"],
				}),
			);

		const winner = await Promise.race([
			operatorPromise.then((operatorResult) => ({ kind: "operator" as const, operatorResult })),
			signalPromise.then((signal) => ({ kind: "signal" as const, signal })),
		]);

		if (winner.kind === "signal") {
			await Promise.race([operatorPromise, deps.delayMs(1_000)]);
			result = { stdout: "", stderr: "", exitCode: deps.signalExitCode(winner.signal) };
		} else {
			if (winner.operatorResult.exitCode !== 0 && !operatorConnected) {
				io?.stderr?.write("mu: operator terminal failed to connect.\n");
			}
			result = winner.operatorResult;
		}
	} finally {
		unregisterSignals();
		// TUI exits — server keeps running in the background.
		// No stopServer(), no lock cleanup.
	}

	return result;
}
