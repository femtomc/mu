import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	JsonFileConversationSessionStore,
	MessagingOperatorRuntime,
	type MessagingOperatorBackend,
	type MessagingOperatorConversationSessionStore,
	type MessagingOperatorIdentityBinding,
	type MessagingOperatorInboundEnvelope,
} from "@femtomc/mu-agent";
import type { HudDoc } from "@femtomc/mu-core";

function mkInbound(conversationId: string): MessagingOperatorInboundEnvelope {
	return {
		channel: "telegram",
		channel_tenant_id: "telegram-bot",
		channel_conversation_id: conversationId,
		request_id: `req-${conversationId}`,
		repo_root: "/repo",
		command_text: "hello",
		target_type: "status",
		target_id: conversationId,
		metadata: {},
	};
}

function mkSlackInbound(opts: {
	conversationId: string;
	requestId: string;
	threadTs?: string;
}): MessagingOperatorInboundEnvelope {
	return {
		channel: "slack",
		channel_tenant_id: "team-1",
		channel_conversation_id: opts.conversationId,
		request_id: opts.requestId,
		repo_root: "/repo",
		command_text: "hello",
		target_type: "status",
		target_id: opts.conversationId,
		metadata: opts.threadTs ? { slack_thread_ts: opts.threadTs } : {},
	};
}

function mkBinding(): MessagingOperatorIdentityBinding {
	return {
		binding_id: "binding-1",
		assurance_tier: "tier_b",
	};
}

function mkHudDoc(overrides: Partial<HudDoc> = {}): HudDoc {
	return {
		v: 1,
		hud_id: "planning",
		title: "Planning",
		scope: null,
		chips: [{ key: "phase", label: "reviewing", tone: "warning" }],
		sections: [{ kind: "text", text: "Awaiting approval" }],
		actions: [{ id: "snapshot", label: "Snapshot", command_text: "/mu hud snapshot", kind: "secondary" }],
		snapshot_compact: "HUD(plan) · phase=reviewing",
		updated_at_ms: 123,
		metadata: {},
		...overrides,
	};
}

class InMemoryConversationSessionStore implements MessagingOperatorConversationSessionStore {
	readonly #map = new Map<string, string>();

	public getSessionId(conversationKey: string): string | null {
		return this.#map.get(conversationKey) ?? null;
	}

	public setSessionId(conversationKey: string, sessionId: string): void {
		this.#map.set(conversationKey, sessionId);
	}
}

test("MessagingOperatorRuntime reuses persisted conversation session ids across runtime restarts", async () => {
	const seenSessionIds: string[] = [];
	const backend: MessagingOperatorBackend = {
		runTurn: async (input) => {
			seenSessionIds.push(input.sessionId);
			return { kind: "respond", message: "ok" };
		},
	};
	const store = new InMemoryConversationSessionStore();
	let seq = 0;

	const runtime1 = new MessagingOperatorRuntime({
		backend,
		sessionIdFactory: () => `session-${++seq}`,
		conversationSessionStore: store,
	});
	const first = await runtime1.handleInbound({ inbound: mkInbound("chat-1"), binding: mkBinding() });
	expect(first.kind).toBe("response");
	expect(first.operatorSessionId).toBe("session-1");
	await runtime1.stop();

	const runtime2 = new MessagingOperatorRuntime({
		backend,
		sessionIdFactory: () => `session-${++seq}`,
		conversationSessionStore: store,
	});
	const second = await runtime2.handleInbound({ inbound: mkInbound("chat-1"), binding: mkBinding() });
	expect(second.kind).toBe("response");
	expect(second.operatorSessionId).toBe("session-1");

	const third = await runtime2.handleInbound({ inbound: mkInbound("chat-2"), binding: mkBinding() });
	expect(third.kind).toBe("response");
	expect(third.operatorSessionId).toBe("session-2");
	await runtime2.stop();

	expect(seenSessionIds).toEqual(["session-1", "session-1", "session-2"]);
});

