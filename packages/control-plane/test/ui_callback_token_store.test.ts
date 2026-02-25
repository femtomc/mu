import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { UiCallbackTokenScope, UiCallbackTokenStore } from "@femtomc/mu-control-plane";
import type { UiEvent } from "@femtomc/mu-core";

function makeScope(overrides: Partial<UiCallbackTokenScope> = {}): UiCallbackTokenScope {
  return {
    channel: "ui-channel",
    channelTenantId: "tenant-123",
    channelConversationId: "conversation-abc",
    actorBindingId: "binding-xyz",
    uiId: "hud-main",
    revision: 1,
    actionId: "action-confirm",
    ...overrides,
  };
}

function makeEvent(scope: UiCallbackTokenScope, overrides: Partial<UiEvent> = {}): UiEvent {
  return {
    ui_id: scope.uiId,
    action_id: scope.actionId,
    revision: { id: `rev-${scope.revision}`, version: scope.revision },
    created_at_ms: 1_000,
    payload: {},
    metadata: {},
    ...overrides,
  };
}

describe("UiCallbackTokenStore", () => {
  test("issues scoped tokens that consume exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-ui-token-store-"));
    const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
    const scope = makeScope();
    const record = await store.issue({ scope, uiEvent: makeEvent(scope), ttlMs: 30_000, nowMs: 1_000 });

    expect(record.callback_data.startsWith("mu-ui:")).toBe(true);
    expect(record.channel).toBe(scope.channel);
    expect(record.channel_tenant_id).toBe(scope.channelTenantId);
    expect(record.ui_event.ui_id).toBe(scope.uiId);
    expect(record.ui_event.action_id).toBe(scope.actionId);

    const first = await store.decodeAndConsume({ callbackData: record.callback_data, scope: { ...scope }, nowMs: 2_000 });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") {
      throw new Error(`expected ok, got ${first.kind}`);
    }
    expect(first.record.action_id).toBe(scope.actionId);

    const second = await store.decodeAndConsume({ callbackData: record.callback_data, scope: { ...scope }, nowMs: 3_000 });
    expect(second.kind).toBe("consumed");
  });

  test("rejects expired callbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-ui-token-store-expired-"));
    const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
    const scope = makeScope({ uiId: "hud-expired" });
    const record = await store.issue({ scope, uiEvent: makeEvent(scope), ttlMs: 100, nowMs: 100 });

    const expired = await store.decodeAndConsume({ callbackData: record.callback_data, scope: { ...scope }, nowMs: 250 });
    expect(expired.kind).toBe("expired");
  });

  test("detects scope mismatches without consuming the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-ui-token-store-scope-"));
    const store = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
    const scope = makeScope({ uiId: "hud-scope" });
    const record = await store.issue({ scope, uiEvent: makeEvent(scope), ttlMs: 5_000, nowMs: 1_000 });

    const mismatchScope = { ...scope, revision: scope.revision + 1 };
    const mismatch = await store.decodeAndConsume({ callbackData: record.callback_data, scope: mismatchScope, nowMs: 2_000 });
    expect(mismatch.kind).toBe("scope_mismatch");

    const ok = await store.decodeAndConsume({ callbackData: record.callback_data, scope: { ...scope }, nowMs: 3_000 });
    expect(ok.kind).toBe("ok");
  });

  test("handles token id collisions by retrying generator", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-ui-token-store-collision-"));
    const firstStore = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"));
    const firstScope = makeScope({ uiId: "hud-collision-first" });
    const firstRecord = await firstStore.issue({ scope: firstScope, uiEvent: makeEvent(firstScope), ttlMs: 5_000, nowMs: 1_000 });

    let attempts = 0;
    const generator = () => {
      attempts += 1;
      if (attempts === 1) {
        return firstRecord.token_id;
      }
      return `collision-${attempts}-token-${Date.now().toString(36)}`;
    };
    const secondStore = new UiCallbackTokenStore(join(root, "ui_callback_tokens.jsonl"), { tokenIdGenerator: generator });
    const secondScope = makeScope({ uiId: "hud-collision-second", revision: 2 });
    const secondRecord = await secondStore.issue({ scope: secondScope, uiEvent: makeEvent(secondScope), ttlMs: 5_000, nowMs: 2_000 });

    expect(secondRecord.token_id).not.toBe(firstRecord.token_id);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
