import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { TelegramControlPlaneAdapter } from "@femtomc/mu-control-plane";

describe("Telegram callback decode routing", () => {
	test("decoded callback token maps to safe command routing", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-telegram-callback-routing-"));
		let nowMs = 1_000;
		const seenCommands: string[] = [];

		const adapter = new TelegramControlPlaneAdapter({
			pipeline: {
				runtime: {
					paths: {
						repoRoot: root,
						controlPlaneDir: root,
						attachmentIndexPath: join(root, "attachments/index.jsonl"),
						attachmentBlobRootDir: join(root, "attachments/blobs"),
						adapterAuditPath: join(root, "adapter_audit.jsonl"),
					},
				},
				identities: { resolveActive: () => null },
				handleAdapterIngress: async (inbound: { command_text: string }) => {
					seenCommands.push(inbound.command_text);
					return { kind: "operator_response", message: "ack" };
				},
			} as any,
			outbox: {
				enqueue: async () => ({ record: null }),
			} as any,
			webhookSecret: "secret",
			nowMs: () => nowMs,
		});
		await adapter.warmup();

		const callbackData = await adapter.issueCallbackToken({ commandText: "/mu status", ttlMs: 10_000, nowMs });

		const req = new Request("http://localhost/webhooks/telegram", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telegram-bot-api-secret-token": "secret",
			},
			body: JSON.stringify({
				update_id: 11,
				callback_query: {
					id: "cb-1",
					data: callbackData,
					from: { id: "42" },
					message: { message_id: 7, chat: { id: "chat-1" } },
				},
			}),
		});

		const result = await adapter.ingest(req);
		expect(result.accepted).toBe(true);
		expect(seenCommands).toEqual(["/mu status"]);
	});

	test("invalid callback token is rejected with callback ack", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-telegram-callback-routing-invalid-"));
		const adapter = new TelegramControlPlaneAdapter({
			pipeline: {
				runtime: {
					paths: {
						repoRoot: root,
						controlPlaneDir: root,
						attachmentIndexPath: join(root, "attachments/index.jsonl"),
						attachmentBlobRootDir: join(root, "attachments/blobs"),
						adapterAuditPath: join(root, "adapter_audit.jsonl"),
					},
				},
				identities: { resolveActive: () => null },
				handleAdapterIngress: async () => ({ kind: "noop", reason: "not_command" }),
			} as any,
			outbox: {
				enqueue: async () => ({ record: null }),
			} as any,
			webhookSecret: "secret",
		});
		await adapter.warmup();

		const req = new Request("http://localhost/webhooks/telegram", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telegram-bot-api-secret-token": "secret",
			},
			body: JSON.stringify({
				update_id: 12,
				callback_query: {
					id: "cb-2",
					data: "invalid",
					from: { id: "42" },
					message: { message_id: 7, chat: { id: "chat-1" } },
				},
			}),
		});

		const result = await adapter.ingest(req);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("invalid_telegram_callback_token");
		const body = (await result.response.json()) as { method?: string };
		expect(body.method).toBe("answerCallbackQuery");
	});
});
