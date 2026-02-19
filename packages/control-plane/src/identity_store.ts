import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { z } from "zod";
import { type AssuranceTier, AssuranceTierSchema } from "./models.js";

export const ChannelSchema = z.enum(["slack", "discord", "telegram", "neovim", "terminal"]);
export type Channel = z.infer<typeof ChannelSchema>;

export const CHANNEL_ASSURANCE_TIERS = {
	slack: "tier_a",
	discord: "tier_a",
	telegram: "tier_b",
	neovim: "tier_a",
	terminal: "tier_a",
} as const satisfies Record<Channel, AssuranceTier>;

export function assuranceTierForChannel(channel: Channel): AssuranceTier {
	return CHANNEL_ASSURANCE_TIERS[channel];
}

export const IdentityBindingStatusSchema = z.enum(["active", "unlinked", "revoked"]);
export type IdentityBindingStatus = z.infer<typeof IdentityBindingStatusSchema>;

export const IdentityBindingSchema = z.object({
	binding_id: z.string().min(1),
	operator_id: z.string().min(1),
	channel: ChannelSchema,
	channel_tenant_id: z.string().min(1),
	channel_actor_id: z.string().min(1),
	assurance_tier: AssuranceTierSchema,
	scopes: z.array(z.string().min(1)).default([]),
	status: IdentityBindingStatusSchema,
	linked_at_ms: z.number().int(),
	updated_at_ms: z.number().int(),
	unlinked_at_ms: z.number().int().nullable().default(null),
	revoked_at_ms: z.number().int().nullable().default(null),
	revoked_by_binding_id: z.string().min(1).nullable().default(null),
	revoke_reason: z.string().nullable().default(null),
});
export type IdentityBinding = z.infer<typeof IdentityBindingSchema>;

export const IdentityLinkEntrySchema = z.object({
	kind: z.literal("link"),
	ts_ms: z.number().int(),
	binding: IdentityBindingSchema,
});

export const IdentityUnlinkEntrySchema = z.object({
	kind: z.literal("unlink"),
	ts_ms: z.number().int(),
	binding_id: z.string().min(1),
	actor_binding_id: z.string().min(1),
	reason: z.string().nullable().default(null),
});

export const IdentityRevokeEntrySchema = z.object({
	kind: z.literal("revoke"),
	ts_ms: z.number().int(),
	binding_id: z.string().min(1),
	actor_binding_id: z.string().min(1),
	reason: z.string().nullable().default(null),
});

export const IdentityStoreEntrySchema = z.discriminatedUnion("kind", [
	IdentityLinkEntrySchema,
	IdentityUnlinkEntrySchema,
	IdentityRevokeEntrySchema,
]);
export type IdentityStoreEntry = z.infer<typeof IdentityStoreEntrySchema>;

export type LinkIdentityOpts = {
	bindingId: string;
	operatorId: string;
	channel: Channel;
	channelTenantId: string;
	channelActorId: string;
	scopes?: readonly string[];
	nowMs?: number;
};

export type LinkIdentityDecision =
	| { kind: "linked"; binding: IdentityBinding }
	| { kind: "binding_exists"; binding: IdentityBinding }
	| { kind: "principal_already_linked"; binding: IdentityBinding };

export type UnlinkIdentityDecision =
	| { kind: "unlinked"; binding: IdentityBinding }
	| { kind: "not_found" }
	| { kind: "invalid_actor" }
	| { kind: "already_inactive"; binding: IdentityBinding };

export type RevokeIdentityDecision =
	| { kind: "revoked"; binding: IdentityBinding }
	| { kind: "not_found" }
	| { kind: "already_inactive"; binding: IdentityBinding };

function bindingPrincipalKey(binding: {
	channel: Channel;
	channel_tenant_id: string;
	channel_actor_id: string;
}): string {
	return `${binding.channel}::${binding.channel_tenant_id}::${binding.channel_actor_id}`;
}

function resolvePrincipalKey(opts: { channel: Channel; channelTenantId: string; channelActorId: string }): string {
	return `${opts.channel}::${opts.channelTenantId}::${opts.channelActorId}`;
}

function cloneBinding(binding: IdentityBinding): IdentityBinding {
	return IdentityBindingSchema.parse(binding);
}

