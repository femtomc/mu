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
			control_plane: { active: false, adapters: [], routes: [] },
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
			};
		};
		expect(status.control_plane).toEqual({
			active: true,
			adapters: ["slack"],
			routes: [{ name: "slack", route: "/webhooks/slack" }],
		});
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
		};
		expect(payload.ok).toBe(true);
		expect(payload.previous_control_plane.adapters).toEqual(["slack"]);
		expect(payload.control_plane.adapters).toEqual(["discord"]);
		expect(stopCalls).toBe(1);

		const statusResponse = await serverWithReload.fetch(new Request("http://localhost/api/status"));
		expect(statusResponse.status).toBe(200);
		const status = (await statusResponse.json()) as {
			control_plane: { adapters: string[] };
		};
		expect(status.control_plane.adapters).toEqual(["discord"]);
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
		};
		expect(payload.ok).toBe(false);
		expect(payload.error).toContain("reload failed");
		expect(payload.control_plane.adapters).toEqual(["slack"]);
		expect(stopCalls).toBe(0);

		const statusResponse = await serverWithReload.fetch(new Request("http://localhost/api/status"));
		expect(statusResponse.status).toBe(200);
		const status = (await statusResponse.json()) as {
			control_plane: { adapters: string[] };
		};
		expect(status.control_plane.adapters).toEqual(["slack"]);
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