test("MessagingOperatorRuntime forwards hud_docs from backend responses", async () => {
	const hudDoc = mkHudDoc();
	const runtime = new MessagingOperatorRuntime({
		backend: {
			runTurn: async () => ({
				kind: "respond",
				message: "ok",
				hud_docs: [hudDoc],
			}),
		},
		sessionIdFactory: () => "session-hud",
		turnIdFactory: () => "turn-hud",
	});
	try {
		const decision = await runtime.handleInbound({ inbound: mkInbound("chat-hud"), binding: mkBinding() });
		expect(decision.kind).toBe("response");
		if (decision.kind !== "response") {
			throw new Error(`expected response decision, got ${decision.kind}`);
		}
		expect(decision.message).toBe("ok");
		expect(decision.hud_docs).toEqual([hudDoc]);
	} finally {
		await runtime.stop();
	}
});

test("MessagingOperatorRuntime isolates Slack conversation sessions by thread_ts", async () => {
	const backend: MessagingOperatorBackend = {
		runTurn: async () => ({ kind: "respond", message: "ok" }),
	};
	const store = new InMemoryConversationSessionStore();
	let seq = 0;
	const runtime = new MessagingOperatorRuntime({
		backend,
		sessionIdFactory: () => `session-${++seq}`,
		conversationSessionStore: store,
	});

	const firstThread = await runtime.handleInbound({
		inbound: mkSlackInbound({ conversationId: "channel-1", requestId: "req-1", threadTs: "1700.100" }),
		binding: mkBinding(),
	});
	expect(firstThread.operatorSessionId).toBe("session-1");

	const secondThread = await runtime.handleInbound({
		inbound: mkSlackInbound({ conversationId: "channel-1", requestId: "req-2", threadTs: "1700.200" }),
		binding: mkBinding(),
	});
	expect(secondThread.operatorSessionId).toBe("session-2");

	const firstThreadAgain = await runtime.handleInbound({
		inbound: mkSlackInbound({ conversationId: "channel-1", requestId: "req-3", threadTs: "1700.100" }),
		binding: mkBinding(),
	});
	expect(firstThreadAgain.operatorSessionId).toBe("session-1");

	const noThread = await runtime.handleInbound({
		inbound: mkSlackInbound({ conversationId: "channel-1", requestId: "req-4" }),
		binding: mkBinding(),
	});
	expect(noThread.operatorSessionId).toBe("session-3");

	const noThreadAgain = await runtime.handleInbound({
		inbound: mkSlackInbound({ conversationId: "channel-1", requestId: "req-5" }),
		binding: mkBinding(),
	});
	expect(noThreadAgain.operatorSessionId).toBe("session-3");

	await runtime.stop();
});

