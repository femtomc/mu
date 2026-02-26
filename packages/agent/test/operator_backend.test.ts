import { describe, expect, test } from "bun:test";
import { UI_CONTRACT_VERSION, type UiDoc } from "@femtomc/mu-core";
import { getStorePaths } from "@femtomc/mu-core/node";
import {
	PiMessagingOperatorBackend,
	type MessagingOperatorInboundEnvelope,
	type OperatorBackendTurnInput,
} from "@femtomc/mu-agent";
import type { MuSession } from "@femtomc/mu-agent";

function mkInbound(
	commandText: string,
	metadata: Record<string, unknown> = {},
	repoRoot: string = "/repo",
): MessagingOperatorInboundEnvelope {
	return {
		channel: "telegram",
		channel_tenant_id: "telegram-bot",
		channel_conversation_id: "chat-1",
		request_id: "req-1",
		repo_root: repoRoot,
		command_text: commandText,
		target_type: "status",
		target_id: "chat-1",
		metadata,
	};
}

function mkInput(opts: {
	sessionId: string;
	turnId: string;
	commandText: string;
	metadata?: Record<string, unknown>;
	repoRoot?: string;
}): OperatorBackendTurnInput {
	return {
		sessionId: opts.sessionId,
		turnId: opts.turnId,
		inbound: mkInbound(opts.commandText, opts.metadata ?? {}, opts.repoRoot ?? "/repo"),
		binding: {
			binding_id: "binding-1",
			assurance_tier: "tier_b",
		},
	};
}

type StubSessionOpts = {
	/** Text responses emitted via message_end events. */
	responses: string[];
	/** Tool calls the session should simulate (emitted before message_end). */
	toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
	/** Tool execution results the session should simulate (emitted before message_end). */
	toolResults?: Array<{ toolName: string; result: unknown; isError?: boolean; toolCallId?: string }>;
	onDispose?: () => void;
	onBind?: () => void;
	onPrompt?: (text: string) => void;
	onAbort?: () => Promise<void> | void;
};

function makeStubSession(opts: StubSessionOpts): MuSession {
	const listeners = new Set<(event: any) => void>();
	const responseQueue = [...opts.responses];
	const toolCallQueue = [...(opts.toolCalls ?? [])];
	const toolResultQueue = [...(opts.toolResults ?? [])];
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async prompt(text) {
			opts.onPrompt?.(text);

			// Emit tool_execution_start events for any queued tool calls.
			const toolCall = toolCallQueue.shift();
			if (toolCall) {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_start",
						toolCallId: `call-${crypto.randomUUID()}`,
						toolName: toolCall.toolName,
						args: toolCall.args,
					});
				}
			}

			// Emit tool_execution_end events for queued tool results.
			const toolResult = toolResultQueue.shift();
			if (toolResult) {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: toolResult.toolCallId ?? `call-${crypto.randomUUID()}`,
						toolName: toolResult.toolName,
						result: toolResult.result,
						isError: toolResult.isError ?? false,
					});
				}
			}

			// Emit message_end with assistant text.
			const next = responseQueue.shift() ?? "fallback response";
			for (const listener of listeners) {
				listener({
					type: "message_end",
					message: {
						role: "assistant",
						text: next,
					},
				});
			}
		},
		async abort() {
			await opts.onAbort?.();
		},
		dispose() {
			opts.onDispose?.();
		},
		async bindExtensions() {
			opts.onBind?.();
		},
		agent: {
			async waitForIdle() {},
		},
	};
}
function mkUiDoc(overrides: Partial<UiDoc> = {}): UiDoc {
	return {
		v: UI_CONTRACT_VERSION,
		ui_id: "ui:panel",
		title: "Panel",
		summary: "Panel summary",
		components: [
			{
				kind: "text",
				id: "text-1",
				text: "Panel contents",
				metadata: {},
			},
		],
		actions: [],
		revision: { id: "rev:1", version: 1 },
		updated_at_ms: 100,
		metadata: {},
		...overrides,
	};
}


