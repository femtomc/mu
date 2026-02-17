import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { z } from "zod";

export const AdapterAuditEntrySchema = z.object({
	kind: z.literal("adapter.audit"),
	ts_ms: z.number().int(),
	channel: z.string().min(1),
	request_id: z.string().min(1),
	delivery_id: z.string().min(1),
	channel_tenant_id: z.string().min(1),
	channel_conversation_id: z.string().min(1),
	actor_id: z.string().min(1),
	command_text: z.string().min(1),
	event: z.string().min(1),
	reason: z.string().nullable().default(null),
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AdapterAuditEntry = z.infer<typeof AdapterAuditEntrySchema>;

export class AdapterAuditLog {
	readonly #path: string;

	public constructor(path: string) {
		this.#path = path;
	}

	public get path(): string {
		return this.#path;
	}

	public async append(entry: Omit<AdapterAuditEntry, "kind">): Promise<AdapterAuditEntry> {
		const parsed = AdapterAuditEntrySchema.parse({
			kind: "adapter.audit",
			...entry,
		});
		await appendJsonl(this.#path, parsed);
		return parsed;
	}

	public async list(opts: { channel?: string | null; event?: string | null } = {}): Promise<AdapterAuditEntry[]> {
		const rows = await readJsonl(this.#path);
		const out: AdapterAuditEntry[] = [];
		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = AdapterAuditEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid adapter audit row ${idx}: ${parsed.error.message}`);
			}
			if (opts.channel && parsed.data.channel !== opts.channel) {
				continue;
			}
			if (opts.event && parsed.data.event !== opts.event) {
				continue;
			}
			out.push(parsed.data);
		}
		out.sort((a, b) => {
			if (a.ts_ms !== b.ts_ms) {
				return a.ts_ms - b.ts_ms;
			}
			return a.request_id.localeCompare(b.request_id);
		});
		return out;
	}
}