function assertBindingTier(binding: IdentityBinding): void {
	const expected = assuranceTierForChannel(binding.channel);
	if (binding.assurance_tier !== expected) {
		throw new Error(
			`binding ${binding.binding_id} has invalid assurance tier ${binding.assurance_tier} for channel ${binding.channel} (expected ${expected})`,
		);
	}
}

export const ROLE_SCOPES: Record<string, readonly string[]> = {
	operator: [
		"cp.read",
		"cp.issue.write",
		"cp.forum.write",
		"cp.run.execute",
		"cp.identity.self",
		"cp.identity.admin",
		"cp.ops.admin",
	],
	contributor: ["cp.read", "cp.issue.write", "cp.forum.write", "cp.run.execute", "cp.identity.self"],
	viewer: ["cp.read"],
};

export const TERMINAL_IDENTITY_BINDING: IdentityBinding = {
	binding_id: "terminal-local-binding",
	operator_id: "local-operator",
	channel: "terminal",
	channel_tenant_id: "local",
	channel_actor_id: "local-operator",
	assurance_tier: "tier_a",
	scopes: [...ROLE_SCOPES.operator],
	status: "active",
	linked_at_ms: 0,
	updated_at_ms: 0,
	unlinked_at_ms: null,
	revoked_at_ms: null,
	revoked_by_binding_id: null,
	revoke_reason: null,
};

export class IdentityStore {
	readonly #path: string;
	#loaded = false;
	readonly #bindingsById = new Map<string, IdentityBinding>();
	readonly #activeByPrincipal = new Map<string, string>();

