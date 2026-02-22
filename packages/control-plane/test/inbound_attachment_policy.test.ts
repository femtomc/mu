import { describe, expect, test } from "bun:test";
import {
	DEFAULT_INBOUND_ATTACHMENT_POLICY,
	evaluateInboundAttachmentPostDownload,
	evaluateInboundAttachmentPreDownload,
	inboundAttachmentExpiryMs,
	summarizeInboundAttachmentPolicy,
} from "@femtomc/mu-control-plane";

describe("inbound attachment policy", () => {
	test("defaults match approved Option B guardrails", () => {
		const summary = summarizeInboundAttachmentPolicy(DEFAULT_INBOUND_ATTACHMENT_POLICY);
		expect(summary.max_size_bytes).toBe(10 * 1024 * 1024);
		expect(summary.retention_ttl_ms).toBe(24 * 60 * 60 * 1000);
		expect(summary.allowed_mime_types).toEqual([
			"application/pdf",
			"image/jpeg",
			"image/png",
			"image/svg+xml",
			"image/webp",
			"text/markdown",
			"text/plain",
			"text/x-markdown",
		]);
		expect(summary.channel_modes.telegram).toBe("enabled");
		expect(summary.channel_modes.slack).toBe("enabled");
		expect(summary.channel_modes.discord).toBe("disabled");
	});

	test("pre-download rejects unsupported mime/oversize with deterministic reason codes", () => {
		const unsupported = evaluateInboundAttachmentPreDownload({
			channel: "telegram",
			adapter: "telegram",
			attachment_id: "att-1",
			channel_file_id: "file-1",
			declared_mime_type: "application/x-msdownload",
			declared_size_bytes: 10,
		});
		expect(unsupported).toMatchObject({ kind: "deny", reason: "inbound_attachment_unsupported_mime" });
		expect(unsupported.audit.reason_code).toBe("inbound_attachment_unsupported_mime");

		const oversize = evaluateInboundAttachmentPreDownload({
			channel: "slack",
			adapter: "slack",
			attachment_id: "att-2",
			channel_file_id: "file-2",
			declared_mime_type: "image/png",
			declared_size_bytes: 10 * 1024 * 1024 + 1,
		});
		expect(oversize).toMatchObject({ kind: "deny", reason: "inbound_attachment_oversize" });
		expect(oversize.audit.reason_code).toBe("inbound_attachment_oversize");

		const markdown = evaluateInboundAttachmentPreDownload({
			channel: "slack",
			adapter: "slack",
			attachment_id: "att-3",
			channel_file_id: "file-3",
			declared_mime_type: "text/markdown",
			declared_size_bytes: 128,
		});
		expect(markdown).toMatchObject({ kind: "allow", reason: null });
	});

	test("post-download enforces malware/content-hash checks deterministically", () => {
		const malware = evaluateInboundAttachmentPostDownload({
			channel: "telegram",
			attachment_id: "att-3",
			channel_file_id: "file-3",
			stored_mime_type: "image/png",
			stored_size_bytes: 20,
			content_hash: "abc",
			malware_flagged: true,
		});
		expect(malware).toMatchObject({ kind: "deny", reason: "inbound_attachment_malware_flagged" });

		const missingHash = evaluateInboundAttachmentPostDownload({
			channel: "slack",
			attachment_id: "att-4",
			channel_file_id: "file-4",
			stored_mime_type: "image/jpeg",
			stored_size_bytes: 20,
			content_hash: null,
			malware_flagged: false,
		});
		expect(missingHash).toMatchObject({ kind: "deny", reason: "inbound_attachment_missing_content_hash" });
	});

	test("expiry helper uses 24h ttl", () => {
		expect(inboundAttachmentExpiryMs(1_000)).toBe(1_000 + 24 * 60 * 60 * 1000);
	});
});
