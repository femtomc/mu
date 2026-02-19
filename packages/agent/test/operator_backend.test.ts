import { describe, expect, test } from "bun:test";
import {
	PiMessagingOperatorBackend,
	type MessagingOperatorInboundEnvelope,
	type OperatorBackendTurnInput,
} from "@femtomc/mu-agent";
import type { MuSession } from "@femtomc/mu-agent";

function mkInbound(commandText: string): MessagingOperatorInboundEnvelope {
	return {
		channel: "telegram",
		channel_tenant_id: "telegram-bot",
		channel_conversation_id: "chat-1",
		request_id: "req-1",
		repo_root: "/repo",
		command_text: commandText,
		target_type: "status",
		target_id: "chat-1",
		metadata: {},
	};
}

function mkInput(opts: { sessionId: string; turnId: string; commandText: string }): OperatorBackendTurnInput {
	return {
		sessionId: opts.sessionId,
		turnId: opts.turnId,
		inbound: mkInbound(opts.commandText),
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
	onDispose?: () => void;
	onBind?: () => void;
	onPrompt?: (text: string) => void;
};

function makeStubSession(opts: StubSessionOpts): MuSession {
	const listeners = new Set<(event: any) => void>();
	const responseQueue = [...opts.responses];
	const toolCallQueue = [...(opts.toolCalls ?? [])];
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
		expect(session?.sessionDir).toBe("/repo/.mu/control-plane/operator-sessions");
		expect(session?.sessionFile).toBe("/repo/.mu/control-plane/operator-sessions/session-persist.jsonl");
	});

	test("command tool call produces approved command payload", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["I'll start that run for you."],
					toolCalls: [
						{
							toolName: "command",
							args: { kind: "run_start", prompt: "ship release" },
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-cmd", turnId: "turn-1", commandText: "please run this" }),
		);
		expect(result).toEqual({
			kind: "command",
			command: {
				kind: "run_start",
				prompt: "ship release",
			},
		});
	});

	test("command tool call works with multi-line prompts", async () => {
		const longPrompt = [
			"Set up Telegram messaging integration for mu control-plane in /home/user/Dev/workshop.",
			"Use public base URL https://example.tail4cdecd.ts.net (Tailscale Funnel -> localhost:3000).",
			"Bot token: 123456:ABCDEF.",
			"Generate a strong random webhook_secret, update .mu/config.json,",
			"run command(kind=\"reload\") after writing config, call Telegram setWebhook, then verify.",
		].join("\n");

		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["Setting up Telegram integration now."],
					toolCalls: [
						{
							toolName: "command",
							args: { kind: "run_start", prompt: longPrompt },
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-multiline", turnId: "turn-1", commandText: "set up telegram" }),
		);
		expect(result).toEqual({
			kind: "command",
			command: {
				kind: "run_start",
				prompt: longPrompt,
			},
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

	test("non-command tool calls are ignored", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ["The repo has 5 open issues."],
					toolCalls: [
						{
							toolName: "query",
							args: { action: "get", resource: "status" },
						},
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-other-tool", turnId: "turn-1", commandText: "status" }),
		);
		expect(result).toEqual({ kind: "respond", message: "The repo has 5 open issues." });
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
