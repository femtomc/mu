import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bootstrapFrontendChannel,
	createSessionTurn,
	getControlPlanePaths,
	readMuServerDiscovery,
	submitFrontendIngress,
} from "@femtomc/mu-control-plane";

describe("frontend client bootstrap", () => {
	test("readMuServerDiscovery returns null when discovery file is missing", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "mu-frontend-client-"));
		try {
			const discovery = await readMuServerDiscovery(repoRoot);
			expect(discovery).toBeNull();
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("bootstrapFrontendChannel resolves server discovery, channel capabilities, and identity link", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "mu-frontend-client-"));
		const cpDir = getControlPlanePaths(repoRoot).controlPlaneDir;
		await mkdir(cpDir, { recursive: true });
		await writeFile(
			join(cpDir, "server.json"),
			JSON.stringify({ pid: 123, port: 3000, url: "http://localhost:3000", started_at_ms: 1 }) + "\n",
			"utf8",
		);

		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url, init });

			if (url.endsWith("/api/control-plane/channels")) {
				return Response.json({
					ok: true,
					generated_at_ms: 1,
					channels: [
						{
							channel: "slack",
							route: "/webhooks/slack",
							ingress_payload: "form_urlencoded",
							verification: { kind: "hmac_sha256", signature_header: "x-slack-signature" },
							ack_format: "slack_ephemeral_json",
							delivery_semantics: "at_least_once",
							deferred_delivery: true,
							ingress_mode: "command_only",
							configured: false,
							active: false,
							frontend: false,
							media: {
								outbound_delivery: { supported: true, configured: false, reason: "slack_bot_token_missing" },
								inbound_attachment_download: { supported: true, configured: false, reason: "slack_bot_token_missing" },
							},
						},
						{
							channel: "neovim",
							route: "/webhooks/neovim",
							ingress_payload: "json",
							verification: { kind: "shared_secret_header", secret_header: "x-mu-neovim-secret" },
							ack_format: "json",
							delivery_semantics: "at_least_once",
							deferred_delivery: false,
							ingress_mode: "command_only",
							configured: true,
							active: true,
							frontend: true,
							media: {
								outbound_delivery: { supported: false, configured: false, reason: "channel_media_delivery_unsupported" },
								inbound_attachment_download: {
									supported: false,
									configured: false,
									reason: "channel_attachment_ingress_unsupported",
								},
							},
						},
					],
				});
			}
			if (url.endsWith("/api/control-plane/identities/link")) {
				return Response.json({ ok: true, kind: "linked", binding: { binding_id: "bind-1" } }, { status: 201 });
			}
			throw new Error(`unexpected fetch url: ${url}`);
		}) as typeof fetch;

		try {
			const result = await bootstrapFrontendChannel({
				repoRoot,
				channel: "neovim",
				sharedSecret: "unused-for-bootstrap",
				actorId: "actor-1",
				tenantId: "workspace-1",
			});
			expect(result.server_url).toBe("http://localhost:3000");
			expect(result.channel.channel).toBe("neovim");
			expect(result.channel.route).toBe("/webhooks/neovim");
			const linkCall = calls.find((entry) => entry.url.endsWith("/api/control-plane/identities/link"));
			expect(linkCall).toBeDefined();
			const body = typeof linkCall?.init?.body === "string" ? JSON.parse(linkCall.init.body) : null;
			expect(body?.channel).toBe("neovim");
			expect(body?.actor_id).toBe("actor-1");
		} finally {
			globalThis.fetch = originalFetch;
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("submitFrontendIngress sends shared-secret header and parses structured response", async () => {
		const originalFetch = globalThis.fetch;
		let seenSecret = "";
		globalThis.fetch = (async (_input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			seenSecret = (init?.headers as Record<string, string>)?.["x-mu-neovim-secret"] ?? "";
			return Response.json({
				ok: true,
				accepted: true,
				channel: "neovim",
				request_id: "neovim-req-1",
				delivery_id: "neovim-delivery-1",
				ack: "ok",
				message: "ok",
				interaction: { v: 1 },
				result: { kind: "completed" },
			});
		}) as typeof fetch;

		try {
			const result = await submitFrontendIngress({
				serverUrl: "http://localhost:3000",
				channel: "neovim",
				sharedSecret: "neovim-secret",
				request: {
					tenant_id: "workspace-1",
					conversation_id: "workspace:main",
					actor_id: "actor-1",
					text: "status",
				},
			});
			expect(seenSecret ?? "").toBe("neovim-secret");
			expect(result.channel).toBe("neovim");
			expect(result.accepted).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("createSessionTurn posts payload and parses reply/context cursor", async () => {
		const originalFetch = globalThis.fetch;
		let seenBody: Record<string, unknown> | null = null;
		let seenUrl = "";
		let seenSecret = "";
		globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			seenSecret = (init?.headers as Record<string, string>)?.["x-mu-neovim-secret"] ?? "";
			const rawBody = init?.body as unknown;
			seenBody = typeof rawBody === "string" ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
			return Response.json({
				ok: true,
				turn: {
					session_id: "operator-1",
					session_kind: "cp_operator",
					session_file: "/tmp/operator-1.jsonl",
					context_entry_id: "entry-42",
					reply: "Done — I used that session context.",
					source: "neovim",
					completed_at_ms: 123,
				},
			});
		}) as typeof fetch;

		try {
			const turn = await createSessionTurn({
				serverUrl: "http://localhost:3000",
				channel: "neovim",
				sharedSecret: "nvim-secret",
				request: {
					session_id: "operator-1",
					session_kind: "cp_operator",
					body: "Use the prior context and summarize.",
					source: "neovim",
				},
			});
			expect(seenUrl).toBe("http://localhost:3000/api/control-plane/turn");
			expect(seenSecret).toBe("nvim-secret");
			expect((seenBody as Record<string, unknown> | null)?.["session_id"]).toBe("operator-1");
			expect((seenBody as Record<string, unknown> | null)?.["body"]).toBe("Use the prior context and summarize.");
			expect(turn.context_entry_id).toBe("entry-42");
			expect(turn.reply).toContain("session context");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
