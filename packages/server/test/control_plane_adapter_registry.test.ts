import { describe, expect, test } from "bun:test";
import type { OutboxRecord } from "@femtomc/mu-control-plane";
import { DEFAULT_MU_CONFIG } from "../src/config.js";
import { detectAdapters } from "../src/control_plane_adapter_registry.js";
import { OutboundDeliveryRouter } from "../src/outbound_delivery_router.js";

function mkRecord(channel: string): OutboxRecord {
	return {
		outbox_id: "out-test",
		dedupe_key: "dedupe-test",
		state: "pending",
		envelope: {
			v: 1,
			ts_ms: 1,
			channel,
			channel_tenant_id: "tenant-1",
			channel_conversation_id: "conversation-1",
			request_id: "req-1",
			response_id: "resp-1",
			kind: "result",
			body: "hello",
			correlation: {
				command_id: "cmd-1",
				idempotency_key: "idem-1",
				request_id: "req-1",
				channel,
				channel_tenant_id: "tenant-1",
				channel_conversation_id: "conversation-1",
				actor_id: "actor-1",
				actor_binding_id: "binding-1",
				assurance_tier: "tier_b",
				repo_root: "/repo",
				scope_required: "cp.read",
				scope_effective: "cp.read",
				target_type: "status",
				target_id: "conversation-1",
				attempt: 1,
				state: "completed",
				error_code: null,
				operator_session_id: null,
				operator_turn_id: null,
				cli_invocation_id: null,
				cli_command_kind: null,
				run_root_id: null,
			},
			metadata: {},
		},
		created_at_ms: 1,
		updated_at_ms: 1,
		next_attempt_at_ms: 1,
		attempt_count: 0,
		max_attempts: 3,
		last_error: null,
		dead_letter_reason: null,
		replay_of_outbox_id: null,
		replay_requested_by_command_id: null,
	};
}

describe("control plane adapter registry", () => {
	test("detectAdapters discovers configured static and generation-managed adapters", () => {
		const config = JSON.parse(JSON.stringify(DEFAULT_MU_CONFIG)) as typeof DEFAULT_MU_CONFIG;
		config.control_plane.adapters.slack.signing_secret = "slack-secret";
		config.control_plane.adapters.discord.signing_secret = "discord-secret";
		config.control_plane.adapters.neovim.shared_secret = "nvim-secret";
		config.control_plane.adapters.vscode.shared_secret = "vscode-secret";
		config.control_plane.adapters.telegram.webhook_secret = "tg-secret";
		config.control_plane.adapters.telegram.bot_token = "tg-token";
		config.control_plane.adapters.telegram.bot_username = "tg-bot";

		const detected = detectAdapters(config.control_plane);
		expect(detected).toEqual([
			{ name: "slack", secret: "slack-secret" },
			{ name: "discord", secret: "discord-secret" },
			{ name: "neovim", secret: "nvim-secret" },
			{ name: "vscode", secret: "vscode-secret" },
			{
				name: "telegram",
				webhookSecret: "tg-secret",
				botToken: "tg-token",
				botUsername: "tg-bot",
			},
		]);
	});

	test("outbound delivery router dispatches configured channels and ignores unknown channels", async () => {
		const seen: string[] = [];
		const router = new OutboundDeliveryRouter([
			{
				channel: "telegram",
				deliver: async (record) => {
					seen.push(record.envelope.channel);
					return { kind: "delivered" };
				},
			},
		]);

		const delivered = await router.deliver(mkRecord("telegram"));
		expect(delivered).toEqual({ kind: "delivered" });
		expect(seen).toEqual(["telegram"]);

		const ignored = await router.deliver(mkRecord("unknown-channel"));
		expect(ignored).toBeUndefined();
		expect(seen).toEqual(["telegram"]);
	});
});
