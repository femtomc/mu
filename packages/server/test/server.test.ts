import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FsJsonlStore, getStorePaths } from "@femtomc/mu-core/node";
import { IssueStore } from "@femtomc/mu-issue";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneHandle } from "../src/control_plane.js";
import { UI_COMPONENT_SUPPORT } from "../src/control_plane.js";
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

const TEXT_ONLY_UI_COMPONENT_SUPPORT = {
	text: true,
	list: false,
	key_value: false,
	divider: false,
} as const;

const STATUS_PROFILE_ACTIONS_FALLBACK_REASON = "status_profile_actions_degrade_to_text";

const CHANNEL_UI_CAPABILITIES = {
	slack: {
		supported: true,
		reason: null,
		components: UI_COMPONENT_SUPPORT,
		actions: {
			supported: true,
			reason: STATUS_PROFILE_ACTIONS_FALLBACK_REASON,
		},
	},
	discord: {
		supported: true,
		reason: null,
		components: TEXT_ONLY_UI_COMPONENT_SUPPORT,
		actions: {
			supported: true,
			reason: STATUS_PROFILE_ACTIONS_FALLBACK_REASON,
		},
	},
	telegram: {
		supported: true,
		reason: null,
		components: TEXT_ONLY_UI_COMPONENT_SUPPORT,
		actions: {
			supported: true,
			reason: STATUS_PROFILE_ACTIONS_FALLBACK_REASON,
		},
	},
	neovim: {
		supported: true,
		reason: null,
		components: TEXT_ONLY_UI_COMPONENT_SUPPORT,
		actions: {
			supported: true,
			reason: STATUS_PROFILE_ACTIONS_FALLBACK_REASON,
		},
	},
};

function expectedUiCapability(channel: string) {
	return CHANNEL_UI_CAPABILITIES[channel as keyof typeof CHANNEL_UI_CAPABILITIES];
}

