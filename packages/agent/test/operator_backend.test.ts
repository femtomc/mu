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

function makeStubSession(opts: {
	responses: string[];
	onDispose?: () => void;
	onBind?: () => void;
	onPrompt?: (text: string) => void;
}): MuSession {
	const listeners = new Set<(event: any) => void>();
	const queue = [...opts.responses];
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async prompt(text) {
			opts.onPrompt?.(text);
			const next = queue.shift() ?? "fallback response";
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

	test("parses MU_COMMAND directive into approved command payload", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ['MU_COMMAND: {"kind":"run_start","prompt":"ship release"}'],
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

	test("parses MU_DECISION command envelope into approved payload", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ['MU_DECISION: {"kind":"command","command":{"kind":"run_start","prompt":"ship release"}}'],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-cmd-envelope", turnId: "turn-1", commandText: "please run this" }),
		);
		expect(result).toEqual({
			kind: "command",
			command: {
				kind: "run_start",
				prompt: "ship release",
			},
		});
	});

	test("parses legacy pure-JSON command payloads for compatibility", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ['{"kind":"run_resume","root_issue_id":"mu-root1234"}'],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-cmd-legacy", turnId: "turn-1", commandText: "resume" }),
		);
		expect(result).toEqual({
			kind: "command",
			command: {
				kind: "run_resume",
				root_issue_id: "mu-root1234",
			},
		});
	});

	test("invalid command directives degrade to safe response", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: ['MU_COMMAND: {"kind":"run_start","prompt":}'],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-invalid-directive", turnId: "turn-1", commandText: "start a run" }),
		);
		expect(result.kind).toBe("respond");
		if (result.kind !== "respond") {
			throw new Error(`expected respond, got ${result.kind}`);
		}
		expect(result.message).toContain("operator_invalid_command_directive");
	});

	test("invalid directives with normal text preserve conversational response", async () => {
		const backend = new PiMessagingOperatorBackend({
			sessionFactory: async () =>
				makeStubSession({
					responses: [
						"I can help with that.\nMU_COMMAND: {\"kind\":\"run_start\",\"prompt\":}\nLet me know if you want me to propose a command.",
					],
				}),
		});

		const result = await backend.runTurn(
			mkInput({ sessionId: "session-invalid-directive-mixed", turnId: "turn-1", commandText: "start a run" }),
		);
		expect(result.kind).toBe("respond");
		if (result.kind !== "respond") {
			throw new Error(`expected respond, got ${result.kind}`);
		}
		expect(result.message).toContain("I can help with that.");
		expect(result.message).toContain("Let me know if you want me to propose a command.");
		expect(result.message).not.toContain("MU_COMMAND:");
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
