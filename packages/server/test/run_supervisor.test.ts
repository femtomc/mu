import { describe, expect, test } from "bun:test";
import { type ControlPlaneRunProcess, ControlPlaneRunSupervisor } from "../src/run_supervisor.js";

function streamFromLines(lines: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const line of lines) {
				controller.enqueue(encoder.encode(`${line}\n`));
			}
			controller.close();
		},
	});
}

async function waitFor<T>(
	fn: () => T | null | undefined | false,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 2_000;
	const intervalMs = opts.intervalMs ?? 20;
	const start = Date.now();
	while (true) {
		const value = fn();
		if (value != null && value !== false) {
			return value as T;
		}
		if (Date.now() - start > timeoutMs) {
			throw new Error("timeout waiting for condition");
		}
		await Bun.sleep(intervalMs);
	}
}

describe("ControlPlaneRunSupervisor", () => {
	test("launchResume tracks completion + trace hints", async () => {
		const events: string[] = [];
		const supervisor = new ControlPlaneRunSupervisor({
			repoRoot: "/repo",
			heartbeatIntervalMs: 100,
			spawnProcess: () => {
				const process: ControlPlaneRunProcess = {
					pid: 42,
					stdout: streamFromLines([]),
					stderr: streamFromLines([
						"Step 1/20 mu-root1234 role=worker",
						"Done 1/20 mu-root1234 outcome=expanded elapsed=0.1s exit=0",
						"logs: .mu/logs/mu-root1234/session*.jsonl",
					]),
					exited: Promise.resolve(0),
					kill() {},
				};
				return process;
			},
			onEvent: (event) => {
				events.push(event.kind);
			},
		});

		const run = await supervisor.launchResume({ rootIssueId: "mu-root1234", source: "api" });
		expect(run.status).toBe("running");
		expect(run.root_issue_id).toBe("mu-root1234");

		const completed = await waitFor(() => {
			const current = supervisor.get(run.job_id);
			return current?.status === "completed" ? current : null;
		});
		expect(completed.exit_code).toBe(0);

		const trace = await supervisor.trace(run.job_id, { limit: 50 });
		expect(trace).not.toBeNull();
		if (!trace) {
			throw new Error("expected trace");
		}
		expect(trace.stderr.some((line) => line.includes("Step 1/20"))).toBe(true);
		expect(trace.log_hints.some((line) => line.includes(".mu/logs/mu-root1234"))).toBe(true);
		expect(events).toContain("run_started");
		expect(events).toContain("run_completed");
	});

	test("interrupt marks active run cancelled", async () => {
		const signals: Array<string | number | undefined> = [];
		let resolveExit: (exitCode: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});

		const supervisor = new ControlPlaneRunSupervisor({
			repoRoot: "/repo",
			spawnProcess: () => {
				const process: ControlPlaneRunProcess = {
					pid: 99,
					stdout: streamFromLines([]),
					stderr: streamFromLines([]),
					exited,
					kill(signal) {
						signals.push(signal);
						resolveExit(signal === "SIGINT" ? 130 : 137);
					},
				};
				return process;
			},
		});

		const run = await supervisor.launchResume({ rootIssueId: "mu-root9999", source: "api" });
		const interrupted = supervisor.interrupt({ rootIssueId: "mu-root9999" });
		expect(interrupted.ok).toBe(true);
		expect(signals).toContain("SIGINT");

		const cancelled = await waitFor(() => {
			const current = supervisor.get(run.job_id);
			return current?.status === "cancelled" ? current : null;
		});
		expect(cancelled.exit_code).toBe(130);
	});

	test("running jobs emit periodic heartbeat telemetry", async () => {
		const events: Array<{ kind: string; message: string }> = [];
		let resolveExit: (exitCode: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});

		const supervisor = new ControlPlaneRunSupervisor({
			repoRoot: "/repo",
			heartbeatIntervalMs: 2_000,
			spawnProcess: () => {
				const process: ControlPlaneRunProcess = {
					pid: 123,
					stdout: streamFromLines([]),
					stderr: streamFromLines([]),
					exited,
					kill() {
						resolveExit(0);
					},
				};
				return process;
			},
			onEvent: (event) => {
				events.push({ kind: event.kind, message: event.message });
			},
		});

		const run = await supervisor.launchResume({ rootIssueId: "mu-root4444", source: "api" });

		await waitFor(
			() =>
				events.some((event) => event.kind === "run_heartbeat" && event.message.includes("mu-root4444"))
					? true
					: null,
			{ timeoutMs: 6_000, intervalMs: 50 },
		);

		resolveExit(0);
		await waitFor(() => {
			const current = supervisor.get(run.job_id);
			return current?.status === "completed" ? true : null;
		});
		await supervisor.stop();
	});
});
