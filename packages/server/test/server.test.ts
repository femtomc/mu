import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneHandle } from "../src/control_plane.js";
import { composeServerRuntime, createServerFromRuntime } from "../src/server.js";

async function waitFor<T>(
	fn: () => T | Promise<T>,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 2_000;
	const intervalMs = opts.intervalMs ?? 20;
	const startedAt = Date.now();
	while (true) {
		const value = await fn();
		if (value) {
			return value;
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("timeout waiting for condition");
		}
		await Bun.sleep(intervalMs);
	}
}

async function createServerForTest(opts: {
	repoRoot: string;
	controlPlane?: ControlPlaneHandle | null;
	serverOptions?: Parameters<typeof createServerFromRuntime>[1];
}) {
	const runtime = await composeServerRuntime({
		repoRoot: opts.repoRoot,
		controlPlane: opts.controlPlane ?? null,
	});
	return createServerFromRuntime(runtime, opts.serverOptions);
}

describe("mu-server", () => {
	let tempDir: string;
	let server: any;

	beforeEach(async () => {
		// Create a temporary directory for test data
		tempDir = await mkdtemp(join(tmpdir(), "mu-server-test-"));

		// Create .mu directory structure
		const muDir = join(tempDir, ".mu");
		await Bun.write(join(muDir, "issues.jsonl"), "");
		await Bun.write(join(muDir, "forum.jsonl"), "");
		await Bun.write(join(muDir, "events.jsonl"), "");

		// Create server instance
		server = await createServerForTest({ repoRoot: tempDir });
	});

	afterEach(async () => {
		// Clean up temp directory
		await rm(tempDir, { recursive: true, force: true });
	});

	test("health check endpoint", async () => {
		const response = await server.fetch(new Request("http://localhost/healthz"));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
	});

	test("status endpoint", async () => {
		const response = await server.fetch(new Request("http://localhost/api/status"));
		expect(response.status).toBe(200);
		const status = await response.json();
		expect(status).toEqual({
			repo_root: tempDir,
			control_plane: {
				active: false,
				adapters: [],
				routes: [],
				generation: {
					supervisor_id: "control-plane",
					active_generation: null,
					pending_reload: null,
					last_reload: null,
				},
				observability: {
					counters: {
						reload_success_total: 0,
						reload_failure_total: 0,
						reload_drain_duration_ms_total: 0,
						reload_drain_duration_samples_total: 0,
						duplicate_signal_total: 0,
						drop_signal_total: 0,
					},
				},
			},
		});
	});


	test("composeServerRuntime wires session lifecycle into initial control-plane generation", async () => {
		const calls: string[] = [];
		const runtime = await composeServerRuntime({
			repoRoot: tempDir,
			sessionLifecycle: {
				reload: async () => {
					calls.push("reload");
					return { ok: true, action: "reload", message: "reload scheduled" };
				},
				update: async () => {
					calls.push("update");
					return { ok: true, action: "update", message: "update scheduled" };
				},
			},
		});
		expect(runtime.controlPlane).not.toBeNull();
		if (!runtime.controlPlane) {
			throw new Error("expected control plane");
		}
		expect(runtime.repoRoot).toBe(tempDir);
		expect(runtime.capabilities.session_lifecycle_actions).toEqual(["reload", "update"]);
		expect(runtime.capabilities.control_plane_bootstrapped).toBe(true);
		expect(runtime.capabilities.control_plane_adapters).toEqual([]);

		const serverFromRuntime = createServerFromRuntime(runtime, { port: 3011 });
		expect(serverFromRuntime.port).toBe(3011);

		const reload = await runtime.controlPlane.submitTerminalCommand?.({
			commandText: "/mu reload",
			repoRoot: tempDir,
		});
		expect(reload?.kind).toBe("completed");

		const update = await runtime.controlPlane.submitTerminalCommand?.({
			commandText: "/mu update",
			repoRoot: tempDir,
		});
		expect(update?.kind).toBe("completed");
		expect(calls).toEqual(["reload", "update"]);

		await runtime.controlPlane.stop();
	});

	test("config endpoint returns default config shape", async () => {
		const response = await server.fetch(new Request("http://localhost/api/config"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			config_path: string;
			config: {
				control_plane: {
					adapters: {
						slack: { signing_secret: string | null };
					};
					operator: { enabled: boolean; run_triggers_enabled: boolean };
				};
			};
			presence: {
				control_plane: {
					adapters: {
						slack: { signing_secret: boolean };
					};
				};
			};
		};
		expect(payload.config_path).toBe(join(tempDir, ".mu", "config.json"));
		expect(payload.config.control_plane.adapters.slack.signing_secret).toBeNull();
		expect(payload.config.control_plane.operator.enabled).toBe(true);
		expect(payload.config.control_plane.operator.run_triggers_enabled).toBe(true);
		expect(payload.presence.control_plane.adapters.slack.signing_secret).toBe(false);
	});

	test("config endpoint applies patch and persists to .mu/config.json", async () => {
		const response = await server.fetch(
			new Request("http://localhost/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					patch: {
						control_plane: {
							adapters: {
								slack: {
									signing_secret: "slack-secret-test",
								},
							},
							operator: {
								enabled: false,
							},
						},
					},
				}),
			}),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			config_path: string;
			presence: {
				control_plane: {
					adapters: {
						slack: { signing_secret: boolean };
					};
					operator: { enabled: boolean };
				};
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.presence.control_plane.adapters.slack.signing_secret).toBe(true);
		expect(payload.presence.control_plane.operator.enabled).toBe(false);

		const disk = JSON.parse(await readFile(payload.config_path, "utf8")) as {
			control_plane: {
				adapters: { slack: { signing_secret: string } };
				operator: { enabled: boolean };
			};
		};
		expect(disk.control_plane.adapters.slack.signing_secret).toBe("slack-secret-test");
		expect(disk.control_plane.operator.enabled).toBe(false);
	});

	test("status endpoint includes control-plane routes when active", async () => {
		const serverWithControlPlane = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: {
				activeAdapters: [{ name: "slack", route: "/webhooks/slack" }],
				handleWebhook: async () => null,
				stop: async () => {},
			},
		});

		const response = await serverWithControlPlane.fetch(new Request("http://localhost/api/status"));
		expect(response.status).toBe(200);
		const status = (await response.json()) as {
			control_plane: {
				active: boolean;
				adapters: string[];
				routes: Array<{ name: string; route: string }>;
				generation: {
					active_generation: { generation_id: string; generation_seq: number } | null;
				};
			};
		};
		expect(status.control_plane).toMatchObject({
			active: true,
			adapters: ["slack"],
			routes: [{ name: "slack", route: "/webhooks/slack" }],
		});
		expect(status.control_plane.generation.active_generation?.generation_id).toBe("control-plane-gen-0");
	});

	test("control-plane channels endpoint advertises frontend channel capabilities", async () => {
		const serverWithControlPlane = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: {
				activeAdapters: [{ name: "neovim", route: "/webhooks/neovim" }],
				handleWebhook: async () => null,
				stop: async () => {},
			},
		});

		const patchRes = await serverWithControlPlane.fetch(
			new Request("http://localhost/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					patch: {
						control_plane: {
							adapters: {
								neovim: { shared_secret: "nvim-secret" },
							},
						},
					},
				}),
			}),
		);
		expect(patchRes.status).toBe(200);

		const channelsRes = await serverWithControlPlane.fetch(
			new Request("http://localhost/api/control-plane/channels"),
		);
		expect(channelsRes.status).toBe(200);
		const payload = (await channelsRes.json()) as {
			ok: boolean;
			channels: Array<{
				channel: string;
				route: string;
				configured: boolean;
				active: boolean;
				frontend: boolean;
				verification: { kind?: string; secret_header?: string };
			}>;
		};
		expect(payload.ok).toBe(true);

		const byChannel = new Map(payload.channels.map((entry) => [entry.channel, entry]));
		expect(byChannel.get("neovim")).toMatchObject({
			channel: "neovim",
			route: "/webhooks/neovim",
			configured: true,
			active: true,
			frontend: true,
		});
		expect(byChannel.get("neovim")?.verification?.kind).toBe("shared_secret_header");
	});

	test("session flash API supports create/list/get/ack lifecycle", async () => {
		const createRes = await server.fetch(
			new Request("http://localhost/api/session-flash", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					session_id: "operator-123",
					session_kind: "cp_operator",
					body: "Use context id ctx-123 when answering.",
					context_ids: ["ctx-123"],
					source: "neovim",
				}),
			}),
		);
		expect(createRes.status).toBe(201);
		const createPayload = (await createRes.json()) as {
			ok: boolean;
			flash: { flash_id: string; session_id: string; status: string; context_ids: string[] };
		};
		expect(createPayload.ok).toBe(true);
		expect(createPayload.flash.session_id).toBe("operator-123");
		expect(createPayload.flash.status).toBe("pending");
		expect(createPayload.flash.context_ids).toEqual(["ctx-123"]);

		const listRes = await server.fetch(
			new Request("http://localhost/api/session-flash?session_id=operator-123&status=pending"),
		);
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as {
			count: number;
			flashes: Array<{ flash_id: string; status: string }>;
		};
		expect(listPayload.count).toBe(1);
		expect(listPayload.flashes[0]?.flash_id).toBe(createPayload.flash.flash_id);
		expect(listPayload.flashes[0]?.status).toBe("pending");

		const ackRes = await server.fetch(
			new Request("http://localhost/api/session-flash/ack", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ flash_id: createPayload.flash.flash_id, delivered_by: "test" }),
			}),
		);
		expect(ackRes.status).toBe(200);
		const ackPayload = (await ackRes.json()) as { flash: { status: string; delivered_by: string | null } };
		expect(ackPayload.flash.status).toBe("delivered");
		expect(ackPayload.flash.delivered_by).toBe("test");

		const getRes = await server.fetch(
			new Request(`http://localhost/api/session-flash/${encodeURIComponent(createPayload.flash.flash_id)}`),
		);
		expect(getRes.status).toBe(200);
		const getPayload = (await getRes.json()) as { flash: { status: string } };
		expect(getPayload.flash.status).toBe("delivered");
	});

	test("session turn API validates required fields before execution", async () => {
		const response = await server.fetch(
			new Request("http://localhost/api/session-turn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "hello" }),
			}),
		);
		expect(response.status).toBe(400);
		const payload = (await response.json()) as { error?: string };
		expect(payload.error).toContain("session_id is required");
	});

	test("control-plane reload endpoint swaps adapters in-process", async () => {
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

		const serverWithReload = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: initial,
			serverOptions: {
				controlPlaneReloader: async ({ previous }) => {
					expect(previous).toBe(initial);
					return reloaded;
				},
			},
		});

		const reloadResponse = await serverWithReload.fetch(
			new Request("http://localhost/api/control-plane/reload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "test_reload" }),
			}),
		);
		expect(reloadResponse.status).toBe(200);
		const payload = (await reloadResponse.json()) as {
			ok: boolean;
			previous_control_plane: { adapters: string[] };
			control_plane: { adapters: string[] };
			generation: {
				outcome: "success" | "failure";
				from_generation: { generation_id: string } | null;
				to_generation: { generation_id: string };
				active_generation: { generation_id: string } | null;
			};
			telegram_generation?: unknown;
		};
		expect(payload.ok).toBe(true);
		expect(payload.previous_control_plane.adapters).toEqual(["slack"]);
		expect(payload.control_plane.adapters).toEqual(["discord"]);
		expect(payload.generation.outcome).toBe("success");
		expect(payload.generation.from_generation?.generation_id).toBe("control-plane-gen-0");
		expect(payload.generation.to_generation.generation_id).toBe("control-plane-gen-1");
		expect(payload.generation.active_generation?.generation_id).toBe("control-plane-gen-1");
		expect(payload.telegram_generation).toBeUndefined();
		expect(stopCalls).toBe(1);

		const statusResponse = await serverWithReload.fetch(new Request("http://localhost/api/status"));
		expect(statusResponse.status).toBe(200);
		const status = (await statusResponse.json()) as {
			control_plane: {
				adapters: string[];
				generation: {
					active_generation: { generation_id: string } | null;
				};
			};
		};
		expect(status.control_plane.adapters).toEqual(["discord"]);
		expect(status.control_plane.generation.active_generation?.generation_id).toBe("control-plane-gen-1");
	});

	test("control-plane reload failure keeps existing adapters", async () => {
		let stopCalls = 0;
		const initial: ControlPlaneHandle = {
			activeAdapters: [{ name: "slack", route: "/webhooks/slack" }],
			handleWebhook: async () => null,
			stop: async () => {
				stopCalls += 1;
			},
		};

		const serverWithReload = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: initial,
			serverOptions: {
				controlPlaneReloader: async () => {
					throw new Error("reload failed");
				},
			},
		});

		const reloadResponse = await serverWithReload.fetch(
			new Request("http://localhost/api/control-plane/reload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "test_reload_failure" }),
			}),
		);
		expect(reloadResponse.status).toBe(500);
		const payload = (await reloadResponse.json()) as {
			ok: boolean;
			error?: string;
			control_plane: { adapters: string[] };
			generation: {
				outcome: "success" | "failure";
				active_generation: { generation_id: string } | null;
			};
		};
		expect(payload.ok).toBe(false);
		expect(payload.error).toContain("reload failed");
		expect(payload.control_plane.adapters).toEqual(["slack"]);
		expect(payload.generation.outcome).toBe("failure");
		expect(payload.generation.active_generation?.generation_id).toBe("control-plane-gen-0");
		expect(stopCalls).toBe(0);

		const statusResponse = await serverWithReload.fetch(new Request("http://localhost/api/status"));
		expect(statusResponse.status).toBe(200);
		const status = (await statusResponse.json()) as {
			control_plane: {
				adapters: string[];
				generation: {
					active_generation: { generation_id: string } | null;
				};
			};
		};
		expect(status.control_plane.adapters).toEqual(["slack"]);
		expect(status.control_plane.generation.active_generation?.generation_id).toBe("control-plane-gen-0");
	});

	test("control-plane rollback endpoint uses reload pipeline with explicit rollback reason", async () => {
		const initial: ControlPlaneHandle = {
			activeAdapters: [{ name: "slack", route: "/webhooks/slack" }],
			handleWebhook: async () => null,
			stop: async () => {},
		};
		const reloaded: ControlPlaneHandle = {
			activeAdapters: [{ name: "discord", route: "/webhooks/discord" }],
			handleWebhook: async () => null,
			stop: async () => {},
		};

		const serverWithReload = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: initial,
			serverOptions: {
				controlPlaneReloader: async () => reloaded,
			},
		});

		const rollbackResponse = await serverWithReload.fetch(
			new Request("http://localhost/api/control-plane/rollback", {
				method: "POST",
			}),
		);
		expect(rollbackResponse.status).toBe(200);
		const payload = (await rollbackResponse.json()) as {
			ok: boolean;
			reason: string;
			generation: { outcome: "success" | "failure" };
		};
		expect(payload.ok).toBe(true);
		expect(payload.reason).toBe("rollback");
		expect(payload.generation.outcome).toBe("success");
	});


	test("run management APIs proxy through control-plane handle", async () => {
		const run = {
			job_id: "run-job-1",
			mode: "run_start",
			status: "running",
			prompt: "ship release",
			root_issue_id: "mu-root1234",
			max_steps: 20,
			command_id: "cmd-1",
			source: "command",
			started_at_ms: 1,
			updated_at_ms: 2,
			finished_at_ms: null,
			exit_code: null,
			pid: 10,
			last_progress: "Step 1/20",
		} as const;
		const controlPlane: ControlPlaneHandle = {
			activeAdapters: [{ name: "telegram", route: "/webhooks/telegram" }],
			handleWebhook: async () => null,
			listRuns: async () => [run],
			getRun: async () => run,
			startRun: async () => run,
			resumeRun: async () => ({ ...run, mode: "run_resume" }),
			interruptRun: async () => ({ ok: true, reason: null, run }),
			heartbeatRun: async () => ({ ok: true, reason: null, run }),
			traceRun: async () => ({ run, stdout: ["a"], stderr: ["b"], log_hints: [".mu/logs/x"], trace_files: [] }),
			stop: async () => {},
		};
		const serverWithRuns = await createServerForTest({ repoRoot: tempDir, controlPlane });

		const listRes = await serverWithRuns.fetch(new Request("http://localhost/api/runs?limit=10"));
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as { count: number; runs: Array<{ job_id: string }> };
		expect(listPayload.count).toBe(1);
		expect(listPayload.runs[0]?.job_id).toBe("run-job-1");

		const getRes = await serverWithRuns.fetch(new Request("http://localhost/api/runs/mu-root1234"));
		expect(getRes.status).toBe(200);
		const getPayload = (await getRes.json()) as { root_issue_id: string };
		expect(getPayload.root_issue_id).toBe("mu-root1234");

		const traceRes = await serverWithRuns.fetch(new Request("http://localhost/api/runs/run-job-1/trace?limit=10"));
		expect(traceRes.status).toBe(200);
		const tracePayload = (await traceRes.json()) as { stdout: string[]; stderr: string[] };
		expect(tracePayload.stdout).toEqual(["a"]);
		expect(tracePayload.stderr).toEqual(["b"]);

		const startRes = await serverWithRuns.fetch(
			new Request("http://localhost/api/runs/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "ship release", max_steps: 20 }),
			}),
		);
		expect(startRes.status).toBe(201);

		const resumeRes = await serverWithRuns.fetch(
			new Request("http://localhost/api/runs/resume", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ root_issue_id: "mu-root1234", max_steps: 20 }),
			}),
		);
		expect(resumeRes.status).toBe(201);

		const interruptRes = await serverWithRuns.fetch(
			new Request("http://localhost/api/runs/interrupt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ root_issue_id: "mu-root1234" }),
			}),
		);
		expect(interruptRes.status).toBe(200);
		const interruptPayload = (await interruptRes.json()) as { ok: boolean };
		expect(interruptPayload.ok).toBe(true);

	});

	test("events API supports issue_id/run_id/contains query filters", async () => {
		const eventsPath = join(tempDir, ".mu", "events.jsonl");
		const rows = [
			{
				v: 1,
				ts_ms: 100,
				type: "backend.run.start",
				source: "backend",
				issue_id: "mu-root-1",
				run_id: "run-1",
				payload: { note: "alpha" },
			},
			{
				v: 1,
				ts_ms: 200,
				type: "backend.run.start",
				source: "backend",
				issue_id: "mu-root-2",
				run_id: "run-2",
				payload: { note: "beta" },
			},
		] as const;
		await Bun.write(eventsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

		const queryRes = await server.fetch(
			new Request(
				"http://localhost/api/events?type=backend.run.start&issue_id=mu-root-1&run_id=run-1&contains=alpha&limit=10",
			),
		);
		expect(queryRes.status).toBe(200);
		const queryEvents = (await queryRes.json()) as Array<{ run_id?: string; issue_id?: string }>;
		expect(queryEvents).toHaveLength(1);
		expect(queryEvents[0]?.run_id).toBe("run-1");
		expect(queryEvents[0]?.issue_id).toBe("mu-root-1");

		const tailRes = await server.fetch(new Request("http://localhost/api/events/tail?n=10&run_id=run-2"));
		expect(tailRes.status).toBe(200);
		const tailEvents = (await tailRes.json()) as Array<{ run_id?: string }>;
		expect(tailEvents).toHaveLength(1);
		expect(tailEvents[0]?.run_id).toBe("run-2");
	});

	test("operator wake delivery telemetry emits queued/duplicate/skipped/delivered/retried/dead-letter states", async () => {
		let wakeDeliveryObserver: ((event: any) => void | Promise<void>) | null = null;

		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitTerminalCommand: async () => ({ kind: "operator_response", message: "autonomous ack" }),
			notifyOperators: async (notifyOpts) => {
				const wakeId = notifyOpts.wake?.wakeId ?? "wake-unknown";
				const dedupeKey = notifyOpts.dedupeKey;
				if (wakeDeliveryObserver) {
					await wakeDeliveryObserver({
						state: "delivered",
						reason_code: "outbox_delivered",
						wake_id: wakeId,
						dedupe_key: dedupeKey,
						binding_id: "binding-telegram",
						channel: "telegram",
						outbox_id: "out-tele-1",
						outbox_dedupe_key: `${dedupeKey}:wake:${wakeId}:telegram:binding-telegram`,
						attempt_count: 0,
					});
					await wakeDeliveryObserver({
						state: "retried",
						reason_code: "telegram_transient",
						wake_id: wakeId,
						dedupe_key: dedupeKey,
						binding_id: "binding-telegram",
						channel: "telegram",
						outbox_id: "out-tele-2",
						outbox_dedupe_key: `${dedupeKey}:wake:${wakeId}:telegram:binding-telegram:retry`,
						attempt_count: 1,
					});
					await wakeDeliveryObserver({
						state: "dead_letter",
						reason_code: "telegram_permanent",
						wake_id: wakeId,
						dedupe_key: dedupeKey,
						binding_id: "binding-telegram",
						channel: "telegram",
						outbox_id: "out-tele-3",
						outbox_dedupe_key: `${dedupeKey}:wake:${wakeId}:telegram:binding-telegram:dead`,
						attempt_count: 6,
					});
				}
				return {
					queued: 1,
					duplicate: 1,
					skipped: 1,
					decisions: [
						{
							state: "queued",
							reason_code: "outbox_enqueued",
							binding_id: "binding-telegram",
							channel: "telegram",
							dedupe_key: `${dedupeKey}:wake:${wakeId}:telegram:binding-telegram`,
							outbox_id: "out-tele-1",
						},
						{
							state: "duplicate",
							reason_code: "outbox_duplicate",
							binding_id: "binding-telegram",
							channel: "telegram",
							dedupe_key: `${dedupeKey}:wake:${wakeId}:telegram:binding-telegram`,
							outbox_id: "out-tele-1",
						},
						{
							state: "skipped",
							reason_code: "channel_delivery_unsupported",
							binding_id: "binding-slack",
							channel: "slack",
							dedupe_key: `${dedupeKey}:wake:${wakeId}:slack:binding-slack`,
							outbox_id: null,
						},
					],
				};
			},
			setWakeDeliveryObserver: (observer) => {
				wakeDeliveryObserver = observer;
			},
			stop: async () => {},
		};

		const wakeServer = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: wakeControlPlane,
			serverOptions: { operatorWakeCoalesceMs: 1_000 },
		});

		const activityStart = await wakeServer.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Wake target", kind: "wake-test", heartbeat_every_ms: 0 }),
			}),
		);
		expect(activityStart.status).toBe(201);
		const activity = (await activityStart.json()) as { activity: { activity_id: string } };

		const heartbeatCreate = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Wake heartbeat",
					every_ms: 0,
					reason: "heartbeat-wake",
				}),
			}),
		);
		expect(heartbeatCreate.status).toBe(201);
		const heartbeatPayload = (await heartbeatCreate.json()) as {
			program: { program_id: string };
		};
		const heartbeatProgramId = heartbeatPayload.program.program_id;

		const heartbeatTrigger = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: heartbeatProgramId, reason: "manual" }),
			}),
		);
		expect(heartbeatTrigger.status).toBe(200);

		const deliveryEvents = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake.delivery&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			return events.length >= 6 ? events : null;
		});
		if (!deliveryEvents) {
			throw new Error("expected wake delivery telemetry events");
		}
		const states = new Set(
			deliveryEvents
				.map((event) => event.payload ?? {})
				.filter((payload) => payload.wake_id)
				.map((payload) => payload.state),
		);
		for (const expected of ["queued", "duplicate", "skipped", "delivered", "retried", "dead_letter"] as const) {
			expect(states.has(expected)).toBe(true);
		}

		const wakePayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const match = events
				.map((event) => event.payload ?? {})
				.find((payload) => payload.program_id === heartbeatProgramId);
			return match ?? null;
		});
		if (!wakePayload) {
			throw new Error("expected wake payload");
		}
		expect(wakePayload.delivery).toEqual({ queued: 1, duplicate: 1, skipped: 1 });
		expect(wakePayload.delivery_summary_v2).toEqual({ queued: 1, duplicate: 1, skipped: 1, total: 3 });
	});

	test("wake_turn_mode active invokes autonomous wake turn path and emits deterministic decision telemetry", async () => {
		const wakeTurns: Array<{ commandText: string; requestId?: string }> = [];
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitTerminalCommand: async (turnOpts) => {
				wakeTurns.push(turnOpts);
				return { kind: "operator_response", message: "autonomous ack" };
			},
			notifyOperators: async () => ({ queued: 0, duplicate: 0, skipped: 0, decisions: [] }),
			stop: async () => {},
		};
		const wakeServer = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: wakeControlPlane,
			serverOptions: { operatorWakeCoalesceMs: 1_000 },
		});

		const configPatch = await wakeServer.fetch(
			new Request("http://localhost/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					patch: {
						control_plane: {
							operator: {
								wake_turn_mode: "active",
							},
						},
					},
				}),
			}),
		);
		expect(configPatch.status).toBe(200);

		const activityStart = await wakeServer.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Wake target", kind: "wake-test", heartbeat_every_ms: 0 }),
			}),
		);
		expect(activityStart.status).toBe(201);
		const activity = (await activityStart.json()) as { activity: { activity_id: string } };

		const heartbeatCreate = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Wake heartbeat",
					every_ms: 0,
					reason: "heartbeat-wake",
				}),
			}),
		);
		expect(heartbeatCreate.status).toBe(201);
		const heartbeatPayload = (await heartbeatCreate.json()) as {
			program: { program_id: string };
		};
		const heartbeatProgramId = heartbeatPayload.program.program_id;

		const heartbeatTrigger = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: heartbeatProgramId, reason: "manual" }),
			}),
		);
		expect(heartbeatTrigger.status).toBe(200);

		const decisionPayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake.decision&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const match = events
				.map((event) => event.payload ?? {})
				.find((payload) => payload.program_id === heartbeatProgramId);
			return match ?? null;
		});
		if (!decisionPayload) {
			throw new Error("expected wake decision payload");
		}

		expect(wakeTurns).toHaveLength(1);
		const wakeTurn = wakeTurns[0];
		const decisionTurnRequestId =
			typeof decisionPayload.turn_request_id === "string" ? decisionPayload.turn_request_id : undefined;
		expect(wakeTurn?.requestId).toBe(decisionTurnRequestId);
		expect(wakeTurn?.requestId).toBe(`wake-turn-${decisionPayload.wake_id as string}`);
		expect(wakeTurn?.commandText).toContain("Autonomous wake turn triggered by heartbeat/cron scheduler.");
		expect(wakeTurn?.commandText).toContain(`wake_id=${decisionPayload.wake_id as string}`);
		expect(wakeTurn?.commandText).toContain("wake_source=heartbeat_program");
		expect(wakeTurn?.commandText).toContain(`program_id=${heartbeatProgramId}`);

		expect(decisionPayload.dedupe_key).toBe(`heartbeat-program:${heartbeatProgramId}`);
		expect(decisionPayload.wake_turn_mode).toBe("active");
		expect(decisionPayload.wake_turn_feature_enabled).toBe(true);
		expect(decisionPayload.wake_turn_outcome).toBe("triggered");
		expect(decisionPayload.wake_turn_reason).toBe("turn_invoked");
		expect(decisionPayload.turn_result_kind).toBe("operator_response");
		expect(typeof decisionPayload.wake_id).toBe("string");
		expect((decisionPayload.wake_id as string).length).toBe(16);

		const wakePayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const match = events
				.map((event) => event.payload ?? {})
				.find((payload) => payload.program_id === heartbeatProgramId);
			return match ?? null;
		});
		if (!wakePayload) {
			throw new Error("expected wake payload");
		}
		expect(wakePayload.wake_id).toBe(decisionPayload.wake_id);
		expect(wakePayload.wake_turn_outcome).toBe("triggered");
		expect(wakePayload.wake_turn_reason).toBe("turn_invoked");
		expect(wakePayload.turn_request_id).toBe(decisionPayload.turn_request_id);
		expect(wakePayload.turn_result_kind).toBe("operator_response");
	});

	test("wake_turn_mode active runs wake→turn→outbound exactly once under repeated wake triggers", async () => {
		const wakeTurns: Array<{ commandText: string; requestId?: string }> = [];
		const notifyCalls: Array<{
			dedupeKey: string;
			wakeId: string | null;
			metadata: Record<string, unknown> | null;
		}> = [];
		let wakeDeliveryObserver: ((event: any) => void | Promise<void>) | null = null;

		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitTerminalCommand: async (turnOpts) => {
				wakeTurns.push(turnOpts);
				return { kind: "operator_response", message: "autonomous ack" };
			},
			notifyOperators: async (notifyOpts) => {
				const wakeId =
					typeof notifyOpts.wake?.wakeId === "string" && notifyOpts.wake.wakeId.length > 0
						? notifyOpts.wake.wakeId
						: null;
				notifyCalls.push({
					dedupeKey: notifyOpts.dedupeKey,
					wakeId,
					metadata:
						notifyOpts.metadata && typeof notifyOpts.metadata === "object"
							? (notifyOpts.metadata as Record<string, unknown>)
							: null,
				});
				if (wakeDeliveryObserver && wakeId) {
					await wakeDeliveryObserver({
						state: "delivered",
						reason_code: "outbox_delivered",
						wake_id: wakeId,
						dedupe_key: notifyOpts.dedupeKey,
						binding_id: "binding-telegram",
						channel: "telegram",
						outbox_id: "out-tele-1",
						outbox_dedupe_key: `${notifyOpts.dedupeKey}:wake:${wakeId}:telegram:binding-telegram`,
						attempt_count: 1,
					});
				}
				const safeWakeId = wakeId ?? "wake-unknown";
				return {
					queued: 1,
					duplicate: 0,
					skipped: 1,
					decisions: [
						{
							state: "queued",
							reason_code: "outbox_enqueued",
							binding_id: "binding-telegram",
							channel: "telegram",
							dedupe_key: `${notifyOpts.dedupeKey}:wake:${safeWakeId}:telegram:binding-telegram`,
							outbox_id: "out-tele-1",
						},
						{
							state: "skipped",
							reason_code: "channel_delivery_unsupported",
							binding_id: "binding-slack",
							channel: "slack",
							dedupe_key: `${notifyOpts.dedupeKey}:wake:${safeWakeId}:slack:binding-slack`,
							outbox_id: null,
						},
					],
				};
			},
			setWakeDeliveryObserver: (observer) => {
				wakeDeliveryObserver = observer;
			},
			stop: async () => {},
		};
		const wakeServer = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: wakeControlPlane,
			serverOptions: { operatorWakeCoalesceMs: 60_000 },
		});

		const configPatch = await wakeServer.fetch(
			new Request("http://localhost/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					patch: {
						control_plane: {
							operator: {
								wake_turn_mode: "active",
							},
						},
					},
				}),
			}),
		);
		expect(configPatch.status).toBe(200);

		const activityStart = await wakeServer.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Wake target", kind: "wake-test", heartbeat_every_ms: 0 }),
			}),
		);
		expect(activityStart.status).toBe(201);
		const activity = (await activityStart.json()) as { activity: { activity_id: string } };

		const heartbeatCreate = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Wake heartbeat",
					every_ms: 0,
					reason: "heartbeat-wake",
				}),
			}),
		);
		expect(heartbeatCreate.status).toBe(201);
		const heartbeatPayload = (await heartbeatCreate.json()) as {
			program: { program_id: string };
		};
		const heartbeatProgramId = heartbeatPayload.program.program_id;

		const heartbeatTriggerBody = JSON.stringify({ program_id: heartbeatProgramId, reason: "manual" });
		const heartbeatTrigger1 = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: heartbeatTriggerBody,
			}),
		);
		expect(heartbeatTrigger1.status).toBe(200);
		const heartbeatTrigger2 = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: heartbeatTriggerBody,
			}),
		);
		expect(heartbeatTrigger2.status).toBe(200);

		const decisionPayloads = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake.decision&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const matches = events
				.map((event) => event.payload ?? {})
				.filter((payload) => payload.program_id === heartbeatProgramId);
			return matches.length >= 1 ? matches : null;
		});
		if (!decisionPayloads) {
			throw new Error("expected wake decision payloads");
		}
		expect(decisionPayloads).toHaveLength(1);
		const decisionPayload = decisionPayloads[0] as Record<string, unknown>;

		const wakePayloads = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const matches = events
				.map((event) => event.payload ?? {})
				.filter((payload) => payload.program_id === heartbeatProgramId);
			return matches.length >= 1 ? matches : null;
		});
		if (!wakePayloads) {
			throw new Error("expected wake payloads");
		}
		expect(wakePayloads).toHaveLength(1);
		const wakePayload = wakePayloads[0] as Record<string, unknown>;

		const deliveryPayloads = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake.delivery&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const matches = events
				.map((event) => event.payload ?? {})
				.filter((payload) => payload.wake_id === decisionPayload.wake_id);
			return matches.length >= 3 ? matches : null;
		});
		if (!deliveryPayloads) {
			throw new Error("expected wake delivery payloads");
		}
		const deliveryStates = new Set(deliveryPayloads.map((payload) => payload.state));
		expect(deliveryStates.has("queued")).toBe(true);
		expect(deliveryStates.has("skipped")).toBe(true);
		expect(deliveryStates.has("delivered")).toBe(true);

		expect(wakeTurns).toHaveLength(1);
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0]?.dedupeKey).toBe(`heartbeat-program:${heartbeatProgramId}`);
		expect(notifyCalls[0]?.wakeId).toBe(decisionPayload.wake_id as string);
		expect(notifyCalls[0]?.metadata).toMatchObject({
			wake_delivery_reason: "heartbeat_cron_wake",
			wake_turn_outcome: "triggered",
			wake_turn_reason: "turn_invoked",
		});

		expect(decisionPayload.wake_turn_outcome).toBe("triggered");
		expect(decisionPayload.wake_turn_reason).toBe("turn_invoked");
		expect(decisionPayload.wake_turn_mode).toBe("active");
		expect(wakePayload.wake_turn_outcome).toBe("triggered");
		expect(wakePayload.wake_turn_reason).toBe("turn_invoked");
		expect(wakePayload.delivery_summary_v2).toEqual({ queued: 1, duplicate: 0, skipped: 1, total: 2 });
		expect(wakePayload.delivery).toEqual({ queued: 1, duplicate: 0, skipped: 1 });
	});

	test("wake_turn_mode active falls back when control-plane wake turn path is unavailable", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			stop: async () => {},
		};
		const wakeServer = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: wakeControlPlane,
		});

		const configPatch = await wakeServer.fetch(
			new Request("http://localhost/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					patch: {
						control_plane: {
							operator: {
								wake_turn_mode: "active",
							},
						},
					},
				}),
			}),
		);
		expect(configPatch.status).toBe(200);

		const activityStart = await wakeServer.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Wake target", kind: "wake-test", heartbeat_every_ms: 0 }),
			}),
		);
		expect(activityStart.status).toBe(201);
		const activity = (await activityStart.json()) as { activity: { activity_id: string } };

		const heartbeatCreate = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Wake heartbeat",
					every_ms: 0,
					reason: "heartbeat-wake",
				}),
			}),
		);
		expect(heartbeatCreate.status).toBe(201);
		const heartbeatPayload = (await heartbeatCreate.json()) as {
			program: { program_id: string };
		};
		const heartbeatProgramId = heartbeatPayload.program.program_id;

		const heartbeatTrigger = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: heartbeatProgramId, reason: "manual" }),
			}),
		);
		expect(heartbeatTrigger.status).toBe(409);

		const decisionPayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake.decision&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const match = events
				.map((event) => event.payload ?? {})
				.find((payload) => payload.program_id === heartbeatProgramId);
			return match ?? null;
		});
		if (!decisionPayload) {
			throw new Error("expected fallback wake decision");
		}
		expect(decisionPayload.wake_turn_outcome).toBe("fallback");
		expect(decisionPayload.wake_turn_reason).toBe("control_plane_unavailable");
		expect(decisionPayload.wake_turn_mode).toBe("active");
		expect(decisionPayload.wake_turn_feature_enabled).toBe(true);

		const wakePayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			const match = events
				.map((event) => event.payload ?? {})
				.find((payload) => payload.program_id === heartbeatProgramId);
			return match ?? null;
		});
		if (!wakePayload) {
			throw new Error("expected fallback wake payload");
		}
		expect(wakePayload.wake_turn_outcome).toBe("fallback");
		expect(wakePayload.wake_turn_reason).toBe("control_plane_unavailable");
	});

	test("activity management APIs support generic long-running tasks", async () => {
		const startRes = await server.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Index docs",
					kind: "indexer",
					heartbeat_every_ms: 0,
					metadata: { scope: "docs" },
				}),
			}),
		);
		expect(startRes.status).toBe(201);
		const started = (await startRes.json()) as {
			ok: boolean;
			activity: { activity_id: string; kind: string; status: string };
		};
		expect(started.ok).toBe(true);
		expect(started.activity.kind).toBe("indexer");
		expect(started.activity.status).toBe("running");
		const activityId = started.activity.activity_id;

		const listRes = await server.fetch(new Request("http://localhost/api/activities?status=running&limit=10"));
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as {
			count: number;
			activities: Array<{ activity_id: string }>;
		};
		expect(listPayload.count).toBeGreaterThanOrEqual(1);
		expect(listPayload.activities.some((activity) => activity.activity_id === activityId)).toBe(true);

		const progressRes = await server.fetch(
			new Request("http://localhost/api/activities/progress", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					activity_id: activityId,
					message: "Indexed 100/500 files",
				}),
			}),
		);
		expect(progressRes.status).toBe(200);

		const heartbeatRes = await server.fetch(
			new Request("http://localhost/api/activities/heartbeat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					activity_id: activityId,
					reason: "manual",
				}),
			}),
		);
		expect(heartbeatRes.status).toBe(200);

		const eventsRes = await server.fetch(
			new Request(`http://localhost/api/activities/${activityId}/events?limit=20`),
		);
		expect(eventsRes.status).toBe(200);
		const eventsPayload = (await eventsRes.json()) as {
			count: number;
			events: Array<{ kind: string }>;
		};
		expect(eventsPayload.count).toBeGreaterThanOrEqual(3);
		expect(eventsPayload.events.some((event) => event.kind === "activity_started")).toBe(true);
		expect(eventsPayload.events.some((event) => event.kind === "activity_progress")).toBe(true);
		expect(eventsPayload.events.some((event) => event.kind === "activity_heartbeat")).toBe(true);

		const completeRes = await server.fetch(
			new Request("http://localhost/api/activities/complete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					activity_id: activityId,
					message: "Index complete",
				}),
			}),
		);
		expect(completeRes.status).toBe(200);
		const completed = (await completeRes.json()) as {
			ok: boolean;
			activity: { status: string; final_message: string | null };
		};
		expect(completed.ok).toBe(true);
		expect(completed.activity.status).toBe("completed");
		expect(completed.activity.final_message).toBe("Index complete");
	});

	test("heartbeat program APIs persist runtime-programmed schedules in .mu/heartbeats.jsonl", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitTerminalCommand: async () => ({ kind: "operator_response", message: "ack" }),
			notifyOperators: async () => ({ queued: 0, duplicate: 0, skipped: 0, decisions: [] }),
			stop: async () => {},
		};
		const wakeServer = await createServerForTest({ repoRoot: tempDir, controlPlane: wakeControlPlane });

		const createRes = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Watch indexing pulse",
					every_ms: 0,
					reason: "watchdog",
					enabled: true,
				}),
			}),
		);
		expect(createRes.status).toBe(201);
		const createPayload = (await createRes.json()) as {
			ok: boolean;
			program: { program_id: string };
		};
		expect(createPayload.ok).toBe(true);
		const programId = createPayload.program.program_id;

		const listRes = await wakeServer.fetch(new Request("http://localhost/api/heartbeats?limit=10"));
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as {
			count: number;
			programs: Array<{ program_id: string }>;
		};
		expect(listPayload.count).toBeGreaterThanOrEqual(1);
		expect(listPayload.programs.some((program) => program.program_id === programId)).toBe(true);

		const triggerRes = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					program_id: programId,
					reason: "manual",
				}),
			}),
		);
		expect(triggerRes.status).toBe(200);
		const triggerPayload = (await triggerRes.json()) as {
			ok: boolean;
			program: { program_id: string; last_result: string | null };
		};
		expect(triggerPayload.ok).toBe(true);
		expect(triggerPayload.program.program_id).toBe(programId);
		expect(triggerPayload.program.last_result).toBe("ok");

		const heartbeatsPath = join(tempDir, ".mu", "heartbeats.jsonl");
		const lines = (await readFile(heartbeatsPath, "utf8"))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { program_id?: string; reason?: string });
		expect(lines.some((row) => row.program_id === programId && row.reason === "watchdog")).toBe(true);
	});

	test("cron program APIs persist schedules, emit events, and restore on startup", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitTerminalCommand: async () => ({ kind: "operator_response", message: "ack" }),
			notifyOperators: async () => ({ queued: 0, duplicate: 0, skipped: 0, decisions: [] }),
			stop: async () => {},
		};
		const cronServer = await createServerForTest({ repoRoot: tempDir, controlPlane: wakeControlPlane });

		const createRes = await cronServer.fetch(
			new Request("http://localhost/api/cron/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Recurring cron pulse",
					schedule_kind: "every",
					every_ms: 50,
					reason: "cron-scheduled",
					enabled: true,
				}),
			}),
		);
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as {
			ok: boolean;
			program: { program_id: string; schedule: { kind: string }; next_run_at_ms: number | null };
		};
		expect(created.ok).toBe(true);
		expect(created.program.schedule.kind).toBe("every");
		const programId = created.program.program_id;

		const getRes = await cronServer.fetch(new Request(`http://localhost/api/cron/${programId}`));
		expect(getRes.status).toBe(200);

		const listRes = await cronServer.fetch(new Request("http://localhost/api/cron?limit=10&schedule_kind=every"));
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as {
			count: number;
			programs: Array<{ program_id: string }>;
		};
		expect(listPayload.count).toBeGreaterThanOrEqual(1);
		expect(listPayload.programs.some((program) => program.program_id === programId)).toBe(true);

		await waitFor(async () => {
			const statusRes = await cronServer.fetch(new Request("http://localhost/api/cron/status"));
			if (statusRes.status !== 200) {
				return null;
			}
			const status = (await statusRes.json()) as { armed_count: number };
			return status.armed_count >= 1 ? true : null;
		});

		const tickedProgram = await waitFor(async () => {
			const res = await cronServer.fetch(new Request(`http://localhost/api/cron/${programId}`));
			if (res.status !== 200) {
				return null;
			}
			const payload = (await res.json()) as {
				last_triggered_at_ms: number | null;
				last_result: string | null;
			};
			if (payload.last_triggered_at_ms != null && payload.last_result != null) {
				return payload;
			}
			return null;
		});
		if (!tickedProgram) {
			throw new Error("expected cron program to tick");
		}
		expect(tickedProgram.last_result).toBe("ok");
		const firstTriggeredAt = tickedProgram.last_triggered_at_ms;
		expect(typeof firstTriggeredAt).toBe("number");

		const eventsRes = await cronServer.fetch(new Request("http://localhost/api/events/tail?n=100"));
		expect(eventsRes.status).toBe(200);
		const events = (await eventsRes.json()) as Array<{ type: string }>;
		expect(events.some((event) => event.type === "cron_program.lifecycle")).toBe(true);
		expect(events.some((event) => event.type === "cron_program.tick")).toBe(true);

		const cronPath = join(tempDir, ".mu", "cron.jsonl");
		const diskRows = (await readFile(cronPath, "utf8"))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { program_id?: string; schedule?: { kind?: string } });
		expect(diskRows.some((row) => row.program_id === programId && row.schedule?.kind === "every")).toBe(true);

		cronServer.cronPrograms.stop();
		cronServer.heartbeatPrograms.stop();
		cronServer.activitySupervisor.stop();

		const restarted = await createServerForTest({ repoRoot: tempDir, controlPlane: wakeControlPlane });
		await Bun.sleep(180);
		const restartedGetRes = await restarted.fetch(new Request(`http://localhost/api/cron/${programId}`));
		expect(restartedGetRes.status).toBe(200);
		const restartedProgram = (await restartedGetRes.json()) as {
			last_triggered_at_ms: number | null;
			last_result: string | null;
		};
		expect(restartedProgram.last_triggered_at_ms).toBeGreaterThan(firstTriggeredAt as number);
		expect(
			restartedProgram.last_result === "ok" || restartedProgram.last_result === "coalesced",
		).toBe(true);

		restarted.cronPrograms.stop();
		restarted.heartbeatPrograms.stop();
		restarted.activitySupervisor.stop();
	});
	test("cron update/trigger/delete endpoints enforce lifecycle semantics", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitTerminalCommand: async () => ({ kind: "operator_response", message: "ack" }),
			notifyOperators: async () => ({ queued: 0, duplicate: 0, skipped: 0, decisions: [] }),
			stop: async () => {},
		};
		const cronServer = await createServerForTest({ repoRoot: tempDir, controlPlane: wakeControlPlane });

		const createRes = await cronServer.fetch(
			new Request("http://localhost/api/cron/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "CRUD cron",
					schedule_kind: "at",
					at_ms: Date.now() + 60_000,
				}),
			}),
		);
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { program: { program_id: string } };
		const programId = created.program.program_id;

		const disableRes = await cronServer.fetch(
			new Request("http://localhost/api/cron/update", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId, enabled: false }),
			}),
		);
		expect(disableRes.status).toBe(200);

		const blockedTriggerRes = await cronServer.fetch(
			new Request("http://localhost/api/cron/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId }),
			}),
		);
		expect(blockedTriggerRes.status).toBe(409);

		const enableRes = await cronServer.fetch(
			new Request("http://localhost/api/cron/update", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId, enabled: true }),
			}),
		);
		expect(enableRes.status).toBe(200);

		const triggerRes = await cronServer.fetch(
			new Request("http://localhost/api/cron/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId, reason: "manual" }),
			}),
		);
		expect(triggerRes.status).toBe(200);

		const deleteRes = await cronServer.fetch(
			new Request("http://localhost/api/cron/delete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId }),
			}),
		);
		expect(deleteRes.status).toBe(200);

		const missingRes = await cronServer.fetch(new Request(`http://localhost/api/cron/${programId}`));
		expect(missingRes.status).toBe(404);
	});

});
