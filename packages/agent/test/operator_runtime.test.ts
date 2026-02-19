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

function mkBinding(): MessagingOperatorIdentityBinding {
	return {
		binding_id: "binding-1",
		assurance_tier: "tier_b",
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
