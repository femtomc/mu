import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type CreateAgentSessionOptions,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createCodingTools,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { getModel, getModels, getProviders } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { BackendRunOpts, BackendRunner } from "./pi_backend.js";
import { piStreamHasError } from "./pi_backend.js";

/**
 * Resolve a bare model ID (e.g. "gpt-5.3-codex") to a pi-ai Model object
 * by searching across all known providers.
 */
function resolveModel(modelId: string): Model<any> | undefined {
	for (const provider of getProviders()) {
		const models = getModels(provider);
		const match = models.find((m) => m.id === modelId);
		if (match) return match;
	}
	return undefined;
}

/**
 * In-process backend using the pi SDK.
 *
 * Replaces subprocess spawning of the `pi` CLI with direct use of
 * `createAgentSession` from `@mariozechner/pi-coding-agent`.
 */
export class PiSdkBackend implements BackendRunner {
	async run(opts: BackendRunOpts): Promise<number> {
		const model = resolveModel(opts.model);
		if (!model) {
			throw new Error(`Model "${opts.model}" not found in pi-ai registry`);
		}

		const sessionOpts: CreateAgentSessionOptions = {
			cwd: opts.cwd,
			model,
			thinkingLevel: opts.thinking as ThinkingLevel,
			tools: createCodingTools(opts.cwd),
			sessionManager: SessionManager.inMemory(opts.cwd),
			settingsManager: SettingsManager.inMemory(),
		};

		const { session } = await createAgentSession(sessionOpts);

		let teeFh: Awaited<ReturnType<typeof open>> | null = null;
		try {
			if (opts.teePath) {
				await mkdir(dirname(opts.teePath), { recursive: true });
				teeFh = await open(opts.teePath, "w");
			}

			// Bind extensions (required for tools to work in print mode).
			await session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => session.agent.waitForIdle(),
					newSession: async () => ({ cancelled: true }),
					fork: async () => ({ cancelled: true }),
					navigateTree: async () => ({ cancelled: true }),
					switchSession: async () => ({ cancelled: true }),
					reload: async () => {},
				},
				onError: () => {},
			});

			let sawError = false;

			// Subscribe to events — serialize to JSONL for tee and error detection.
			const unsub = session.subscribe((event) => {
				const line = JSON.stringify(event);

				if (piStreamHasError(line)) {
					sawError = true;
				}

				opts.onLine?.(line);

				if (teeFh) {
					teeFh.write(`${line}\n`).catch(() => {});
				}
			});

			try {
				await session.prompt(opts.prompt, { expandPromptTemplates: false });
			} catch {
				return 1;
			} finally {
				unsub();
			}

			return sawError ? 1 : 0;
		} finally {
			session.dispose();
			if (teeFh) {
				await teeFh.close();
			}
		}
	}
}