describe("mu-server", () => {
	let tempDir: string;
	let server: any;

	beforeEach(async () => {
		// Create a temporary directory for test data
		tempDir = await mkdtemp(join(tmpdir(), "mu-server-test-"));

		// Create workspace store structure
		const storeDir = getStorePaths(tempDir).storeDir;
		await Bun.write(join(storeDir, "issues.jsonl"), "");
		await Bun.write(join(storeDir, "forum.jsonl"), "");
		await Bun.write(join(storeDir, "events.jsonl"), "");

		// Create server instance
		server = await createServerForTest({ repoRoot: tempDir });
	});

	afterEach(async () => {
		await server?.controlPlane?.stop?.().catch(() => {});
		// Clean up temp directory
		await rm(tempDir, { recursive: true, force: true });
	});

	test("health check endpoint", async () => {
		const response = await server.fetch(new Request("http://localhost/healthz"));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");

		const legacy = await server.fetch(new Request("http://localhost/health"));
		expect(legacy.status).toBe(404);
	});

	test("status endpoint", async () => {
		const response = await server.fetch(new Request("http://localhost/api/control-plane/status"));
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

		expect(calls).toEqual([]);

		await runtime.controlPlane.stop();
	});

	test("config endpoint returns default config shape", async () => {
		const response = await server.fetch(new Request("http://localhost/api/control-plane/config"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			config_path: string;
			config: {
				control_plane: {
					adapters: {
						slack: { signing_secret: string | null };
					};
					operator: { enabled: boolean };
					memory_index: { enabled: boolean; every_ms: number };
				};
			};
			presence: {
				control_plane: {
					adapters: {
						slack: { signing_secret: boolean };
					};
					memory_index: { enabled: boolean; every_ms: number };
				};
			};
		};
		expect(payload.config_path).toBe(join(getStorePaths(tempDir).storeDir, "config.json"));
		expect(payload.config.control_plane.adapters.slack.signing_secret).toBeNull();
		expect(payload.config.control_plane.operator.enabled).toBe(true);
		expect(payload.config.control_plane.memory_index.enabled).toBe(true);
		expect(payload.config.control_plane.memory_index.every_ms).toBe(300_000);
		expect(payload.presence.control_plane.adapters.slack.signing_secret).toBe(false);
		expect(payload.presence.control_plane.memory_index.enabled).toBe(true);
	});

	test("config endpoint applies patch and persists to workspace config.json", async () => {
		const response = await server.fetch(
			new Request("http://localhost/api/control-plane/config", {
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
					memory_index: { enabled: boolean };
				};
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.presence.control_plane.adapters.slack.signing_secret).toBe(true);
		expect(payload.presence.control_plane.operator.enabled).toBe(false);
		expect(payload.presence.control_plane.memory_index.enabled).toBe(true);

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

		const response = await serverWithControlPlane.fetch(new Request("http://localhost/api/control-plane/status"));
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
			new Request("http://localhost/api/control-plane/config", {
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
				ingress_mode: "command_only" | "conversational";
				verification: { kind?: string; secret_header?: string };
				media: {
					outbound_delivery: { supported: boolean; configured: boolean; reason: string | null };
					inbound_attachment_download: { supported: boolean; configured: boolean; reason: string | null };
				};
				ui: {
					supported: boolean;
					reason: string | null;
					components: {
						text: boolean;
						list: boolean;
						key_value: boolean;
						divider: boolean;
					};
					actions: {
						supported: boolean;
						reason: string | null;
					};
				};
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
			ingress_mode: "conversational",
		});
		expect(byChannel.get("neovim")?.verification?.kind).toBe("shared_secret_header");
		expect(byChannel.get("neovim")?.media.outbound_delivery).toMatchObject({
			supported: false,
			configured: false,
			reason: "channel_media_delivery_unsupported",
		});
		expect(byChannel.get("slack")?.media.outbound_delivery).toMatchObject({
			supported: true,
			configured: false,
			reason: "slack_bot_token_missing",
		});
		expect(byChannel.get("telegram")?.ingress_mode).toBe("conversational");
		expect(byChannel.get("telegram")?.media.inbound_attachment_download).toMatchObject({
			supported: true,
			configured: false,
			reason: "telegram_bot_token_missing",
		});
		for (const channelName of ["neovim", "slack", "telegram", "discord"]) {
			expect(byChannel.get(channelName)?.ui).toEqual(expectedUiCapability(channelName));
		}
	});

	test("control-plane channels endpoint reports configured media capabilities for Slack and Telegram tokens", async () => {
		const serverWithControlPlane = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: {
				activeAdapters: [
					{ name: "slack", route: "/webhooks/slack" },
					{ name: "telegram", route: "/webhooks/telegram" },
				],
				handleWebhook: async () => null,
				stop: async () => {},
			},
		});

		const patchRes = await serverWithControlPlane.fetch(
			new Request("http://localhost/api/control-plane/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					patch: {
						control_plane: {
							adapters: {
								slack: { signing_secret: "slack-secret", bot_token: "xoxb-media" },
								telegram: {
									webhook_secret: "telegram-secret",
									bot_token: "telegram-media-token",
									bot_username: "mu_bot",
								},
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
			channels: Array<{
				channel: string;
				configured: boolean;
				active: boolean;
				media: {
					outbound_delivery: { supported: boolean; configured: boolean; reason: string | null };
					inbound_attachment_download: { supported: boolean; configured: boolean; reason: string | null };
				};
				ui: {
					supported: boolean;
					reason: string | null;
					components: {
						text: boolean;
						list: boolean;
						key_value: boolean;
						divider: boolean;
					};
					actions: {
						supported: boolean;
						reason: string | null;
					};
				};
			}>;
		};
		const byChannel = new Map(payload.channels.map((entry) => [entry.channel, entry]));

		expect(byChannel.get("slack")?.configured).toBe(true);
		expect(byChannel.get("slack")?.active).toBe(true);
		expect(byChannel.get("slack")?.media.outbound_delivery).toMatchObject({
			supported: true,
			configured: true,
			reason: null,
		});
		expect(byChannel.get("slack")?.media.inbound_attachment_download).toMatchObject({
			supported: true,
			configured: true,
			reason: null,
		});

		expect(byChannel.get("telegram")?.configured).toBe(true);
		expect(byChannel.get("telegram")?.active).toBe(true);
		expect(byChannel.get("telegram")?.media.outbound_delivery).toMatchObject({
			supported: true,
			configured: true,
			reason: null,
		});
		expect(byChannel.get("telegram")?.media.inbound_attachment_download).toMatchObject({
			supported: true,
			configured: true,
			reason: null,
		});
		for (const channelName of ["slack", "telegram"]) {
			expect(byChannel.get(channelName)?.ui).toEqual(expectedUiCapability(channelName));
		}
	});

	test("control-plane turn endpoint requires a configured neovim shared secret", async () => {
		const response = await server.fetch(
			new Request("http://localhost/api/control-plane/turn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session_id: "operator-1", body: "hello" }),
			}),
		);
		expect(response.status).toBe(503);
		const payload = (await response.json()) as { error?: string };
		expect(payload.error).toContain("shared secret");
	});

	test("control-plane turn endpoint requires shared-secret header when configured", async () => {
		const patchRes = await server.fetch(
			new Request("http://localhost/api/control-plane/config", {
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

		const response = await server.fetch(
			new Request("http://localhost/api/control-plane/turn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session_id: "operator-1", body: "hello" }),
			}),
		);
		expect(response.status).toBe(401);
		const payload = (await response.json()) as { error?: string };
		expect(payload.error).toContain("missing x-mu-neovim-secret");
	});

	test("control-plane turn endpoint validates required fields before execution", async () => {
		const patchRes = await server.fetch(
			new Request("http://localhost/api/control-plane/config", {
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

		const response = await server.fetch(
			new Request("http://localhost/api/control-plane/turn", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-mu-neovim-secret": "nvim-secret",
				},
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

		const statusResponse = await serverWithReload.fetch(new Request("http://localhost/api/control-plane/status"));
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

		const statusResponse = await serverWithReload.fetch(new Request("http://localhost/api/control-plane/status"));
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



	test("events API supports issue_id/run_id/contains query filters", async () => {
		const eventsPath = getStorePaths(tempDir).eventsPath;
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
				"http://localhost/api/control-plane/events?type=backend.run.start&issue_id=mu-root-1&run_id=run-1&contains=alpha&limit=10",
			),
		);
		expect(queryRes.status).toBe(200);
		const queryEvents = (await queryRes.json()) as Array<{ run_id?: string; issue_id?: string }>;
		expect(queryEvents).toHaveLength(1);
		expect(queryEvents[0]?.run_id).toBe("run-1");
		expect(queryEvents[0]?.issue_id).toBe("mu-root-1");

		const tailRes = await server.fetch(new Request("http://localhost/api/control-plane/events/tail?n=10&run_id=run-2"));
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
			submitAutonomousIngress: async () => ({ kind: "operator_response", message: "autonomous ack" }),
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
				new Request("http://localhost/api/control-plane/events?type=operator.wake.delivery&limit=50"),
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
				new Request("http://localhost/api/control-plane/events?type=operator.wake&limit=50"),
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

	test("operator wake invokes autonomous wake turn path and emits deterministic decision telemetry", async () => {
		const wakeTurns: Array<{ text: string; requestId?: string; metadata?: Record<string, unknown> }> = [];
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitAutonomousIngress: async (turnOpts) => {
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


		const heartbeatPrompt = "Review backlog and execute one highest-priority task.";
		const heartbeatCreate = await wakeServer.fetch(
			new Request("http://localhost/api/heartbeats/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Wake heartbeat",
					prompt: heartbeatPrompt,
					every_ms: 0,
					reason: "heartbeat-wake",
					operator_provider: "openrouter",
					operator_model: "google/gemini-3.1-pro-preview",
					operator_thinking: "high",
					context_session_file: ".mu/control-plane/operator-sessions/checkpoint-hb.jsonl",
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
				new Request("http://localhost/api/control-plane/events?type=operator.wake.decision&limit=50"),
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
		expect(wakeTurn?.text).toContain("Autonomous wake turn triggered by heartbeat/cron scheduler.");
		expect(wakeTurn?.text).toContain(`wake_id=${decisionPayload.wake_id as string}`);
		expect(wakeTurn?.text).toContain("wake_source=heartbeat_program");
		expect(wakeTurn?.text).toContain(`program_id=${heartbeatProgramId}`);
		expect(wakeTurn?.text).toContain(heartbeatPrompt);
		expect(wakeTurn?.metadata?.operator_provider).toBe("openrouter");
		expect(wakeTurn?.metadata?.operator_model).toBe("google/gemini-3.1-pro-preview");
		expect(wakeTurn?.metadata?.operator_thinking).toBe("high");
		expect(wakeTurn?.metadata?.operator_session_id).toBe(`heartbeat-program:${heartbeatProgramId}`);
		expect(wakeTurn?.metadata?.operator_session_file).toBe(
			".mu/control-plane/operator-sessions/checkpoint-hb.jsonl",
		);

		expect(decisionPayload.dedupe_key).toBe(`heartbeat-program:${heartbeatProgramId}`);
		expect(decisionPayload.wake_turn_outcome).toBe("triggered");
		expect(decisionPayload.wake_turn_reason).toBe("turn_invoked");
		expect(decisionPayload.turn_result_kind).toBe("operator_response");
		expect(typeof decisionPayload.wake_id).toBe("string");
		expect((decisionPayload.wake_id as string).length).toBe(16);

		const wakePayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/control-plane/events?type=operator.wake&limit=50"),
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
		expect(wakePayload.prompt).toBe(heartbeatPrompt);
	});

	test("operator wake fallback-coded responses mark heartbeat ticks failed", async () => {
		const fallbackMessage = [
			"I could not complete that turn safely.",
			"Code: operator_provider_usage_limit",
			"The configured operator provider rejected the turn due to usage or quota limits.",
			"You can retry this request in plain conversational text.",
		].join("\n");
		const notifyCalls: Array<{ message: string; metadata: Record<string, unknown> | null }> = [];
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitAutonomousIngress: async () => ({ kind: "operator_response", message: fallbackMessage }),
			notifyOperators: async (notifyOpts) => {
				notifyCalls.push({
					message: notifyOpts.message,
					metadata:
						notifyOpts.metadata && typeof notifyOpts.metadata === "object"
							? (notifyOpts.metadata as Record<string, unknown>)
							: null,
				});
				return { queued: 0, duplicate: 0, skipped: 0, decisions: [] };
			},
			stop: async () => {},
		};
		const wakeServer = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: wakeControlPlane,
			serverOptions: { operatorWakeCoalesceMs: 1_000 },
		});

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
		const triggerPayload = (await heartbeatTrigger.json()) as {
			ok: boolean;
			reason: string;
			program: { last_result: string | null; last_error: string | null };
		};
		expect(triggerPayload.ok).toBe(false);
		expect(triggerPayload.reason).toBe("failed");
		expect(triggerPayload.program.last_result).toBe("failed");
		expect(triggerPayload.program.last_error).toBe("operator_provider_usage_limit");

		const decisionPayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/control-plane/events?type=operator.wake.decision&limit=50"),
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
			throw new Error("expected fallback wake decision payload");
		}
		expect(decisionPayload.wake_turn_outcome).toBe("fallback");
		expect(decisionPayload.wake_turn_reason).toBe("operator_provider_usage_limit");
		expect(decisionPayload.turn_reply_present).toBe(true);
		expect(decisionPayload.wake_turn_error).toBe("operator_provider_usage_limit");

		const wakePayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/control-plane/events?type=operator.wake&limit=50"),
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
		expect(wakePayload.wake_turn_reason).toBe("operator_provider_usage_limit");
		expect(typeof wakePayload.broadcast_message).toBe("string");
		expect((wakePayload.broadcast_message as string).includes("Code: operator_provider_usage_limit")).toBe(true);

		const tickPayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/control-plane/events?type=heartbeat_program.tick&limit=50"),
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
		if (!tickPayload) {
			throw new Error("expected heartbeat tick payload");
		}
		expect(tickPayload.status).toBe("failed");
		expect(tickPayload.reason).toBe("operator_provider_usage_limit");
		expect((tickPayload.program as Record<string, unknown>).last_result).toBe("failed");
		expect((tickPayload.program as Record<string, unknown>).last_error).toBe("operator_provider_usage_limit");

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0]?.message).toBe(fallbackMessage);
		expect(notifyCalls[0]?.metadata).toMatchObject({
			wake_turn_outcome: "fallback",
			wake_turn_reason: "operator_provider_usage_limit",
		});
	});

	test("operator wake runs wake→turn→outbound exactly once under repeated wake triggers", async () => {
		const wakeTurns: Array<{ text: string; requestId?: string }> = [];
		const notifyCalls: Array<{
			dedupeKey: string;
			wakeId: string | null;
			metadata: Record<string, unknown> | null;
		}> = [];
		let wakeDeliveryObserver: ((event: any) => void | Promise<void>) | null = null;

		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitAutonomousIngress: async (turnOpts) => {
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
				new Request("http://localhost/api/control-plane/events?type=operator.wake.decision&limit=50"),
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
				new Request("http://localhost/api/control-plane/events?type=operator.wake&limit=50"),
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
				new Request("http://localhost/api/control-plane/events?type=operator.wake.delivery&limit=50"),
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
		expect(wakePayload.wake_turn_outcome).toBe("triggered");
		expect(wakePayload.wake_turn_reason).toBe("turn_invoked");
		expect(wakePayload.delivery_summary_v2).toEqual({ queued: 1, duplicate: 0, skipped: 1, total: 2 });
		expect(wakePayload.delivery).toEqual({ queued: 1, duplicate: 0, skipped: 1 });
	});

	test("operator wake falls back when control-plane wake turn path is unavailable", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			stop: async () => {},
		};
		const wakeServer = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: wakeControlPlane,
		});


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
				new Request("http://localhost/api/control-plane/events?type=operator.wake.decision&limit=50"),
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

		const wakePayload = await waitFor(async () => {
			const response = await wakeServer.fetch(
				new Request("http://localhost/api/control-plane/events?type=operator.wake&limit=50"),
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

	test("heartbeat program APIs persist runtime-programmed schedules in workspace heartbeats.jsonl", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitAutonomousIngress: async () => ({ kind: "operator_response", message: "ack" }),
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
					prompt: "Review index health and repair stale memory references",
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

		const heartbeatsPath = join(getStorePaths(tempDir).storeDir, "heartbeats.jsonl");
		const lines = (await readFile(heartbeatsPath, "utf8"))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { program_id?: string; reason?: string; prompt?: string | null });
		expect(lines.some((row) => row.program_id === programId && row.reason === "watchdog")).toBe(true);
		expect(
			lines.some(
				(row) =>
					row.program_id === programId &&
					row.prompt === "Review index health and repair stale memory references",
			),
		).toBe(true);
	});

	test("review-gated heartbeat loop continues until review succeeds then self-disables", async () => {
		const issues = new IssueStore(
			new FsJsonlStore(join(getStorePaths(tempDir).storeDir, "issues.jsonl")),
		);
		const root = await issues.create("Root: review-gated workflow");
		const implementation = await issues.create("Implementation pass");
		const review = await issues.create("Review pass");
		await issues.add_dep(implementation.id, "parent", root.id);
		await issues.add_dep(review.id, "parent", root.id);
		await issues.add_dep(implementation.id, "blocks", review.id);

		type HeartbeatRegistryHandle = {
			update: (opts: { programId: string; enabled?: boolean; reason?: string }) => Promise<{ ok: boolean }>;
		};
		let heartbeatRegistryRef: HeartbeatRegistryHandle | null = null;
		let passCount = 0;
		const validations: Array<{ pass: number; is_final: boolean; reason: string }> = [];

		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitAutonomousIngress: async (opts) => {
				passCount += 1;
				const metadata =
					opts.metadata && typeof opts.metadata === "object" ? (opts.metadata as Record<string, unknown>) : {};
				const programId = typeof metadata.program_id === "string" ? metadata.program_id : null;

				if (passCount === 1) {
					await issues.close(implementation.id, "success");
					await issues.close(review.id, "needs_work");
					const firstValidation = await issues.validate(root.id);
					validations.push({
						pass: passCount,
						is_final: firstValidation.is_final,
						reason: firstValidation.reason,
					});
					await issues.update(review.id, { status: "open", outcome: null });
					await issues.update(implementation.id, { status: "open", outcome: null });
					return {
						kind: "operator_response",
						message: "Review requested changes. Continue the loop.",
					};
				}

				await issues.close(implementation.id, "success");
				await issues.close(review.id, "success");
				await issues.close(root.id, "success");
				const finalValidation = await issues.validate(root.id);
				validations.push({
					pass: passCount,
					is_final: finalValidation.is_final,
					reason: finalValidation.reason,
				});

				if (finalValidation.is_final && programId && heartbeatRegistryRef) {
					await heartbeatRegistryRef.update({
						programId,
						enabled: false,
						reason: "review_complete",
					});
				}

				return {
					kind: "operator_response",
					message: "Review accepted. Loop complete.",
				};
			},
			notifyOperators: async () => ({ queued: 0, duplicate: 0, skipped: 0, decisions: [] }),
			stop: async () => {},
		};

		const wakeServer = await createServerForTest({
			repoRoot: tempDir,
			controlPlane: wakeControlPlane,
			serverOptions: { operatorWakeCoalesceMs: 0 },
		});
		heartbeatRegistryRef = wakeServer.heartbeatPrograms as HeartbeatRegistryHandle;

		try {
			const createRes = await wakeServer.fetch(
				new Request("http://localhost/api/heartbeats/create", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						title: "Review-gated loop",
						every_ms: 0,
						reason: "review_gate",
						enabled: true,
					}),
				}),
			);
			expect(createRes.status).toBe(201);
			const createPayload = (await createRes.json()) as {
				program: { program_id: string };
			};
			const programId = createPayload.program.program_id;

			const triggerOne = await wakeServer.fetch(
				new Request("http://localhost/api/heartbeats/trigger", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ program_id: programId, reason: "manual" }),
				}),
			);
			expect(triggerOne.status).toBe(200);

			const triggerTwo = await wakeServer.fetch(
				new Request("http://localhost/api/heartbeats/trigger", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ program_id: programId, reason: "manual" }),
				}),
			);
			expect(triggerTwo.status).toBe(200);

			const getProgram = await wakeServer.fetch(new Request(`http://localhost/api/heartbeats/${programId}`));
			expect(getProgram.status).toBe(200);
			const program = (await getProgram.json()) as { enabled: boolean; reason: string; last_result: string | null };
			expect(program.enabled).toBe(false);
			expect(program.reason).toBe("review_complete");
			expect(program.last_result).toBe("ok");

			const triggerAfterDisable = await wakeServer.fetch(
				new Request("http://localhost/api/heartbeats/trigger", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ program_id: programId, reason: "manual" }),
				}),
			);
			expect(triggerAfterDisable.status).toBe(409);
			const disabledPayload = (await triggerAfterDisable.json()) as { reason: string };
			expect(disabledPayload.reason).toBe("not_running");

			expect(passCount).toBe(2);
			expect(validations).toHaveLength(2);
			expect(validations[0]?.is_final).toBe(false);
			expect(validations[0]?.reason.includes("needs work")).toBe(true);
			expect(validations[1]?.is_final).toBe(true);
			expect(validations[1]?.reason).toBe("all work completed");

			const finalValidation = await issues.validate(root.id);
			expect(finalValidation.is_final).toBe(true);
			const reviewAfter = await issues.get(review.id);
			expect(reviewAfter?.status).toBe("closed");
			expect(reviewAfter?.outcome).toBe("success");
		} finally {
			wakeServer.heartbeatPrograms.stop();
			wakeServer.cronPrograms.stop();
			await wakeServer.controlPlane?.stop?.().catch(() => {});
		}
	});

	test("cron program APIs persist schedules, emit events, and restore on startup", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitAutonomousIngress: async () => ({ kind: "operator_response", message: "ack" }),
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
		expect(tickedProgram.last_result === "ok" || tickedProgram.last_result === "coalesced").toBe(true);
		const firstTriggeredAt = tickedProgram.last_triggered_at_ms;
		expect(typeof firstTriggeredAt).toBe("number");

		const eventsRes = await cronServer.fetch(new Request("http://localhost/api/control-plane/events/tail?n=100"));
		expect(eventsRes.status).toBe(200);
		const events = (await eventsRes.json()) as Array<{ type: string }>;
		expect(events.some((event) => event.type === "cron_program.lifecycle")).toBe(true);
		expect(events.some((event) => event.type === "cron_program.tick")).toBe(true);

		const cronPath = join(getStorePaths(tempDir).storeDir, "cron.jsonl");
		const diskRows = (await readFile(cronPath, "utf8"))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { program_id?: string; schedule?: { kind?: string } });
		expect(diskRows.some((row) => row.program_id === programId && row.schedule?.kind === "every")).toBe(true);

		cronServer.cronPrograms.stop();
		cronServer.heartbeatPrograms.stop();

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
	});
	test("cron update/trigger/delete endpoints enforce lifecycle semantics", async () => {
		const wakeControlPlane: ControlPlaneHandle = {
			activeAdapters: [],
			handleWebhook: async () => null,
			submitAutonomousIngress: async () => ({ kind: "operator_response", message: "ack" }),
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
