export type ServeCommandRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type ServeCliIo = {
	stderr?: { write: (chunk: string) => void };
};

type ServeServerDiscovery = {
	url: string;
	pid: number;
};

type ServeDeps = {
	requestServerShutdown: (opts: { serverUrl: string }) => Promise<{ ok: boolean }>;
};

export type ServeCommandCtx = {
	repoRoot: string;
	io?: ServeCliIo;
};

export type ServeCommandDeps<Ctx extends ServeCommandCtx> = {
	hasHelpFlag: (argv: readonly string[]) => boolean;
	getFlagValue: (argv: readonly string[], name: string) => { value: string | null; rest: string[] };
	popFlag: (argv: readonly string[], name: string) => { present: boolean; rest: string[] };
	ensureInt: (value: string, opts: { name: string; min?: number; max?: number }) => number | null;
	jsonError: (
		msg: string,
		opts?: { pretty?: boolean; recovery?: readonly string[] },
	) => ServeCommandRunResult;
	ok: (stdout?: string, exitCode?: number) => ServeCommandRunResult;
	delayMs: (ms: number) => Promise<void>;
	detectRunningServer: (repoRoot: string) => Promise<ServeServerDiscovery | null>;
	buildServeDeps: (ctx: Ctx) => ServeDeps;
	cleanupStaleServerFiles: (repoRoot: string) => void;
	runServeLifecycle: (
		ctx: Ctx,
		opts: { commandName: "serve" | "run" | "session"; port: number },
	) => Promise<ServeCommandRunResult>;
};

export async function cmdServe<Ctx extends ServeCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: ServeCommandDeps<Ctx>,
): Promise<ServeCommandRunResult> {
	const { hasHelpFlag, getFlagValue, ensureInt, jsonError, ok, runServeLifecycle } = deps;
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu serve - start background server + attach terminal operator session",
				"",
				"Usage:",
				"  mu serve [--port N]",
				"",
				"Options:",
				"  --port N       Server port (default: 3000)",
				"",
				"Spawns the server as a background process (if not already running),",
				"then attaches an interactive terminal operator session. Ctrl+D exits",
				"the TUI only — the server keeps running.",
				"",
				"Use `mu stop` to shut down the background server.",
				"Use `mu session` to reconnect to a persisted terminal operator session.",
				"",
				"Control plane configuration:",
				"  workspace config.json is the source of truth for adapter + assistant settings",
				"  Attached terminal operator session inherits control_plane.operator.provider/model/thinking when set",
				"  Use direct CLI commands in the operator session for capability discovery (for example: `mu --help`)",
				"  Use `mu control status` to inspect current config",
				"",
				"See also: `mu session --help`, `mu stop --help`, `mu guide`",
			].join("\n") + "\n",
		);
	}

	const { value: portRaw, rest } = getFlagValue(argv, "--port");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu serve --help"] });
	}

	const port = portRaw ? ensureInt(portRaw, { name: "--port", min: 1, max: 65535 }) : 3000;
	if (port == null) {
		return jsonError("port must be 1-65535", { recovery: ["mu serve --port 3000"] });
	}

	return await runServeLifecycle(ctx, {
		commandName: "serve",
		port,
	});
}

export async function cmdStop<Ctx extends ServeCommandCtx>(
	argv: string[],
	ctx: Ctx,
	deps: ServeCommandDeps<Ctx>,
): Promise<ServeCommandRunResult> {
	const {
		hasHelpFlag,
		popFlag,
		jsonError,
		ok,
		delayMs,
		detectRunningServer,
		buildServeDeps,
		cleanupStaleServerFiles,
	} = deps;
	if (hasHelpFlag(argv)) {
		return ok(
			[
				"mu stop - stop the background server",
				"",
				"Usage:",
				"  mu stop [--force]",
				"",
				"Options:",
				"  --force    Kill the server process with SIGKILL if graceful shutdown fails",
				"",
				"Sends a graceful shutdown request to the running server.",
				"If --force is given and graceful shutdown fails, sends SIGKILL.",
				"",
				"See also: `mu serve --help`",
			].join("\n") + "\n",
		);
	}

	const { present: force, rest } = popFlag(argv, "--force");
	if (rest.length > 0) {
		return jsonError(`unknown args: ${rest.join(" ")}`, { recovery: ["mu stop --help"] });
	}

	const io = ctx.io;
	const serveDeps = buildServeDeps(ctx);

	const existing = await detectRunningServer(ctx.repoRoot);
	if (!existing) {
		return jsonError("no running server found", {
			recovery: ["mu serve", "mu stop --help"],
		});
	}

	io?.stderr?.write(`mu: stopping server at ${existing.url} (pid ${existing.pid})...\n`);

	const shutdownResult = await serveDeps.requestServerShutdown({ serverUrl: existing.url });

	if (shutdownResult.ok) {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				process.kill(existing.pid, 0);
			} catch {
				io?.stderr?.write("mu: server stopped.\n");
				return ok();
			}
			await delayMs(200);
		}
		if (!force) {
			return jsonError("server did not exit within 10s — use --force to kill it", {
				recovery: ["mu stop --force"],
			});
		}
	}

	if (force) {
		io?.stderr?.write("mu: force-killing server process...\n");
		try {
			process.kill(existing.pid, "SIGKILL");
		} catch {
			// Already dead.
		}
		await delayMs(500);
		cleanupStaleServerFiles(ctx.repoRoot);
		io?.stderr?.write("mu: server killed.\n");
		return ok();
	}

	return jsonError("graceful shutdown request failed", {
		recovery: ["mu stop --force"],
	});
}