test("JsonFileConversationSessionStore persists mappings across store instances", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mu-operator-runtime-"));
	const filePath = join(dir, "operator_conversations.json");
	try {
		const store1 = new JsonFileConversationSessionStore(filePath);
		await store1.setSessionId("telegram:tenant-a:chat-1:binding-1", "session-a");
		await store1.setSessionId("telegram:tenant-a:chat-2:binding-1", "session-b");
		await store1.stop();

		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as {
			version: number;
			bindings: Record<string, string>;
		};
		expect(parsed.version).toBe(1);
		expect(parsed.bindings["telegram:tenant-a:chat-1:binding-1"]).toBe("session-a");
		expect(parsed.bindings["telegram:tenant-a:chat-2:binding-1"]).toBe("session-b");

		const store2 = new JsonFileConversationSessionStore(filePath);
		expect(await store2.getSessionId("telegram:tenant-a:chat-1:binding-1")).toBe("session-a");
		expect(await store2.getSessionId("telegram:tenant-a:chat-2:binding-1")).toBe("session-b");
		expect(await store2.getSessionId("telegram:tenant-a:chat-3:binding-1")).toBeNull();
		await store2.stop();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("MessagingOperatorRuntime includes classified backend failure codes in fallback responses", async () => {
	const scenarios = [
		{ backendMessage: "pi operator timeout", expectedCode: "operator_timeout" },
		{ backendMessage: "operator_empty_response", expectedCode: "operator_empty_response" },
		{
			backendMessage:
				"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
			expectedCode: "operator_busy",
		},
		{ backendMessage: "Request aborted", expectedCode: "operator_cancelled" },
		{ backendMessage: "some unknown backend crash", expectedCode: "operator_backend_error" },
	] as const;

	for (const [index, scenario] of scenarios.entries()) {
		const runtime = new MessagingOperatorRuntime({
			backend: {
				runTurn: async () => {
					throw new Error(scenario.backendMessage);
				},
			},
			sessionIdFactory: () => `session-${index + 1}`,
			turnIdFactory: () => `turn-${index + 1}`,
		});
		try {
			const decision = await runtime.handleInbound({ inbound: mkInbound(`chat-${index + 1}`), binding: mkBinding() });
			expect(decision.kind).toBe("response");
			if (decision.kind !== "response") {
				throw new Error(`expected response decision, got ${decision.kind}`);
			}
			expect(decision.message).toContain(`Code: ${scenario.expectedCode}`);
		} finally {
			await runtime.stop();
		}
	}
});

test("MessagingOperatorRuntime routes explicit cancel directives to backend abortSession", async () => {
	let abortCalls = 0;
	let runTurnCalls = 0;
	const runtime = new MessagingOperatorRuntime({
		backend: {
			runTurn: async () => {
				runTurnCalls += 1;
				return { kind: "respond", message: "unexpected" };
			},
			abortSession: async () => {
				abortCalls += 1;
				return true;
			},
		},
		sessionIdFactory: () => "session-cancel",
		turnIdFactory: () => "turn-cancel",
	});
	try {
		const decision = await runtime.handleInbound({
			inbound: {
				...mkInbound("chat-cancel"),
				command_text: "/mu cancel",
			},
			binding: mkBinding(),
		});
		expect(decision.kind).toBe("response");
		if (decision.kind !== "response") {
			throw new Error(`expected response decision, got ${decision.kind}`);
		}
		expect(decision.message).toContain("Cancelled the in-flight operator turn");
		expect(abortCalls).toBe(1);
		expect(runTurnCalls).toBe(0);
	} finally {
		await runtime.stop();
	}
});

test("MessagingOperatorRuntime reports when cancel finds no active turn", async () => {
	const runtime = new MessagingOperatorRuntime({
		backend: {
			runTurn: async () => ({ kind: "respond", message: "unexpected" }),
			abortSession: async () => false,
		},
		sessionIdFactory: () => "session-cancel-none",
		turnIdFactory: () => "turn-cancel-none",
	});
	try {
		const decision = await runtime.handleInbound({
			inbound: {
				...mkInbound("chat-cancel-none"),
				command_text: "cancel",
			},
			binding: mkBinding(),
		});
		expect(decision.kind).toBe("response");
		if (decision.kind !== "response") {
			throw new Error(`expected response decision, got ${decision.kind}`);
		}
		expect(decision.message).toContain("No in-flight operator turn");
	} finally {
		await runtime.stop();
	}
});

test("MessagingOperatorRuntime suppresses cancelled-turn follow-up output after explicit cancel", async () => {
	let runTurnCalls = 0;
	const runtime = new MessagingOperatorRuntime({
		backend: {
			runTurn: async () => {
				runTurnCalls += 1;
				throw new Error("Request aborted");
			},
			abortSession: async () => true,
		},
		sessionIdFactory: () => "session-cancel-suppress",
		turnIdFactory: () => `turn-cancel-suppress-${runTurnCalls + 1}`,
	});
	try {
		const cancelDecision = await runtime.handleInbound({
			inbound: {
				...mkInbound("chat-cancel-suppress"),
				command_text: "/mu cancel",
			},
			binding: mkBinding(),
		});
		expect(cancelDecision.kind).toBe("response");

		const cancelledTurnDecision = await runtime.handleInbound({
			inbound: {
				...mkInbound("chat-cancel-suppress"),
				command_text: "continue",
			},
			binding: mkBinding(),
		});
		expect(cancelledTurnDecision.kind).toBe("reject");
		if (cancelledTurnDecision.kind !== "reject") {
			throw new Error(`expected reject decision, got ${cancelledTurnDecision.kind}`);
		}
		expect(cancelledTurnDecision.reason).toBe("operator_cancelled");
	} finally {
		await runtime.stop();
	}
});
