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

	test("context search aggregates historical records across mu state surfaces", async () => {
		const issuesPath = join(tempDir, ".mu", "issues.jsonl");
		const forumPath = join(tempDir, ".mu", "forum.jsonl");
		const eventsPath = join(tempDir, ".mu", "events.jsonl");
		const cpDir = join(tempDir, ".mu", "control-plane");
		const commandsPath = join(cpDir, "commands.jsonl");
		const turnsPath = join(cpDir, "operator_turns.jsonl");
		const conversationsPath = join(cpDir, "operator_conversations.json");
		const cpSessionsDir = join(cpDir, "operator-sessions");
		const cpSessionPath = join(cpSessionsDir, "op-sess-1.jsonl");

		await Bun.write(
			issuesPath,
			`${JSON.stringify({
				id: "mu-issue-1",
				title: "Plan historical memory retrieval",
				body: "Need searchable history of user interactions",
				status: "open",
				outcome: null,
				tags: ["memory", "search"],
				deps: [],
				priority: 2,
				created_at: 1_705_000_000_000,
				updated_at: 1_705_000_010_000,
			})}\n`,
		);
		await Bun.write(
			forumPath,
			`${JSON.stringify({
				topic: "user:context:session-a",
				body: "history is useful context for future turns",
				author: "operator",
				created_at: 1_705_000_020_000,
			})}\n`,
		);
		await Bun.write(
			eventsPath,
			`${JSON.stringify({
				v: 1,
				ts_ms: 1_705_000_030_000,
				type: "operator.wake.delivery",
				source: "mu-server.operator-wake",
				issue_id: "mu-issue-1",
				payload: { message: "history wake" },
			})}\n`,
		);
		await Bun.write(
			commandsPath,
			`${JSON.stringify({
				kind: "command.lifecycle",
				ts_ms: 1_705_000_040_000,
				event_type: "command.accepted",
				command: {
					command_id: "cmd-1",
					command_text: "/mu status history",
					state: "accepted",
					target_type: "status",
					target_id: "status",
					channel: "telegram",
					channel_tenant_id: "tenant-1",
					channel_conversation_id: "chat-1",
					actor_binding_id: "binding-1",
					run_root_id: null,
					operator_session_id: "op-sess-1",
					updated_at_ms: 1_705_000_040_000,
				},
			})}\n`,
		);
		await Bun.write(
			turnsPath,
			`${JSON.stringify({
				kind: "operator.turn",
				ts_ms: 1_705_000_045_000,
				repo_root: tempDir,
				channel: "telegram",
				request_id: "req-1",
				session_id: "op-sess-1",
				turn_id: "turn-1",
				outcome: "respond",
				reason: null,
				message_preview: "History found",
				command: null,
			})}\n`,
		);
		await Bun.write(
			conversationsPath,
			`${JSON.stringify({
				version: 1,
				bindings: {
					"telegram:tenant-1:chat-1:binding-1": "op-sess-1",
				},
			})}\n`,
		);
		await Bun.write(
			cpSessionPath,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "op-sess-1",
					timestamp: "2026-02-20T10:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2026-02-20T10:00:01.000Z",
					message: {
						role: "user",
						content: "Please search interaction history",
					},
				}),
				JSON.stringify({
					type: "message",
					id: "msg-2",
					parentId: "msg-1",
					timestamp: "2026-02-20T10:00:02.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "I can retrieve historical context." }],
					},
				}),
			].join("\n") + "\n",
		);

		const response = await server.fetch(new Request("http://localhost/api/context/search?query=history&limit=50"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			total: number;
			items: Array<{ source_kind: string; text: string }>;
		};
		expect(payload.total).toBeGreaterThan(0);
		const sourceKinds = new Set(payload.items.map((item) => item.source_kind));
		expect(sourceKinds.has("issues")).toBe(true);
		expect(sourceKinds.has("forum")).toBe(true);
		expect(sourceKinds.has("cp_commands")).toBe(true);
		expect(sourceKinds.has("cp_operator_sessions")).toBe(true);
		expect(payload.items.some((item) => item.text.toLowerCase().includes("history"))).toBe(true);
	});

	test("context timeline resolves conversation_key across command + outbox + session history", async () => {
		const cpDir = join(tempDir, ".mu", "control-plane");
		const commandsPath = join(cpDir, "commands.jsonl");
		const outboxPath = join(cpDir, "outbox.jsonl");
		const conversationsPath = join(cpDir, "operator_conversations.json");
		const cpSessionsDir = join(cpDir, "operator-sessions");
		const cpSessionPath = join(cpSessionsDir, "op-sess-2.jsonl");
		const conversationKey = "telegram:tenant-2:chat-9:binding-9";

		await Bun.write(
			commandsPath,
			`${JSON.stringify({
				kind: "command.lifecycle",
				ts_ms: 1_706_000_000_000,
				event_type: "command.accepted",
				command: {
					command_id: "cmd-conv",
					command_text: "/mu run list",
					state: "accepted",
					target_type: "run_list",
					target_id: "run_list",
					channel: "telegram",
					channel_tenant_id: "tenant-2",
					channel_conversation_id: "chat-9",
					actor_binding_id: "binding-9",
					run_root_id: "mu-root-conv",
					operator_session_id: "op-sess-2",
					updated_at_ms: 1_706_000_000_000,
				},
			})}\n`,
		);
		await Bun.write(
			outboxPath,
			`${JSON.stringify({
				kind: "outbox.state",
				ts_ms: 1_706_000_010_000,
				record: {
					outbox_id: "out-9",
					dedupe_key: "dedupe-9",
					state: "pending",
					envelope: {
						v: 1,
						ts_ms: 1_706_000_010_000,
						channel: "telegram",
						channel_tenant_id: "tenant-2",
						channel_conversation_id: "chat-9",
						request_id: "req-9",
						response_id: "resp-9",
						kind: "result",
						body: "Timeline entry via outbox",
						correlation: {
							command_id: "cmd-conv",
							idempotency_key: "idemp-9",
							request_id: "req-9",
							channel: "telegram",
							channel_tenant_id: "tenant-2",
							channel_conversation_id: "chat-9",
							actor_id: "actor-9",
							actor_binding_id: "binding-9",
							assurance_tier: "tier_b",
							repo_root: tempDir,
							scope_required: "operator.read",
							scope_effective: "operator",
							target_type: "run_list",
							target_id: "run_list",
							attempt: 0,
							state: "accepted",
							error_code: null,
							operator_session_id: "op-sess-2",
							operator_turn_id: "turn-9",
							cli_invocation_id: null,
							cli_command_kind: "run_list",
							run_root_id: "mu-root-conv",
						},
						metadata: {},
					},
					created_at_ms: 1_706_000_010_000,
					updated_at_ms: 1_706_000_010_000,
					next_attempt_at_ms: 1_706_000_010_000,
					attempt_count: 0,
					max_attempts: 3,
					last_error: null,
					dead_letter_reason: null,
					replay_of_outbox_id: null,
					replay_requested_by_command_id: null,
				},
			})}\n`,
		);
		await Bun.write(
			conversationsPath,
			`${JSON.stringify({
				version: 1,
				bindings: {
					[conversationKey]: "op-sess-2",
				},
			})}\n`,
		);
		await Bun.write(
			cpSessionPath,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "op-sess-2",
					timestamp: "2026-02-21T09:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "msg-a",
					parentId: null,
					timestamp: "2026-02-21T09:00:01.000Z",
					message: {
						role: "user",
						content: "Need timeline from this chat",
					},
				}),
			].join("\n") + "\n",
		);

		const response = await server.fetch(
			new Request(
				`http://localhost/api/context/timeline?conversation_key=${encodeURIComponent(conversationKey)}&limit=50`,
			),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			items: Array<{ source_kind: string; ts_ms: number; conversation_key: string | null }>;
		};
		expect(payload.items.some((item) => item.source_kind === "cp_commands")).toBe(true);
		expect(payload.items.some((item) => item.source_kind === "cp_outbox")).toBe(true);
		expect(payload.items.some((item) => item.source_kind === "cp_operator_sessions")).toBe(true);

		const timestamps = payload.items.map((item) => item.ts_ms);
		const sorted = [...timestamps].sort((a, b) => a - b);
		expect(timestamps).toEqual(sorted);
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
								vscode: { shared_secret: "vscode-secret" },
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
		expect(byChannel.get("vscode")).toMatchObject({
			channel: "vscode",
			route: "/webhooks/vscode",
			configured: true,
			frontend: true,
		});
		expect(byChannel.get("neovim")?.verification?.kind).toBe("shared_secret_header");
		expect(byChannel.get("vscode")?.verification?.kind).toBe("shared_secret_header");
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

	test("/api/commands/submit maps reload/update kinds to terminal control-plane commands", async () => {
		const submitted: string[] = [];
		const controlPlane: ControlPlaneHandle = {
			activeAdapters: [{ name: "telegram", route: "/webhooks/telegram" }],
			handleWebhook: async () => null,
			submitTerminalCommand: async (opts) => {
				submitted.push(opts.commandText);
				return { kind: "invalid", reason: "stubbed" } as any;
			},
			stop: async () => {},
		};
		const serverWithCommands = await createServerForTest({ repoRoot: tempDir, controlPlane });

		const reloadRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "reload" }),
			}),
		);
		expect(reloadRes.status).toBe(200);

		const updateRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "update" }),
			}),
		);
		expect(updateRes.status).toBe(200);

		const readKindRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "status" }),
			}),
		);
		expect(readKindRes.status).toBe(400);

		expect(submitted).toEqual(["/mu reload", "/mu update"]);
	});

	test("/api/commands/submit supports issue/forum mutation kinds without terminal command dispatch", async () => {
		const submitted: string[] = [];
		const controlPlane: ControlPlaneHandle = {
			activeAdapters: [{ name: "telegram", route: "/webhooks/telegram" }],
			handleWebhook: async () => null,
			submitTerminalCommand: async (opts) => {
				submitted.push(opts.commandText);
				return { kind: "invalid", reason: "stubbed" } as any;
			},
			stop: async () => {},
		};
		const serverWithCommands = await createServerForTest({ repoRoot: tempDir, controlPlane });

		const createRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "issue_create",
					title: "Add query-command cleanup",
					body: "Close out operator tooling cleanup",
					tags: "node:agent,role:worker",
					priority: 2,
				}),
			}),
		);
		expect(createRes.status).toBe(200);
		const createPayload = (await createRes.json()) as {
			result: {
				kind: string;
				command: {
					target_type: string;
					result: { issue: { id: string; status: string } };
				};
			};
		};
		expect(createPayload.result.kind).toBe("completed");
		expect(createPayload.result.command.target_type).toBe("issue create");
		const createdIssueId = createPayload.result.command.result.issue.id;
		expect(createdIssueId.startsWith("mu-")).toBe(true);

		const closeRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "issue_close", id: createdIssueId, outcome: "success" }),
			}),
		);
		expect(closeRes.status).toBe(200);
		const closePayload = (await closeRes.json()) as {
			result: { command: { result: { issue: { status: string; outcome: string } } } };
		};
		expect(closePayload.result.command.result.issue.status).toBe("closed");
		expect(closePayload.result.command.result.issue.outcome).toBe("success");

		const forumRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "forum_post",
					topic: `issue:${createdIssueId}`,
					body: "Closed with success after verification",
					author: "worker",
				}),
			}),
		);
		expect(forumRes.status).toBe(200);

		expect(submitted).toEqual([]);
	});

	test("/api/commands/submit supports session flash mutation kinds without terminal command dispatch", async () => {
		const submitted: string[] = [];
		const controlPlane: ControlPlaneHandle = {
			activeAdapters: [{ name: "telegram", route: "/webhooks/telegram" }],
			handleWebhook: async () => null,
			submitTerminalCommand: async (opts) => {
				submitted.push(opts.commandText);
				return { kind: "invalid", reason: "stubbed" } as any;
			},
			stop: async () => {},
		};
		const serverWithCommands = await createServerForTest({ repoRoot: tempDir, controlPlane });

		const createRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "session_flash_create",
					session_id: "operator-xyz",
					session_kind: "cp_operator",
					body: "ctx-555",
					context_ids: "ctx-555,ctx-556",
				}),
			}),
		);
		expect(createRes.status).toBe(200);
		const createPayload = (await createRes.json()) as {
			result: { command: { target_type: string; result: { flash: { flash_id: string; status: string } } } };
		};
		expect(createPayload.result.command.target_type).toBe("session flash create");
		expect(createPayload.result.command.result.flash.status).toBe("pending");
		const flashId = createPayload.result.command.result.flash.flash_id;

		const ackRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "session_flash_ack", flash_id: flashId }),
			}),
		);
		expect(ackRes.status).toBe(200);
		const ackPayload = (await ackRes.json()) as {
			result: { command: { target_type: string; result: { flash: { status: string } } } };
		};
		expect(ackPayload.result.command.target_type).toBe("session flash ack");
		expect(ackPayload.result.command.result.flash.status).toBe("delivered");

		const invalidTurnRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "session_turn", body: "hello" }),
			}),
		);
		expect(invalidTurnRes.status).toBe(400);

		expect(submitted).toEqual([]);
	});

	test("/api/commands/submit supports heartbeat/cron mutation kinds without terminal command dispatch", async () => {
		const submitted: string[] = [];
		const controlPlane: ControlPlaneHandle = {
			activeAdapters: [{ name: "telegram", route: "/webhooks/telegram" }],
			handleWebhook: async () => null,
			submitTerminalCommand: async (opts) => {
				submitted.push(opts.commandText);
				return { kind: "invalid", reason: "stubbed" } as any;
			},
			stop: async () => {},
		};
		const serverWithCommands = await createServerForTest({ repoRoot: tempDir, controlPlane });

		const activityStartRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Scheduler command target",
					kind: "scheduler-command-test",
					heartbeat_every_ms: 0,
				}),
			}),
		);
		expect(activityStartRes.status).toBe(201);
		const activityStartPayload = (await activityStartRes.json()) as {
			activity: { activity_id: string };
		};
		const activityId = activityStartPayload.activity.activity_id;

		const heartbeatCreateRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "heartbeat_create",
					title: "Manual heartbeat",
					target_kind: "activity",
					activity_id: activityId,
					every_ms: 0,
					reason: "manual",
				}),
			}),
		);
		expect(heartbeatCreateRes.status).toBe(200);
		const heartbeatCreatePayload = (await heartbeatCreateRes.json()) as {
			result: { command: { result: { program: { program_id: string } } } };
		};
		const heartbeatProgramId = heartbeatCreatePayload.result.command.result.program.program_id;
		expect(heartbeatProgramId.startsWith("hb-")).toBe(true);

		const heartbeatTriggerRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "heartbeat_trigger",
					program_id: heartbeatProgramId,
					reason: "manual",
				}),
			}),
		);
		expect(heartbeatTriggerRes.status).toBe(200);

		const heartbeatDisableRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "heartbeat_disable", program_id: heartbeatProgramId }),
			}),
		);
		expect(heartbeatDisableRes.status).toBe(200);

		const heartbeatEnableRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "heartbeat_enable", program_id: heartbeatProgramId }),
			}),
		);
		expect(heartbeatEnableRes.status).toBe(200);

		const heartbeatDeleteRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "heartbeat_delete", program_id: heartbeatProgramId }),
			}),
		);
		expect(heartbeatDeleteRes.status).toBe(200);

		const cronCreateRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "cron_create",
					title: "Manual cron",
					target_kind: "activity",
					activity_id: activityId,
					schedule_kind: "every",
					every_ms: 60_000,
					reason: "cron-manual",
				}),
			}),
		);
		expect(cronCreateRes.status).toBe(200);
		const cronCreatePayload = (await cronCreateRes.json()) as {
			result: { command: { result: { program: { program_id: string } } } };
		};
		const cronProgramId = cronCreatePayload.result.command.result.program.program_id;
		expect(cronProgramId.startsWith("cron-")).toBe(true);

		const cronTriggerRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "cron_trigger", program_id: cronProgramId, reason: "manual" }),
			}),
		);
		expect(cronTriggerRes.status).toBe(200);

		const cronDisableRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "cron_disable", program_id: cronProgramId }),
			}),
		);
		expect(cronDisableRes.status).toBe(200);

		const cronEnableRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "cron_enable", program_id: cronProgramId }),
			}),
		);
		expect(cronEnableRes.status).toBe(200);

		const cronDeleteRes = await serverWithCommands.fetch(
			new Request("http://localhost/api/commands/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "cron_delete", program_id: cronProgramId }),
			}),
		);
		expect(cronDeleteRes.status).toBe(200);

		expect(submitted).toEqual([]);
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

	test("cron/heartbeat wakes stay coalesced and skip autonomous turns when wake_turn_mode is off", async () => {
		const wakeTurns: Array<{ commandText: string; requestId?: string }> = [];
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitTerminalCommand: async (turnOpts) => {
				wakeTurns.push(turnOpts);
				return { kind: "operator_response", message: "ack" };
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
					target_kind: "activity",
					activity_id: activity.activity.activity_id,
					every_ms: 0,
					reason: "heartbeat-wake",
					wake_mode: "immediate",
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

		const cronCreate = await wakeServer.fetch(
			new Request("http://localhost/api/cron/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Wake cron",
					target_kind: "activity",
					activity_id: activity.activity.activity_id,
					schedule_kind: "at",
					at_ms: Date.now() + 60_000,
					wake_mode: "next_heartbeat",
				}),
			}),
		);
		expect(cronCreate.status).toBe(201);
		const cronPayload = (await cronCreate.json()) as { program: { program_id: string } };
		const cronProgramId = cronPayload.program.program_id;

		const cronTrigger = await wakeServer.fetch(
			new Request("http://localhost/api/cron/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: cronProgramId, reason: "manual" }),
			}),
		);
		expect(cronTrigger.status).toBe(200);

		const wakeEvents = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			return events.length >= 2 ? events : null;
		});
		if (!wakeEvents) {
			throw new Error("expected wake events");
		}
		const wakePayloads = wakeEvents.map((event) => event.payload ?? {});
		expect(wakePayloads.some((payload) => payload.wake_source === "heartbeat_program")).toBe(true);
		expect(wakePayloads.some((payload) => payload.wake_source === "cron_program")).toBe(true);
		const heartbeatWakeEvents = wakePayloads.filter(
			(payload) => payload.wake_source === "heartbeat_program" && payload.program_id === heartbeatProgramId,
		);
		expect(heartbeatWakeEvents).toHaveLength(1);
		expect(wakePayloads.every((payload) => payload.decision_outcome === "skipped")).toBe(true);
		expect(wakePayloads.every((payload) => payload.decision_reason === "feature_disabled")).toBe(true);

		const decisionEvents = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/events?type=operator.wake.decision&limit=50"),
			);
			if (response.status !== 200) {
				return null;
			}
			const events = (await response.json()) as Array<{ payload?: Record<string, unknown> }>;
			return events.length >= 2 ? events : null;
		});
		if (!decisionEvents) {
			throw new Error("expected wake decision events");
		}
		const decisions = decisionEvents
			.map((event) => event.payload ?? {})
			.filter((payload) => payload.program_id === heartbeatProgramId || payload.program_id === cronProgramId);
		expect(decisions).toHaveLength(2);
		expect(decisions.every((payload) => payload.outcome === "skipped")).toBe(true);
		expect(decisions.every((payload) => payload.reason === "feature_disabled")).toBe(true);
		expect(decisions.every((payload) => payload.wake_turn_mode === "off")).toBe(true);
		expect(decisions.every((payload) => payload.wake_turn_feature_enabled === false)).toBe(true);
		expect(wakeTurns).toHaveLength(0);
	});

	test("operator wake delivery telemetry emits queued/duplicate/skipped/delivered/retried/dead-letter states", async () => {
		let wakeDeliveryObserver: ((event: any) => void | Promise<void>) | null = null;

		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
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
					target_kind: "activity",
					activity_id: activity.activity.activity_id,
					every_ms: 0,
					reason: "heartbeat-wake",
					wake_mode: "immediate",
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
					target_kind: "activity",
					activity_id: activity.activity.activity_id,
					every_ms: 0,
					reason: "heartbeat-wake",
					wake_mode: "immediate",
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
		expect(decisionPayload.selected_wake_mode).toBe("immediate");
		expect(decisionPayload.wake_turn_mode).toBe("active");
		expect(decisionPayload.wake_turn_feature_enabled).toBe(true);
		expect(decisionPayload.outcome).toBe("triggered");
		expect(decisionPayload.reason).toBe("turn_invoked");
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
		expect(wakePayload.decision_outcome).toBe("triggered");
		expect(wakePayload.decision_reason).toBe("turn_invoked");
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
					target_kind: "activity",
					activity_id: activity.activity.activity_id,
					every_ms: 0,
					reason: "heartbeat-wake",
					wake_mode: "immediate",
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

		expect(decisionPayload.outcome).toBe("triggered");
		expect(decisionPayload.reason).toBe("turn_invoked");
		expect(decisionPayload.wake_turn_mode).toBe("active");
		expect(wakePayload.decision_outcome).toBe("triggered");
		expect(wakePayload.decision_reason).toBe("turn_invoked");
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
					target_kind: "activity",
					activity_id: activity.activity.activity_id,
					every_ms: 0,
					reason: "heartbeat-wake",
					wake_mode: "immediate",
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
			throw new Error("expected fallback wake decision");
		}
		expect(decisionPayload.outcome).toBe("fallback");
		expect(decisionPayload.reason).toBe("control_plane_unavailable");
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
		expect(wakePayload.decision_outcome).toBe("fallback");
		expect(wakePayload.decision_reason).toBe("control_plane_unavailable");
	});

	test("api run start/resume auto-register and auto-disable run heartbeat programs", async () => {
		const runs = new Map<
			string,
			{
				job_id: string;
				mode: "run_start" | "run_resume";
				status: "running" | "completed";
				prompt: string | null;
				root_issue_id: string | null;
				max_steps: number;
				command_id: string | null;
				source: "command" | "api";
				started_at_ms: number;
				updated_at_ms: number;
				finished_at_ms: number | null;
				exit_code: number | null;
				pid: number | null;
				last_progress: string | null;
			}
		>();
		const heartbeatCounts = new Map<string, number>();
		const heartbeatWakeModes: Array<string | null> = [];

		const makeRun = (opts: {
			jobId: string;
			mode: "run_start" | "run_resume";
			rootIssueId: string;
			prompt: string | null;
			maxSteps: number;
		}) => {
			const now = Date.now();
			return {
				job_id: opts.jobId,
				mode: opts.mode,
				status: "running" as const,
				prompt: opts.prompt,
				root_issue_id: opts.rootIssueId,
				max_steps: opts.maxSteps,
				command_id: null,
				source: "api" as const,
				started_at_ms: now,
				updated_at_ms: now,
				finished_at_ms: null,
				exit_code: null,
				pid: 101,
				last_progress: null,
			};
		};

		const resolveRun = (opts: { jobId?: string | null; rootIssueId?: string | null }) => {
			if (opts.jobId) {
				return runs.get(opts.jobId) ?? null;
			}
			if (opts.rootIssueId) {
				for (const run of runs.values()) {
					if (run.root_issue_id === opts.rootIssueId) {
						return run;
					}
				}
			}
			return null;
		};

		const controlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			startRun: async ({ prompt, maxSteps }) => {
				const run = makeRun({
					jobId: "run-job-start",
					mode: "run_start",
					rootIssueId: "mu-root-start",
					prompt,
					maxSteps: maxSteps ?? 20,
				});
				runs.set(run.job_id, run);
				return { ...run };
			},
			resumeRun: async ({ rootIssueId, maxSteps }) => {
				const run = makeRun({
					jobId: "run-job-resume",
					mode: "run_resume",
					rootIssueId,
					prompt: null,
					maxSteps: maxSteps ?? 20,
				});
				runs.set(run.job_id, run);
				return { ...run };
			},
			heartbeatRun: async ({ jobId, rootIssueId, wakeMode }) => {
				heartbeatWakeModes.push(typeof wakeMode === "string" ? wakeMode : null);
				const run = resolveRun({ jobId, rootIssueId });
				if (!run) {
					return { ok: false as const, reason: "not_found" as const, run: null };
				}
				const key = run.job_id;
				const count = (heartbeatCounts.get(key) ?? 0) + 1;
				heartbeatCounts.set(key, count);
				if (count >= 2) {
					run.status = "completed";
					run.updated_at_ms = Date.now();
					run.finished_at_ms = run.updated_at_ms;
					run.exit_code = 0;
					return { ok: false as const, reason: "not_running" as const, run: { ...run } };
				}
				return { ok: true as const, reason: null, run: { ...run } };
			},
			stop: async () => {},
		};

		const serverWithAuto = await createServerForTest({
			repoRoot: tempDir,
			controlPlane,
			serverOptions: { autoRunHeartbeatEveryMs: 5_000 },
		});

		const startRes = await serverWithAuto.fetch(
			new Request("http://localhost/api/runs/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "ship", max_steps: 12 }),
			}),
		);
		expect(startRes.status).toBe(201);

		const resumeRes = await serverWithAuto.fetch(
			new Request("http://localhost/api/runs/resume", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ root_issue_id: "mu-root-resume", max_steps: 13 }),
			}),
		);
		expect(resumeRes.status).toBe(201);

		const listRes = await serverWithAuto.fetch(
			new Request("http://localhost/api/heartbeats?target_kind=run&limit=20"),
		);
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as {
			programs: Array<{
				program_id: string;
				enabled: boolean;
				wake_mode: string;
				metadata: Record<string, unknown>;
			}>;
		};
		const autoPrograms = listPayload.programs.filter((program) => program.metadata.auto_run_heartbeat === true);
		expect(autoPrograms).toHaveLength(2);
		for (const program of autoPrograms) {
			expect(program.enabled).toBe(true);
			expect(program.wake_mode).toBe("next_heartbeat");
		}

		for (const program of autoPrograms) {
			const triggerBody = JSON.stringify({ program_id: program.program_id, reason: "manual" });
			const trigger1 = await serverWithAuto.fetch(
				new Request("http://localhost/api/heartbeats/trigger", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: triggerBody,
				}),
			);
			expect(trigger1.status).toBe(200);
			const trigger2 = await serverWithAuto.fetch(
				new Request("http://localhost/api/heartbeats/trigger", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: triggerBody,
				}),
			);
			expect(trigger2.status).toBe(200);

			const getRes = await serverWithAuto.fetch(
				new Request(`http://localhost/api/heartbeats/${encodeURIComponent(program.program_id)}`),
			);
			expect(getRes.status).toBe(200);
			const latest = (await getRes.json()) as { enabled: boolean; every_ms: number; last_result: string | null };
			expect(latest.enabled).toBe(false);
			expect(latest.every_ms).toBe(0);
			expect(latest.last_result).toBe("not_running");
		}

		expect(heartbeatWakeModes.filter((value) => value === "next_heartbeat").length).toBeGreaterThanOrEqual(2);

		const lifecycleResponse = await serverWithAuto.fetch(
			new Request("http://localhost/api/events?type=run.auto_heartbeat.lifecycle&limit=50"),
		);
		expect(lifecycleResponse.status).toBe(200);
		const lifecycleEvents = (await lifecycleResponse.json()) as Array<{ payload?: Record<string, unknown> }>;
		const actions = lifecycleEvents.map((event) => String(event.payload?.action ?? ""));
		expect(actions.filter((action) => action === "registered").length).toBe(2);
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

	test("cron program APIs persist schedules, emit events, and restore on startup", async () => {
		const activityStart = await server.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Cron API target",
					kind: "cron-test",
					heartbeat_every_ms: 0,
				}),
			}),
		);
		expect(activityStart.status).toBe(201);
		const activity = (await activityStart.json()) as { activity: { activity_id: string } };
		const activityId = activity.activity.activity_id;

		const createRes = await server.fetch(
			new Request("http://localhost/api/cron/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Recurring cron pulse",
					target_kind: "activity",
					activity_id: activityId,
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

		const getRes = await server.fetch(new Request(`http://localhost/api/cron/${programId}`));
		expect(getRes.status).toBe(200);

		const listRes = await server.fetch(new Request("http://localhost/api/cron?limit=10&schedule_kind=every"));
		expect(listRes.status).toBe(200);
		const listPayload = (await listRes.json()) as {
			count: number;
			programs: Array<{ program_id: string }>;
		};
		expect(listPayload.count).toBeGreaterThanOrEqual(1);
		expect(listPayload.programs.some((program) => program.program_id === programId)).toBe(true);

		await waitFor(async () => {
			const statusRes = await server.fetch(new Request("http://localhost/api/cron/status"));
			if (statusRes.status !== 200) {
				return null;
			}
			const status = (await statusRes.json()) as { armed_count: number };
			return status.armed_count >= 1 ? true : null;
		});

		const tickedProgram = await waitFor(async () => {
			const res = await server.fetch(new Request(`http://localhost/api/cron/${programId}`));
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

		const eventsRes = await server.fetch(new Request("http://localhost/api/events/tail?n=100"));
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

		server.cronPrograms.stop();
		server.heartbeatPrograms.stop();
		server.activitySupervisor.stop();

		const restarted = await createServerForTest({ repoRoot: tempDir });
		await Bun.sleep(180);
		const restartedGetRes = await restarted.fetch(new Request(`http://localhost/api/cron/${programId}`));
		expect(restartedGetRes.status).toBe(200);
		const restartedProgram = (await restartedGetRes.json()) as {
			last_triggered_at_ms: number | null;
			last_result: string | null;
		};
		expect(restartedProgram.last_triggered_at_ms).toBeGreaterThan(firstTriggeredAt as number);
		expect(restartedProgram.last_result).toBe("not_found");

		restarted.cronPrograms.stop();
		restarted.heartbeatPrograms.stop();
		restarted.activitySupervisor.stop();
	});

	test("cron update/trigger/delete endpoints enforce lifecycle semantics", async () => {
		const activityStart = await server.fetch(
			new Request("http://localhost/api/activities/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Cron CRUD target", kind: "cron-crud", heartbeat_every_ms: 0 }),
			}),
		);
		expect(activityStart.status).toBe(201);
		const activity = (await activityStart.json()) as { activity: { activity_id: string } };

		const createRes = await server.fetch(
			new Request("http://localhost/api/cron/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "CRUD cron",
					target_kind: "activity",
					activity_id: activity.activity.activity_id,
					schedule_kind: "at",
					at_ms: Date.now() + 60_000,
				}),
			}),
		);
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { program: { program_id: string } };
		const programId = created.program.program_id;

		const disableRes = await server.fetch(
			new Request("http://localhost/api/cron/update", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId, enabled: false }),
			}),
		);
		expect(disableRes.status).toBe(200);

		const blockedTriggerRes = await server.fetch(
			new Request("http://localhost/api/cron/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId }),
			}),
		);
		expect(blockedTriggerRes.status).toBe(409);

		const enableRes = await server.fetch(
			new Request("http://localhost/api/cron/update", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId, enabled: true }),
			}),
		);
		expect(enableRes.status).toBe(200);

		const triggerRes = await server.fetch(
			new Request("http://localhost/api/cron/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId, reason: "manual" }),
			}),
		);
		expect(triggerRes.status).toBe(200);

		const deleteRes = await server.fetch(
			new Request("http://localhost/api/cron/delete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ program_id: programId }),
			}),
		);
		expect(deleteRes.status).toBe(200);

		const missingRes = await server.fetch(new Request(`http://localhost/api/cron/${programId}`));
		expect(missingRes.status).toBe(404);
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

		test("list issues rejects invalid status filters", async () => {
			const response = await server.fetch(new Request("http://localhost/api/issues?status=bogus"));
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid issue status filter");
		});

		test("list issues supports contains + limit query bounds", async () => {
			await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "alpha" }),
				}),
			);
			await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "beta", body: "contains worker marker" }),
				}),
			);
			await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "gamma", body: "another WORKER marker" }),
				}),
			);

			const response = await server.fetch(new Request("http://localhost/api/issues?contains=worker&limit=1"));
			expect(response.status).toBe(200);
			const issues = (await response.json()) as Array<{ title: string }>;
			expect(issues).toHaveLength(1);
			expect(issues[0]?.title).toBe("gamma");
		});

		test("list issues rejects invalid limits", async () => {
			const response = await server.fetch(new Request("http://localhost/api/issues?limit=0"));
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid issue query limit");
		});

		test("create issue rejects invalid json", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{",
				}),
			);
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid json body");
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

		test("get issue rejects invalid id encoding", async () => {
			const response = await server.fetch(new Request("http://localhost/api/issues/%E0%A4%A"));
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid issue id encoding");
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

		test("update issue returns 404 for unknown ids", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/issues/mu-missing", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Updated title" }),
				}),
			);

			expect(response.status).toBe(404);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("issue not found");
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

		test("close issue returns 404 for unknown ids", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/issues/mu-missing/close", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ outcome: "success" }),
				}),
			);

			expect(response.status).toBe(404);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("issue not found");
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

		test("ready issues supports contains + limit query bounds", async () => {
			await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "worker alpha" }),
				}),
			);
			await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "worker beta" }),
				}),
			);

			const response = await server.fetch(new Request("http://localhost/api/issues/ready?contains=worker&limit=1"));
			expect(response.status).toBe(200);
			const issues = (await response.json()) as Array<{ title: string }>;
			expect(issues).toHaveLength(1);
			expect(issues[0]?.title).toContain("worker");
		});

		test("ready issues rejects invalid limits", async () => {
			const response = await server.fetch(new Request("http://localhost/api/issues/ready?limit=0"));
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid issue query limit");
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

		test("read messages rejects invalid limits", async () => {
			const response = await server.fetch(new Request("http://localhost/api/forum/read?topic=test:topic&limit=0"));
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid limit");
		});

		test("post message rejects invalid json", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{",
				}),
			);
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid json body");
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

		test("list topics supports limit query bounds", async () => {
			for (let i = 0; i < 5; i += 1) {
				await server.fetch(
					new Request("http://localhost/api/forum/post", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							topic: `topic:${i}`,
							body: `Message ${i}`,
						}),
					}),
				);
			}

			const response = await server.fetch(new Request("http://localhost/api/forum/topics?limit=2"));
			expect(response.status).toBe(200);
			const topics = (await response.json()) as Array<{ topic: string }>;
			expect(topics).toHaveLength(2);
			expect(topics[0]?.topic).toBe("topic:4");
		});

		test("list topics rejects invalid limits", async () => {
			const response = await server.fetch(new Request("http://localhost/api/forum/topics?limit=0"));
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toContain("invalid topics limit");
		});
	});
});
