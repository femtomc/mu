import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationTelemetryRecorder } from "@femtomc/mu-control-plane";
import type { ControlPlaneHandle } from "../src/control_plane.js";
import { createServer } from "../src/server.js";

const dirsToCleanup = new Set<string>();

afterEach(async () => {
	for (const dir of dirsToCleanup) {
		await rm(dir, { recursive: true, force: true });
	}
	dirsToCleanup.clear();
});

async function mkRepoRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mu-server-reload-observability-"));
	dirsToCleanup.add(root);
	await mkdir(join(root, ".mu"), { recursive: true });
	await Bun.write(join(root, ".mu", "issues.jsonl"), "");
	await Bun.write(join(root, ".mu", "forum.jsonl"), "");
	await Bun.write(join(root, ".mu", "events.jsonl"), "");
	return root;
}

function reloadRequest(reason: string): Request {
	return new Request("http://localhost/api/control-plane/reload", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ reason }),
	});
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("control-plane reload observability scaffold", () => {
	test("reload emits warmup/cutover/drain/rollback lifecycle logs plus success/failure counters", async () => {
		const repoRoot = await mkRepoRoot();
		const telemetry = new GenerationTelemetryRecorder();
		let stopCalls = 0;
		const initial: ControlPlaneHandle = {
			activeAdapters: [{ name: "slack", route: "/webhooks/slack" }],
			handleWebhook: async () => null,
			stop: async () => {
				stopCalls += 1;
			},
		};
		const reloaded: ControlPlaneHandle = {
			activeAdapters: [{ name: "discord", route: "/webhooks/discord" }],
			handleWebhook: async () => null,
			stop: async () => {},
		};

		const server = createServer({
			repoRoot,
			controlPlane: initial,
			generationTelemetry: telemetry,
			controlPlaneReloader: async ({ generation }) => {
				expect(generation.generation_id).toBe("control-plane-gen-1");
				expect(generation.generation_seq).toBe(1);
				return reloaded;
			},
		});

		const success = await server.fetch(reloadRequest("success_case"));
		expect(success.status).toBe(200);
		expect(stopCalls).toBe(1);

		const countersAfterSuccess = telemetry.counters();
		expect(countersAfterSuccess.reload_success_total).toBe(1);
		expect(countersAfterSuccess.reload_failure_total).toBe(0);
		expect(countersAfterSuccess.reload_drain_duration_samples_total).toBe(1);

		const failingServer = createServer({
			repoRoot,
			controlPlane: reloaded,
			generationTelemetry: telemetry,
			controlPlaneReloader: async () => {
				throw new Error("reload exploded");
			},
		});
		const failure = await failingServer.fetch(reloadRequest("failure_case"));
		expect(failure.status).toBe(500);

		const countersAfterFailure = telemetry.counters();
		expect(countersAfterFailure.reload_success_total).toBe(1);
		expect(countersAfterFailure.reload_failure_total).toBe(1);

		const traces = telemetry.records({ kind: "trace", limit: 50 });
		expect(
			traces.some((trace) => trace.kind === "trace" && trace.fields.generation_id === "control-plane-gen-1"),
		).toBe(true);

		const logMessages = telemetry
			.records({ kind: "log", limit: 200 })
			.flatMap((record) => (record.kind === "log" ? [record.message] : []));
		expect(logMessages).toContain("reload transition warmup:start");
		expect(logMessages).toContain("reload transition warmup:complete");
		expect(logMessages).toContain("reload transition cutover:start");
		expect(logMessages).toContain("reload transition cutover:complete");
		expect(logMessages).toContain("reload transition drain:start");
		expect(logMessages).toContain("reload transition drain:complete");
		expect(logMessages).toContain("reload transition rollback:skipped");
		expect(logMessages).toContain("reload transition warmup:failed");
	});

	test("post-cutover drain failures trigger rollback and restore previous generation", async () => {
		const repoRoot = await mkRepoRoot();
		const telemetry = new GenerationTelemetryRecorder();
		let drainStopCalls = 0;
		let rollbackStopCalls = 0;
		const initial: ControlPlaneHandle = {
			activeAdapters: [{ name: "slack", route: "/webhooks/slack" }],
			handleWebhook: async () => null,
			stop: async () => {
				drainStopCalls += 1;
				throw new Error("drain exploded");
			},
		};
		const reloaded: ControlPlaneHandle = {
			activeAdapters: [{ name: "discord", route: "/webhooks/discord" }],
			handleWebhook: async () => null,
			stop: async () => {
				rollbackStopCalls += 1;
			},
		};

		const server = createServer({
			repoRoot,
			controlPlane: initial,
			generationTelemetry: telemetry,
			controlPlaneReloader: async () => reloaded,
		});

		const response = await server.fetch(reloadRequest("drain_failure_case"));
		expect(response.status).toBe(500);
		const payload = (await response.json()) as {
			ok: boolean;
			control_plane: { adapters: string[] };
			generation: {
				outcome: "success" | "failure";
				active_generation: { generation_id: string } | null;
			};
		};
		expect(payload.ok).toBe(false);
		expect(payload.control_plane.adapters).toEqual(["slack"]);
		expect(payload.generation.outcome).toBe("failure");
		expect(payload.generation.active_generation?.generation_id).toBe("control-plane-gen-0");
		expect(drainStopCalls).toBe(1);
		expect(rollbackStopCalls).toBe(1);

		const logMessages = telemetry
			.records({ kind: "log", limit: 200 })
			.flatMap((record) => (record.kind === "log" ? [record.message] : []));
		expect(logMessages).toContain("reload transition drain:failed");
		expect(logMessages).toContain("reload transition rollback:start");
		expect(logMessages).toContain("reload transition rollback:complete");
	});

	test("concurrent reload calls coalesce and increment duplicate signal counter", async () => {
		const repoRoot = await mkRepoRoot();
		const telemetry = new GenerationTelemetryRecorder();
		const initial: ControlPlaneHandle = {
			activeAdapters: [{ name: "slack", route: "/webhooks/slack" }],
			handleWebhook: async () => null,
			stop: async () => {},
		};
		const reloaded: ControlPlaneHandle = {
			activeAdapters: [{ name: "slack", route: "/webhooks/slack" }],
			handleWebhook: async () => null,
			stop: async () => {},
		};

		const started = deferred<void>();
		const release = deferred<void>();

		const server = createServer({
			repoRoot,
			controlPlane: initial,
			generationTelemetry: telemetry,
			controlPlaneReloader: async () => {
				started.resolve(undefined);
				await release.promise;
				return reloaded;
			},
		});

		const first = server.fetch(reloadRequest("coalesce-1"));
		await started.promise;
		const second = server.fetch(reloadRequest("coalesce-2"));
		release.resolve(undefined);

		const [firstResponse, secondResponse] = await Promise.all([first, second]);
		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(200);
		expect(telemetry.counters().duplicate_signal_total).toBe(1);
	});
});