describe("PiMessagingOperatorBackend", () => {
	test("reuses sessions by sessionId to preserve conversation memory", async () => {
		let created = 0;
		let disposed = 0;
		let binds = 0;
		const responsesBySession = [["first reply", "second reply"], ["other session reply"]];

		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () => {
				const responses = responsesBySession[created] ?? ["fallback"];
				created += 1;
				return makeStubSession({
					responses,
					onDispose: () => {
						disposed += 1;
					},
					onBind: () => {
						binds += 1;
					},
				});
			},
		});

		const first = await backend.runTurn(mkInput({ sessionId: "session-1", turnId: "turn-1", commandText: "hello" }));
		expect(first).toEqual({ kind: "respond", message: "first reply" });

		const second = await backend.runTurn(
			mkInput({ sessionId: "session-1", turnId: "turn-2", commandText: "follow up" }),
		);
		expect(second).toEqual({ kind: "respond", message: "second reply" });
		expect(created).toBe(1);
		expect(binds).toBe(1);

		const third = await backend.runTurn(
			mkInput({ sessionId: "session-2", turnId: "turn-3", commandText: "new thread" }),
		);
		expect(third).toEqual({ kind: "respond", message: "other session reply" });
		expect(created).toBe(2);
		expect(binds).toBe(2);

		backend.dispose();
		expect(disposed).toBe(2);
	});

	test("persists backend sessions to repo-scoped files by default", async () => {
		const seenSessionOpts: Array<Record<string, unknown>> = [];
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async (opts) => {
				seenSessionOpts.push(opts as unknown as Record<string, unknown>);
				return makeStubSession({ responses: ["persisted"] });
			},
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-persist", turnId: "turn-1", commandText: "hello" }),
		);
		expect(result).toEqual({ kind: "respond", message: "persisted" });
		expect(seenSessionOpts.length).toBe(1);
		const session = seenSessionOpts[0]?.session as Record<string, unknown> | undefined;
		expect(session?.mode).toBe("open");
		const storeDir = getStorePaths("/repo").storeDir;
		expect(session?.sessionDir).toBe(`${storeDir}/control-plane/operator-sessions`);
		expect(session?.sessionFile).toBe(`${storeDir}/control-plane/operator-sessions/session-persist.jsonl`);
	});

	test("command tool call produces approved command payload", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["Updating operator model."],
					toolCalls: [
						{
							toolName: "command",
							args: {
								kind: "operator_model_set",
								provider: "openai-codex",
								model: "gpt-5.3-codex",
								thinking: "high",
							},
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-cmd", turnId: "turn-1", commandText: "set operator model" }),
		);
		expect(result).toEqual({
			kind: "command",
			command: {
				kind: "operator_model_set",
				provider: "openai-codex",
				model: "gpt-5.3-codex",
				thinking: "high",
			},
		});
	});

	test("unsupported command tool calls are ignored and fall back to assistant text", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["I cannot execute that unsupported command."],
					toolCalls: [
						{
							toolName: "command",
							args: { kind: "unsupported_action", payload: "ship release" },
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-unsupported-command", turnId: "turn-1", commandText: "please do this" }),
		);
		expect(result).toEqual({
			kind: "respond",
			message: "I cannot execute that unsupported command.",
		});
	});

	test("command with invalid args falls back to text response", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["I tried to run a command but something went wrong."],
					toolCalls: [
						{
							toolName: "command",
							args: { kind: "invalid_kind_that_does_not_exist" },
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-bad-tool", turnId: "turn-1", commandText: "do something" }),
		);
		expect(result.kind).toBe("respond");
		if (result.kind !== "respond") throw new Error(`expected respond, got ${result.kind}`);
		expect(result.message).toContain("I tried to run a command");
	});

	test("plain text response without tool call", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["Here is some information for you."],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-plain", turnId: "turn-1", commandText: "what is the status?" }),
		);
		expect(result).toEqual({ kind: "respond", message: "Here is some information for you." });
	});

	test("preserves medium-length responses above 2000 characters", async () => {
		const long = "A".repeat(2_500);
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: [long],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-long", turnId: "turn-1", commandText: "give me details" }),
		);
		expect(result).toEqual({ kind: "respond", message: long });
	});

	test("caps extremely long responses at operator response max", async () => {
		const tooLong = "B".repeat(14_000);
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: [tooLong],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-too-long", turnId: "turn-1", commandText: "give me full details" }),
		);
		expect(result.kind).toBe("respond");
		if (result.kind !== "respond") {
			throw new Error(`expected respond, got ${result.kind}`);
		}
		expect(result.message.length).toBe(12_000);
		expect(result.message).toBe("B".repeat(12_000));
	});

	test("retries once when the backend session reports a transient agent-busy error", async () => {
		const listeners = new Set<(event: any) => void>();
		let promptCalls = 0;
		let idleWaitCalls = 0;
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () => ({
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				async prompt() {
					promptCalls += 1;
					if (promptCalls === 1) {
						throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
					}
					for (const listener of listeners) {
						listener({
							type: "message_end",
							message: {
								role: "assistant",
								text: "Recovered response.",
							},
						});
					}
				},
				dispose() {},
				async bindExtensions() {},
				agent: {
					async waitForIdle() {
						idleWaitCalls += 1;
					},
				},
			}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-busy-retry", turnId: "turn-1", commandText: "hello" }),
		);
		expect(result).toEqual({ kind: "respond", message: "Recovered response." });
		expect(promptCalls).toBe(2);
		expect(idleWaitCalls).toBe(1);
	});

	test("includes client context previews in the operator prompt", async () => {
		let seenPrompt = "";
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["Context received."],
					onPrompt: (text) => {
						seenPrompt = text;
					},
				}),
		});

		const result = await backend.runTurn(
			mkInput({
				sessionId: "session-context",
				turnId: "turn-1",
				commandText: "Please review this selection",
				metadata: {
					client_context: {
						file: "core/xx/src/runtime.zig",
						line: 42,
						selection: "const value = compute();",
					},
				},
			}),
		);

		expect(result).toEqual({ kind: "respond", message: "Context received." });
		expect(seenPrompt).toContain("Client context (structured preview):");
		expect(seenPrompt).toContain('"file":"core/xx/src/runtime.zig"');
	});

	test("non-command tool calls are ignored", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["The repo has 5 open issues."],
					toolCalls: [
						{
							toolName: "bash",
							args: { command: "mu status --pretty" },
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-other-tool", turnId: "turn-1", commandText: "status" }),
		);
		expect(result).toEqual({ kind: "respond", message: "The repo has 5 open issues." });
	});

	test("captures ui_docs from mu_ui tool execution results", async () => {
		const uiDoc = mkUiDoc();
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["Updated UI doc."],
					toolResults: [
						{
							toolName: "mu_ui",
							result: {
								details: {
									ui_docs: [uiDoc],
								},
							},
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-ui-doc", turnId: "turn-1", commandText: "update ui" }),
		);
		expect(result).toEqual({
			kind: "respond",
			message: "Updated UI doc.",
			ui_docs: [uiDoc],
		});
	});

	test("timeout path aborts the active session turn", async () => {
		let abortCalls = 0;
		const backend = new PiMessagingOperatorBackend({
			timeoutMs: 25,
			sessionFactory: async () => ({
				subscribe() {
					return () => {};
				},
				async prompt() {
					await new Promise<void>(() => {});
				},
				async abort() {
					abortCalls += 1;
				},
				dispose() {},
				async bindExtensions() {},
				agent: {
					async waitForIdle() {},
				},
			}),
		});

		await expect(
			backend.runTurn(mkInput({ sessionId: "session-timeout", turnId: "turn-1", commandText: "hang" })),
		).rejects.toThrow("pi operator timeout");
		expect(abortCalls).toBeGreaterThanOrEqual(1);
	});

	test("abortSession interrupts an in-flight turn for the target session", async () => {
		let rejectPrompt: ((err: Error) => void) | null = null;
		let abortCalls = 0;
		let promptStartedResolve: (() => void) | null = null;
		const promptStarted = new Promise<void>((resolve) => {
			promptStartedResolve = resolve;
		});
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () => ({
				subscribe() {
					return () => {};
				},
				async prompt() {
					promptStartedResolve?.();
					await new Promise<void>((_, reject) => {
						rejectPrompt = (err: Error) => reject(err);
					});
				},
				async abort() {
					abortCalls += 1;
					rejectPrompt?.(new Error("Request aborted"));
				},
				dispose() {},
				async bindExtensions() {},
				agent: {
					async waitForIdle() {},
				},
			}),
		});

		const run = backend.runTurn(mkInput({ sessionId: "session-abort", turnId: "turn-1", commandText: "wait" }));
		await promptStarted;
		expect(await backend.abortSession("session-abort")).toBe(true);
		await expect(run).rejects.toThrow("Request aborted");
		expect(abortCalls).toBe(1);
		expect(await backend.abortSession("session-abort")).toBe(false);
	});

	test("evicts idle sessions based on ttl", async () => {
		let now = 1_000;
		let disposed = 0;
		const backend = new PiMessagingOperatorBackend({
			nowMs: () => now,
			sessionIdleTtlMs: 100,
			sessionFactory: async () => makeStubSession({ responses: ["ok"], onDispose: () => disposed++ }),
		});

		await backend.runTurn(mkInput({ sessionId: "s1", turnId: "t1", commandText: "one" }));
		expect(disposed).toBe(0);

		now += 65_000;
		await backend.runTurn(mkInput({ sessionId: "s2", turnId: "t2", commandText: "two" }));
		expect(disposed).toBe(1);
	});
});
