import type {
	ControlPlaneSessionLifecycle,
	ControlPlaneSessionMutationResult,
} from "./control_plane_contract.js";

export type ShellCommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type ShellCommandRunner = (command: string) => Promise<ShellCommandResult>;

function shellQuoteArg(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellJoin(args: string[]): string {
	return args.map(shellQuoteArg).join(" ");
}

function createShellCommandRunner(repoRoot: string): ShellCommandRunner {
	return async (command: string): Promise<ShellCommandResult> => {
		const proc = Bun.spawn({
			cmd: ["bash", "-lc", command],
			cwd: repoRoot,
			env: Bun.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
			proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
		]);
		return {
			exitCode: Number.isFinite(exitCode) ? Number(exitCode) : 1,
			stdout,
			stderr,
		};
	};
}

function describeLifecycleError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

export function createProcessSessionLifecycle(opts: {
	repoRoot: string;
	runShellCommand?: ShellCommandRunner;
}): ControlPlaneSessionLifecycle {
	const runShellCommand = opts.runShellCommand ?? createShellCommandRunner(opts.repoRoot);
	let sessionMutationScheduled: { action: "reload" | "update"; at_ms: number } | null = null;

	const scheduleReload = async (): Promise<ControlPlaneSessionMutationResult> => {
		if (sessionMutationScheduled) {
			return {
				ok: true,
				action: sessionMutationScheduled.action,
				message: `session ${sessionMutationScheduled.action} already scheduled`,
				details: { scheduled_at_ms: sessionMutationScheduled.at_ms },
			};
		}

		const nowMs = Date.now();
		const restartCommand = Bun.env.MU_RESTART_COMMAND?.trim();
		const inferredArgs =
			process.argv[0] === process.execPath
				? [process.execPath, ...process.argv.slice(1)]
				: [process.execPath, ...process.argv];
		const restartShellCommand =
			restartCommand && restartCommand.length > 0 ? restartCommand : shellJoin(inferredArgs);
		if (!restartShellCommand.trim()) {
			return {
				ok: false,
				action: "reload",
				message: "unable to determine restart command",
			};
		}

		const exitDelayMs = 1_000;
		const launchDelayMs = exitDelayMs + 300;
		const delayedShellCommand = `sleep ${(launchDelayMs / 1_000).toFixed(2)}; ${restartShellCommand}`;

		let spawnedPid: number | null = null;
		try {
			const proc = Bun.spawn({
				cmd: ["bash", "-lc", delayedShellCommand],
				cwd: opts.repoRoot,
				env: Bun.env,
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
			});
			spawnedPid = proc.pid ?? null;
		} catch (err) {
			return {
				ok: false,
				action: "reload",
				message: `failed to spawn replacement process: ${describeLifecycleError(err)}`,
			};
		}

		sessionMutationScheduled = { action: "reload", at_ms: nowMs };
		setTimeout(() => {
			process.exit(0);
		}, exitDelayMs);

		return {
			ok: true,
			action: "reload",
			message: "reload scheduled; restarting process",
			details: {
				restart_command: restartShellCommand,
				restart_launch_command: delayedShellCommand,
				spawned_pid: spawnedPid,
				exit_delay_ms: exitDelayMs,
				launch_delay_ms: launchDelayMs,
			},
		};
	};

	const scheduleUpdate = async (): Promise<ControlPlaneSessionMutationResult> => {
		if (sessionMutationScheduled) {
			return {
				ok: true,
				action: sessionMutationScheduled.action,
				message: `session ${sessionMutationScheduled.action} already scheduled`,
				details: { scheduled_at_ms: sessionMutationScheduled.at_ms },
			};
		}

		const updateCommand = Bun.env.MU_UPDATE_COMMAND?.trim() || "npm install -g @femtomc/mu@latest";
		const result = await runShellCommand(updateCommand);
		if (result.exitCode !== 0) {
			return {
				ok: false,
				action: "update",
				message: `update command failed (exit ${result.exitCode})`,
				details: {
					update_command: updateCommand,
					stdout: result.stdout.slice(-4_000),
					stderr: result.stderr.slice(-4_000),
				},
			};
		}

		const reloadResult = await scheduleReload();
		if (!reloadResult.ok) {
			return {
				ok: false,
				action: "update",
				message: reloadResult.message,
				details: {
					update_command: updateCommand,
					reload: reloadResult.details ?? null,
				},
			};
		}

		return {
			ok: true,
			action: "update",
			message: "update applied; reload scheduled",
			details: {
				update_command: updateCommand,
				reload: reloadResult.details ?? null,
				update_stdout_tail: result.stdout.slice(-1_000),
			},
		};
	};

	return {
		reload: scheduleReload,
		update: scheduleUpdate,
	};
}
