import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityStore } from "@femtomc/mu-control-plane";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-control-plane-identities-"));
}

describe("IdentityStore", () => {
	test("supports link / unlink self / revoke flows with assurance tiers", async () => {
		const repoRoot = await mkTempDir();
		const path = join(repoRoot, ".mu", "control-plane", "identities.jsonl");
		const store = new IdentityStore(path);
		await store.load();

		const linkedSlack = await store.link({
			bindingId: "binding-a",
			operatorId: "operator-1",
			channel: "slack",
			channelTenantId: "tenant-1",
			channelActorId: "actor-1",
			scopes: ["cp.read"],
			nowMs: 10,
		});
		expect(linkedSlack.kind).toBe("linked");
		if (linkedSlack.kind !== "linked") {
			throw new Error(`expected linked, got ${linkedSlack.kind}`);
		}
		expect(linkedSlack.binding.assurance_tier).toBe("tier_a");

		const linkedDiscord = await store.link({
			bindingId: "binding-b",
			operatorId: "operator-1",
			channel: "discord",
			channelTenantId: "tenant-1",
			channelActorId: "actor-2",
			scopes: ["cp.read", "cp.issue.write"],
			nowMs: 20,
		});
		expect(linkedDiscord.kind).toBe("linked");
		if (linkedDiscord.kind !== "linked") {
			throw new Error(`expected linked, got ${linkedDiscord.kind}`);
		}
		expect(linkedDiscord.binding.assurance_tier).toBe("tier_a");

		const linkedTelegram = await store.link({
			bindingId: "binding-c",
			operatorId: "operator-1",
			channel: "telegram",
			channelTenantId: "tenant-1",
			channelActorId: "actor-3",
			scopes: ["cp.read", "cp.issue.write"],
			nowMs: 25,
		});
		expect(linkedTelegram.kind).toBe("linked");
		if (linkedTelegram.kind !== "linked") {
			throw new Error(`expected linked, got ${linkedTelegram.kind}`);
		}
		expect(linkedTelegram.binding.assurance_tier).toBe("tier_b");

		const duplicatePrincipal = await store.link({
			bindingId: "binding-d",
			operatorId: "operator-1",
			channel: "slack",
			channelTenantId: "tenant-1",
			channelActorId: "actor-1",
			scopes: ["cp.read"],
			nowMs: 30,
		});
		expect(duplicatePrincipal.kind).toBe("principal_already_linked");

		const invalidUnlink = await store.unlinkSelf({
			bindingId: "binding-a",
			actorBindingId: "binding-b",
			nowMs: 40,
		});
		expect(invalidUnlink.kind).toBe("invalid_actor");

		const unlinked = await store.unlinkSelf({
			bindingId: "binding-a",
			actorBindingId: "binding-a",
			nowMs: 50,
		});
		expect(unlinked.kind).toBe("unlinked");
		if (unlinked.kind !== "unlinked") {
			throw new Error(`expected unlinked, got ${unlinked.kind}`);
		}
		expect(unlinked.binding.status).toBe("unlinked");

		const revoked = await store.revoke({
			bindingId: "binding-b",
			actorBindingId: "binding-admin",
			nowMs: 60,
			reason: "security_incident",
		});
		expect(revoked.kind).toBe("revoked");
		if (revoked.kind !== "revoked") {
			throw new Error(`expected revoked, got ${revoked.kind}`);
		}
		expect(revoked.binding.status).toBe("revoked");
		expect(revoked.binding.revoke_reason).toBe("security_incident");

		const restarted = new IdentityStore(path);
		await restarted.load();
		expect(restarted.get("binding-a")?.status).toBe("unlinked");
		expect(restarted.get("binding-b")?.status).toBe("revoked");
		expect(
			restarted.resolveActive({
				channel: "discord",
				channelTenantId: "tenant-1",
				channelActorId: "actor-2",
			}),
		).toBeNull();
		expect(
			restarted.resolveActive({
				channel: "telegram",
				channelTenantId: "tenant-1",
				channelActorId: "actor-3",
			})?.binding_id,
		).toBe("binding-c");
	});

	test("rejects unsupported channels during replay", async () => {
		const repoRoot = await mkTempDir();
		const path = join(repoRoot, ".mu", "control-plane", "identities.jsonl");
		const unsupportedBinding = {
			binding_id: "unsupported-im-1",
			operator_id: "operator-unsupported",
			channel: "imessage",
			channel_tenant_id: "imessage-local",
			channel_actor_id: "im-actor",
			assurance_tier: "tier_c",
			scopes: ["cp.read", "cp.issue.write"],
			status: "active",
			linked_at_ms: 1,
			updated_at_ms: 1,
			unlinked_at_ms: null,
			revoked_at_ms: null,
			revoked_by_binding_id: null,
			revoke_reason: null,
		};
		await Bun.write(path, `${JSON.stringify({ kind: "link", ts_ms: 1, binding: unsupportedBinding })}\n`);

		const store = new IdentityStore(path);
		await expect(store.load()).rejects.toThrow(/invalid identity row 0/);
	});
});