	public constructor(path: string) {
		this.#path = path;
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		this.#bindingsById.clear();
		this.#activeByPrincipal.clear();

		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = IdentityStoreEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid identity row ${idx}: ${parsed.error.message}`);
			}
			this.#applyEntry(parsed.data, { replay: true });
		}

		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	#applyEntry(entry: IdentityStoreEntry, opts: { replay: boolean }): void {
		switch (entry.kind) {
			case "link": {
				assertBindingTier(entry.binding);
				this.#bindingsById.set(entry.binding.binding_id, cloneBinding(entry.binding));
				if (entry.binding.status === "active") {
					this.#activeByPrincipal.set(bindingPrincipalKey(entry.binding), entry.binding.binding_id);
				}
				break;
			}
			case "unlink": {
				const current = this.#bindingsById.get(entry.binding_id);
				if (!current) {
					if (opts.replay) {
						throw new Error(`identity unlink references unknown binding: ${entry.binding_id}`);
					}
					break;
				}

				const next = IdentityBindingSchema.parse({
					...current,
					status: "unlinked",
					updated_at_ms: entry.ts_ms,
					unlinked_at_ms: entry.ts_ms,
				});
				this.#bindingsById.set(next.binding_id, next);
				this.#activeByPrincipal.delete(bindingPrincipalKey(current));
				break;
			}
			case "revoke": {
				const current = this.#bindingsById.get(entry.binding_id);
				if (!current) {
					if (opts.replay) {
						throw new Error(`identity revoke references unknown binding: ${entry.binding_id}`);
					}
					break;
				}

				const next = IdentityBindingSchema.parse({
					...current,
					status: "revoked",
					updated_at_ms: entry.ts_ms,
					revoked_at_ms: entry.ts_ms,
					revoked_by_binding_id: entry.actor_binding_id,
					revoke_reason: entry.reason,
				});
				this.#bindingsById.set(next.binding_id, next);
				this.#activeByPrincipal.delete(bindingPrincipalKey(current));
				break;
			}
		}
	}

	public get(bindingId: string): IdentityBinding | null {
		const binding = this.#bindingsById.get(bindingId);
		return binding ? cloneBinding(binding) : null;
	}

	public resolveActive(opts: {
		channel: Channel;
		channelTenantId: string;
		channelActorId: string;
	}): IdentityBinding | null {
		const principal = resolvePrincipalKey(opts);
		const bindingId = this.#activeByPrincipal.get(principal);
		if (!bindingId) {
			return null;
		}
		const binding = this.#bindingsById.get(bindingId);
		if (!binding || binding.status !== "active") {
			return null;
		}
		return cloneBinding(binding);
	}

	public listBindings(opts: { includeInactive?: boolean } = {}): IdentityBinding[] {
		const includeInactive = opts.includeInactive ?? false;
		const out: IdentityBinding[] = [];
		for (const binding of this.#bindingsById.values()) {
			if (!includeInactive && binding.status !== "active") {
				continue;
			}
			out.push(cloneBinding(binding));
		}
		out.sort((a, b) => {
			if (a.linked_at_ms !== b.linked_at_ms) {
				return a.linked_at_ms - b.linked_at_ms;
			}
			return a.binding_id.localeCompare(b.binding_id);
		});
		return out;
	}

	public async link(opts: LinkIdentityOpts): Promise<LinkIdentityDecision> {
		await this.#ensureLoaded();
		const channel = ChannelSchema.parse(opts.channel);
		const nowMs = Math.trunc(opts.nowMs ?? Date.now());

		const existingById = this.#bindingsById.get(opts.bindingId);
		if (existingById) {
			return { kind: "binding_exists", binding: cloneBinding(existingById) };
		}

		const principal = resolvePrincipalKey({
			channel,
			channelTenantId: opts.channelTenantId,
			channelActorId: opts.channelActorId,
		});
		const existingPrincipalBindingId = this.#activeByPrincipal.get(principal);
		if (existingPrincipalBindingId) {
			const existing = this.#bindingsById.get(existingPrincipalBindingId);
			if (existing) {
				return { kind: "principal_already_linked", binding: cloneBinding(existing) };
			}
		}

		const binding = IdentityBindingSchema.parse({
			binding_id: opts.bindingId,
			operator_id: opts.operatorId,
			channel,
			channel_tenant_id: opts.channelTenantId,
			channel_actor_id: opts.channelActorId,
			assurance_tier: assuranceTierForChannel(channel),
			scopes: [...(opts.scopes ?? [])],
			status: "active",
			linked_at_ms: nowMs,
			updated_at_ms: nowMs,
			unlinked_at_ms: null,
			revoked_at_ms: null,
			revoked_by_binding_id: null,
			revoke_reason: null,
		});
		const entry = IdentityLinkEntrySchema.parse({
			kind: "link",
			ts_ms: nowMs,
			binding,
		});
		await appendJsonl(this.#path, entry);
		this.#applyEntry(entry, { replay: false });
		return { kind: "linked", binding: cloneBinding(binding) };
	}

	public async unlinkSelf(opts: {
		bindingId: string;
		actorBindingId: string;
		nowMs?: number;
		reason?: string | null;
	}): Promise<UnlinkIdentityDecision> {
		await this.#ensureLoaded();
		const current = this.#bindingsById.get(opts.bindingId);
		if (!current) {
			return { kind: "not_found" };
		}
		if (current.status !== "active") {
			return { kind: "already_inactive", binding: cloneBinding(current) };
		}
		if (opts.actorBindingId !== opts.bindingId) {
			return { kind: "invalid_actor" };
		}

		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const entry = IdentityUnlinkEntrySchema.parse({
			kind: "unlink",
			ts_ms: nowMs,
			binding_id: opts.bindingId,
			actor_binding_id: opts.actorBindingId,
			reason: opts.reason ?? null,
		});
		await appendJsonl(this.#path, entry);
		this.#applyEntry(entry, { replay: false });
		const updated = this.#bindingsById.get(opts.bindingId);
		if (!updated) {
			throw new Error(`identity binding missing after unlink: ${opts.bindingId}`);
		}
		return { kind: "unlinked", binding: cloneBinding(updated) };
	}

	public async revoke(opts: {
		bindingId: string;
		actorBindingId: string;
		nowMs?: number;
		reason?: string | null;
	}): Promise<RevokeIdentityDecision> {
		await this.#ensureLoaded();
		const current = this.#bindingsById.get(opts.bindingId);
		if (!current) {
			return { kind: "not_found" };
		}
		if (current.status !== "active") {
			return { kind: "already_inactive", binding: cloneBinding(current) };
		}

		const nowMs = Math.trunc(opts.nowMs ?? Date.now());
		const entry = IdentityRevokeEntrySchema.parse({
			kind: "revoke",
			ts_ms: nowMs,
			binding_id: opts.bindingId,
			actor_binding_id: opts.actorBindingId,
			reason: opts.reason ?? null,
		});
		await appendJsonl(this.#path, entry);
		this.#applyEntry(entry, { replay: false });
		const updated = this.#bindingsById.get(opts.bindingId);
		if (!updated) {
			throw new Error(`identity binding missing after revoke: ${opts.bindingId}`);
		}
		return { kind: "revoked", binding: cloneBinding(updated) };
	}
}
