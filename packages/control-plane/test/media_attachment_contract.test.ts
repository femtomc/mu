import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ControlPlaneOutbox,
	InboundEnvelopeSchema,
	OutboundEnvelopeSchema,
	type OutboundEnvelope,
} from "@femtomc/mu-control-plane";

function mkOutboundEnvelope(nowMs: number): OutboundEnvelope {
	return {
		v: 1,
		ts_ms: nowMs,
		channel: "slack",
		channel_tenant_id: "tenant-1",
		channel_conversation_id: "conversation-1",
		request_id: "request-1",
		response_id: `response-${nowMs}`,
		kind: "result",
		body: "text fallback always present",
		correlation: {
			command_id: "cmd-1",
			idempotency_key: "idem-1",
			request_id: "request-1",
			channel: "slack",
			channel_tenant_id: "tenant-1",
			channel_conversation_id: "conversation-1",
			actor_id: "actor-1",
			actor_binding_id: "binding-1",
			assurance_tier: "tier_a",
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
		},
		metadata: {},
	};
}

describe("media/attachment envelope contract", () => {
	test("inbound/outbound envelopes remain backward compatible when attachments are omitted", () => {
		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: 1,
			request_id: "req-1",
			delivery_id: "delivery-1",
			channel: "telegram",
			channel_tenant_id: "tenant-1",
			channel_conversation_id: "conversation-1",
			actor_id: "actor-1",
			actor_binding_id: "binding-1",
			assurance_tier: "tier_a",
			repo_root: "/repo",
			command_text: "/mu status",
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: "conversation-1",
			idempotency_key: "idem-1",
			fingerprint: "fp-1",
			metadata: {},
		});
		expect(inbound.attachments).toBeUndefined();

		const outbound = OutboundEnvelopeSchema.parse(mkOutboundEnvelope(10));
		expect(outbound.attachments).toBeUndefined();
		expect(outbound.body).toBe("text fallback always present");
	});

	test("envelopes accept optional attachment descriptors", () => {
		const inbound = InboundEnvelopeSchema.parse({
			v: 1,
			received_at_ms: 1,
			request_id: "req-2",
			delivery_id: "delivery-2",
			channel: "telegram",
			channel_tenant_id: "tenant-1",
			channel_conversation_id: "conversation-1",
			actor_id: "actor-1",
			actor_binding_id: "binding-1",
			assurance_tier: "tier_a",
			repo_root: "/repo",
			command_text: "/mu status",
			scope_required: "cp.read",
			scope_effective: "cp.read",
			target_type: "status",
			target_id: "conversation-1",
			idempotency_key: "idem-2",
			fingerprint: "fp-2",
			attachments: [
				{
					type: "document",
					filename: "report.pdf",
					mime_type: "application/pdf",
					size_bytes: 1234,
					reference: {
						source: "telegram",
						file_id: "file-abc",
					},
				},
			],
			metadata: {},
		});
		expect(inbound.attachments?.[0]?.reference.file_id).toBe("file-abc");

		const outbound = OutboundEnvelopeSchema.parse({
			...mkOutboundEnvelope(12),
			attachments: [
				{
					type: "image",
					filename: "plot.png",
					mime_type: "image/png",
					size_bytes: 456,
					reference: {
						source: "artifact-store",
						url: "https://example.invalid/plot.png",
					},
				},
			],
		});
		expect(outbound.body).toBe("text fallback always present");
		expect(outbound.attachments?.[0]?.reference.url).toBe("https://example.invalid/plot.png");
	});

	test("outbox dedupe key semantics remain stable for attachment-bearing envelopes", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-media-dedupe-"));
		const outbox = new ControlPlaneOutbox(join(root, "outbox.jsonl"));
		const first = await outbox.enqueue({
			dedupeKey: "dedupe:attachment:1",
			envelope: {
				...mkOutboundEnvelope(20),
				attachments: [
					{
						type: "document",
						reference: { source: "telegram", file_id: "file-1" },
						metadata: {},
					},
				],
			},
		});
		expect(first.kind).toBe("enqueued");

		const duplicate = await outbox.enqueue({
			dedupeKey: "dedupe:attachment:1",
			envelope: {
				...mkOutboundEnvelope(21),
				attachments: [
					{
						type: "document",
						reference: { source: "telegram", file_id: "file-2" },
						metadata: {},
					},
				],
			},
		});
		expect(duplicate.kind).toBe("duplicate");
		expect(duplicate.record.outbox_id).toBe(first.record.outbox_id);
	});
});
