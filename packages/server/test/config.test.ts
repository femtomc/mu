import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyMuConfigPatch,
	DEFAULT_MU_CONFIG,
	getMuConfigPath,
	muConfigPresence,
	normalizeMuConfig,
	readMuConfigFile,
	redactMuConfigSecrets,
	writeMuConfigFile,
} from "../src/config.js";

describe("mu config", () => {
	test("readMuConfigFile returns defaults when file is missing", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "mu-config-test-"));
		try {
			const config = await readMuConfigFile(repoRoot);
			expect(config).toEqual(DEFAULT_MU_CONFIG);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("normalize + patch + write/read roundtrip", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "mu-config-test-"));
		try {
			const normalized = normalizeMuConfig({
				control_plane: {
					adapters: {
						slack: { signing_secret: "  slack-secret  ", bot_token: "  xoxb-test-token  " },
						telegram: {
							webhook_secret: "tg-secret",
							bot_token: "tg-token",
						},
					},
					operator: {
						enabled: false,
					},
				},
			});
			expect(normalized.control_plane.adapters.slack.signing_secret).toBe("slack-secret");
			expect(normalized.control_plane.adapters.slack.bot_token).toBe("xoxb-test-token");
			expect(normalized.control_plane.adapters.telegram.webhook_secret).toBe("tg-secret");
			expect(normalized.control_plane.operator.enabled).toBe(false);
			expect(normalized.control_plane.operator.thinking).toBeNull();
			expect(normalized.control_plane.operator.timeout_ms).toBe(600_000);
			expect(normalized.control_plane.memory_index.enabled).toBe(true);
			expect(normalized.control_plane.memory_index.every_ms).toBe(300_000);

			const patched = applyMuConfigPatch(normalized, {
				control_plane: {
					operator: { thinking: "high", timeout_ms: 180_000 },
					memory_index: { enabled: true, every_ms: 45_000 },
					adapters: {
						discord: { signing_secret: "discord-secret" },
						neovim: { shared_secret: "nvim-secret" },
					},
				},
			});
			expect(patched.control_plane.operator.thinking).toBe("high");
			expect(patched.control_plane.operator.timeout_ms).toBe(180_000);
			expect(patched.control_plane.memory_index.enabled).toBe(true);
			expect(patched.control_plane.memory_index.every_ms).toBe(45_000);
			expect(patched.control_plane.adapters.discord.signing_secret).toBe("discord-secret");
			expect(patched.control_plane.adapters.neovim.shared_secret).toBe("nvim-secret");

			const configPath = await writeMuConfigFile(repoRoot, patched);
			expect(configPath).toBe(getMuConfigPath(repoRoot));

			const roundTrip = await readMuConfigFile(repoRoot);
			expect(roundTrip).toEqual(patched);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("presence + redaction are safe for status surfaces", () => {
		const config = normalizeMuConfig({
			control_plane: {
				adapters: {
					slack: { signing_secret: "slack-secret", bot_token: "slack-bot-token" },
					telegram: { webhook_secret: "tg-secret", bot_token: "tg-token", bot_username: "mybot" },
					neovim: { shared_secret: "nvim-secret" },
				},
				operator: {
					enabled: true,
					provider: "openai",
					model: "gpt-5",
					thinking: "xhigh",
					timeout_ms: 300_000,
				},
			},
		});

		const presence = muConfigPresence(config);
		expect(presence.control_plane.adapters.slack.signing_secret).toBe(true);
		expect(presence.control_plane.adapters.slack.bot_token).toBe(true);
		expect(presence.control_plane.adapters.telegram.bot_username).toBe(true);
		expect(presence.control_plane.adapters.neovim.shared_secret).toBe(true);
		expect(presence.control_plane.operator.thinking).toBe(true);
		expect(presence.control_plane.operator.timeout_ms).toBe(300_000);
		expect(presence.control_plane.memory_index.enabled).toBe(true);
		expect(presence.control_plane.memory_index.every_ms).toBe(300_000);

		const redacted = redactMuConfigSecrets(config);
		expect(redacted.control_plane.adapters.slack.signing_secret).toBe("***");
		expect(redacted.control_plane.adapters.slack.bot_token).toBe("***");
		expect(redacted.control_plane.adapters.telegram.bot_token).toBe("***");
		expect(redacted.control_plane.adapters.neovim.shared_secret).toBe("***");
		expect(redacted.control_plane.operator.provider).toBe("openai");
	});
});
