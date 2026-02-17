import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneHandle } from "../src/control_plane.js";
import { createServer } from "../src/server.js";

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
		server = createServer({ repoRoot: tempDir });
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
			open_count: 0,
			ready_count: 0,
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
		const serverWithControlPlane = createServer({
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

		const serverWithReload = createServer({
			repoRoot: tempDir,
			controlPlane: initial,
			controlPlaneReloader: async ({ previous }) => {
				expect(previous).toBe(initial);
				return reloaded;
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

		const serverWithReload = createServer({
			repoRoot: tempDir,
			controlPlane: initial,
			controlPlaneReloader: async () => {
				throw new Error("reload failed");
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

		const serverWithReload = createServer({
			repoRoot: tempDir,
			controlPlane: initial,
			controlPlaneReloader: async () => reloaded,
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
		const serverWithRuns = createServer({ repoRoot: tempDir, controlPlane });

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

		const heartbeatRes = await serverWithRuns.fetch(
			new Request("http://localhost/api/runs/heartbeat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ root_issue_id: "mu-root1234", reason: "manual" }),
			}),
		);
		expect(heartbeatRes.status).toBe(200);
		const heartbeatPayload = (await heartbeatRes.json()) as { ok: boolean };
		expect(heartbeatPayload.ok).toBe(true);
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

		const eventsRes = await server.fetch(new Request(`http://localhost/api/activities/${activityId}/events?limit=20`));
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
		const activityStart = await server.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Watch indexing",
					kind: "watcher",
					heartbeat_every_ms: 0,
				}),
			}),
		);
		expect(activityStart.status).toBe(201);
		const activityPayload = (await activityStart.json()) as {
			activity: { activity_id: string };
		};
		const activityId = activityPayload.activity.activity_id;

		const createRes = await server.fetch(
			new Request("http://localhost/api/heartbeats/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Watch indexing pulse",
					target_kind: "activity",
					activity_id: activityId,
					every_ms: 0,
					reason: "watchdog",
					enabled: true,
				}),
			}),
		);
		expect(createRes.status).toBe(201);
		const createPayload = (await createRes.json()) as {
			ok: boolean;
			program: { program_id: string; target: { kind: string } };
		};
		expect(createPayload.ok).toBe(true);
		expect(createPayload.program.target.kind).toBe("activity");
		const programId = createPayload.program.program_id;

		const listRes = await server.fetch(new Request("http://localhost/api/heartbeats?limit=10"));
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as {
			count: number;
			programs: Array<{ program_id: string }>;
		};
		expect(listPayload.count).toBeGreaterThanOrEqual(1);
		expect(listPayload.programs.some((program) => program.program_id === programId)).toBe(true);

		const triggerRes = await server.fetch(
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

		const activityEventsRes = await server.fetch(
			new Request(`http://localhost/api/activities/${activityId}/events?limit=20`),
		);
		expect(activityEventsRes.status).toBe(200);
		const activityEvents = (await activityEventsRes.json()) as {
			events: Array<{ kind: string }>;
		};
		expect(activityEvents.events.some((event) => event.kind === "activity_heartbeat")).toBe(true);

		const heartbeatsPath = join(tempDir, ".mu", "heartbeats.jsonl");
		const lines = (await readFile(heartbeatsPath, "utf8"))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { program_id?: string; target?: { kind?: string } });
		expect(lines.some((row) => row.program_id === programId && row.target?.kind === "activity")).toBe(true);
	});

	describe("issues API", () => {
		test("create issue", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						title: "Test issue",
						body: "Test body",
						tags: ["test"],
						priority: 2,
					}),
				}),
			);

			expect(response.status).toBe(201);
			const issue = await response.json();
			expect(issue.title).toBe("Test issue");
			expect(issue.body).toBe("Test body");
			expect(issue.tags).toEqual(["test"]);
			expect(issue.priority).toBe(2);
			expect(issue.status).toBe("open");
			expect(issue.id).toMatch(/^mu-/);
		});

		test("list issues", async () => {
			// Create an issue first
			await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" }),
				}),
			);

			const response = await server.fetch(new Request("http://localhost/api/issues"));

			expect(response.status).toBe(200);
			const issues = await response.json();
			expect(issues).toHaveLength(1);
			expect(issues[0].title).toBe("Test issue");
		});

		test("get issue by id", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" }),
				}),
			);
			const created = await createResponse.json();

			const response = await server.fetch(new Request(`http://localhost/api/issues/${created.id}`));

			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.id).toBe(created.id);
			expect(issue.title).toBe("Test issue");
		});

		test("update issue", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" }),
				}),
			);
			const created = await createResponse.json();

			const response = await server.fetch(
				new Request(`http://localhost/api/issues/${created.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						title: "Updated title",
						status: "in_progress",
					}),
				}),
			);

			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.title).toBe("Updated title");
			expect(issue.status).toBe("in_progress");
		});

		test("close issue", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" }),
				}),
			);
			const created = await createResponse.json();

			const response = await server.fetch(
				new Request(`http://localhost/api/issues/${created.id}/close`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ outcome: "success" }),
				}),
			);

			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.status).toBe("closed");
			expect(issue.outcome).toBe("success");
		});

		test("claim issue", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" }),
				}),
			);
			const created = await createResponse.json();

			const response = await server.fetch(
				new Request(`http://localhost/api/issues/${created.id}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				}),
			);

			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.status).toBe("in_progress");
		});
	});

	describe("forum API", () => {
		test("post message", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic",
						body: "Test message",
						author: "tester",
					}),
				}),
			);

			expect(response.status).toBe(201);
			const message = await response.json();
			expect(message.topic).toBe("test:topic");
			expect(message.body).toBe("Test message");
			expect(message.author).toBe("tester");
		});

		test("read messages", async () => {
			// Post a message first
			await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic",
						body: "Test message",
					}),
				}),
			);

			const response = await server.fetch(new Request("http://localhost/api/forum/read?topic=test:topic"));

			expect(response.status).toBe(200);
			const messages = await response.json();
			expect(messages).toHaveLength(1);
			expect(messages[0].topic).toBe("test:topic");
			expect(messages[0].body).toBe("Test message");
		});

		test("list topics", async () => {
			// Post messages to different topics
			await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic1",
						body: "Message 1",
					}),
				}),
			);

			await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic2",
						body: "Message 2",
					}),
				}),
			);

			const response = await server.fetch(new Request("http://localhost/api/forum/topics"));

			expect(response.status).toBe(200);
			const topics = await response.json();
			expect(topics).toHaveLength(2);
			expect(topics.map((t: any) => t.topic)).toContain("test:topic1");
			expect(topics.map((t: any) => t.topic)).toContain("test:topic2");
		});
	});
});
