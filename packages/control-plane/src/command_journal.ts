import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { z } from "zod";
import { type CommandRecord, CommandRecordSchema, correlationFromCommandRecord } from "./command_record.js";
import {
	assertValidTransition,
	type CommandState,
	isTerminalCommandState,
	lifecycleEventTypeForState,
} from "./command_state.js";
import { CorrelationMetadataSchema } from "./models.js";

export const CommandLifecycleJournalEntrySchema = z.object({
	kind: z.literal("command.lifecycle"),
	ts_ms: z.number().int(),
	event_type: z.string().min(1),
	command: CommandRecordSchema,
	correlation: CorrelationMetadataSchema,
});
export type CommandLifecycleJournalEntry = z.infer<typeof CommandLifecycleJournalEntrySchema>;

export const MutatingDomainJournalEntrySchema = z.object({
	kind: z.literal("domain.mutating"),
	ts_ms: z.number().int(),
	event_type: z.string().min(1),
	payload: z.record(z.string(), z.unknown()),
	correlation: CorrelationMetadataSchema,
});
export type MutatingDomainJournalEntry = z.infer<typeof MutatingDomainJournalEntrySchema>;

export const CommandJournalEntrySchema = z.discriminatedUnion("kind", [
	CommandLifecycleJournalEntrySchema,
	MutatingDomainJournalEntrySchema,
]);
export type CommandJournalEntry = z.infer<typeof CommandJournalEntrySchema>;

export type CommandJournalIndex = {
	entries: CommandJournalEntry[];
	latestByCommandId: Map<string, CommandRecord>;
	lifecycleByCommandId: Map<string, CommandLifecycleJournalEntry[]>;
	mutatingByCommandId: Map<string, MutatingDomainJournalEntry[]>;
};

function orderCommands(a: CommandRecord, b: CommandRecord): number {
	if (a.created_at_ms !== b.created_at_ms) {
		return a.created_at_ms - b.created_at_ms;
	}
	return a.command_id.localeCompare(b.command_id);
}

function cloneCommandRecord(record: CommandRecord): CommandRecord {
	return CommandRecordSchema.parse(record);
}

function cloneLifecycleEntry(entry: CommandLifecycleJournalEntry): CommandLifecycleJournalEntry {
	return CommandLifecycleJournalEntrySchema.parse(entry);
}

function cloneMutatingEntry(entry: MutatingDomainJournalEntry): MutatingDomainJournalEntry {
	return MutatingDomainJournalEntrySchema.parse(entry);
}

export class CommandJournal {
	readonly #path: string;
	#loaded = false;
	#entries: CommandJournalEntry[] = [];
	readonly #latestByCommandId = new Map<string, CommandRecord>();
	readonly #lifecycleByCommandId = new Map<string, CommandLifecycleJournalEntry[]>();
	readonly #mutatingByCommandId = new Map<string, MutatingDomainJournalEntry[]>();

	public constructor(path: string) {
		this.#path = path;
	}

	public get path(): string {
		return this.#path;
	}

	public async load(): Promise<void> {
		const rows = await readJsonl(this.#path);
		const entries: CommandJournalEntry[] = [];
		const latestByCommandId = new Map<string, CommandRecord>();
		const lifecycleByCommandId = new Map<string, CommandLifecycleJournalEntry[]>();
		const mutatingByCommandId = new Map<string, MutatingDomainJournalEntry[]>();

		for (let idx = 0; idx < rows.length; idx++) {
			const parsed = CommandJournalEntrySchema.safeParse(rows[idx]);
			if (!parsed.success) {
				throw new Error(`invalid command journal row ${idx}: ${parsed.error.message}`);
			}
			const entry = parsed.data;
			entries.push(entry);
			if (entry.kind === "command.lifecycle") {
				latestByCommandId.set(entry.command.command_id, entry.command);
				const lifecycle = lifecycleByCommandId.get(entry.command.command_id) ?? [];
				lifecycle.push(entry);
				lifecycleByCommandId.set(entry.command.command_id, lifecycle);
			} else {
				const arr = mutatingByCommandId.get(entry.correlation.command_id) ?? [];
				arr.push(entry);
				mutatingByCommandId.set(entry.correlation.command_id, arr);
			}
		}

		this.#entries = entries;
		this.#latestByCommandId.clear();
		this.#lifecycleByCommandId.clear();
		this.#mutatingByCommandId.clear();
		for (const [key, value] of latestByCommandId.entries()) {
			this.#latestByCommandId.set(key, cloneCommandRecord(value));
		}
		for (const [key, value] of lifecycleByCommandId.entries()) {
			this.#lifecycleByCommandId.set(
				key,
				value.map((entry) => cloneLifecycleEntry(entry)),
			);
		}
		for (const [key, value] of mutatingByCommandId.entries()) {
			this.#mutatingByCommandId.set(
				key,
				value.map((entry) => cloneMutatingEntry(entry)),
			);
		}
		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) {
			await this.load();
		}
	}

	public get(commandId: string): CommandRecord | null {
		const record = this.#latestByCommandId.get(commandId);
		return record ? cloneCommandRecord(record) : null;
	}

	public lifecycleEvents(commandId: string): CommandLifecycleJournalEntry[] {
		const rows = this.#lifecycleByCommandId.get(commandId) ?? [];
		return rows.map((entry) => cloneLifecycleEntry(entry));
	}

	public hasMutatingEvents(commandId: string): boolean {
		const rows = this.#mutatingByCommandId.get(commandId);
		return (rows?.length ?? 0) > 0;
	}

	public mutatingEvents(commandId: string): MutatingDomainJournalEntry[] {
		const rows = this.#mutatingByCommandId.get(commandId) ?? [];
		return rows.map((entry) => cloneMutatingEntry(entry));
	}

	public nonTerminalCommands(): CommandRecord[] {
		const out: CommandRecord[] = [];
		for (const record of this.#latestByCommandId.values()) {
			if (!isTerminalCommandState(record.state)) {
				out.push(cloneCommandRecord(record));
			}
		}
		out.sort(orderCommands);
		return out;
	}

	public snapshot(): CommandJournalIndex {
		const latestByCommandId = new Map<string, CommandRecord>();
		for (const [key, value] of this.#latestByCommandId.entries()) {
			latestByCommandId.set(key, cloneCommandRecord(value));
		}
		const lifecycleByCommandId = new Map<string, CommandLifecycleJournalEntry[]>();
		for (const [key, value] of this.#lifecycleByCommandId.entries()) {
			lifecycleByCommandId.set(
				key,
				value.map((entry) => cloneLifecycleEntry(entry)),
			);
		}
		const mutatingByCommandId = new Map<string, MutatingDomainJournalEntry[]>();
		for (const [key, value] of this.#mutatingByCommandId.entries()) {
			mutatingByCommandId.set(
				key,
				value.map((entry) => cloneMutatingEntry(entry)),
			);
		}

		return {
			entries: this.#entries.map((entry) => CommandJournalEntrySchema.parse(entry)),
			latestByCommandId,
			lifecycleByCommandId,
			mutatingByCommandId,
		};
	}

	public async appendLifecycle(
		command: CommandRecord,
		opts: { eventType?: string; tsMs?: number } = {},
	): Promise<void> {
		await this.#ensureLoaded();
		const parsed = CommandRecordSchema.parse(command);
		const previous = this.#latestByCommandId.get(parsed.command_id);
		if (previous) {
			assertValidTransition(previous.state, parsed.state);
			if (parsed.created_at_ms !== previous.created_at_ms) {
				throw new Error(
					`command ${parsed.command_id} created_at_ms changed across transitions (${previous.created_at_ms} -> ${parsed.created_at_ms})`,
				);
			}
			if (parsed.updated_at_ms < previous.updated_at_ms) {
				throw new Error(
					`command ${parsed.command_id} updated_at_ms regressed (${previous.updated_at_ms} -> ${parsed.updated_at_ms})`,
				);
			}
		}

		const eventType = opts.eventType ?? lifecycleEventTypeForState(parsed.state);
		const correlation = correlationFromCommandRecord(parsed);
		const entry = CommandLifecycleJournalEntrySchema.parse({
			kind: "command.lifecycle",
			ts_ms: Math.trunc(opts.tsMs ?? parsed.updated_at_ms),
			event_type: eventType,
			command: parsed,
			correlation,
		});
		await appendJsonl(this.#path, entry);
		this.#entries.push(entry);
		this.#latestByCommandId.set(parsed.command_id, cloneCommandRecord(parsed));
		const lifecycle = this.#lifecycleByCommandId.get(parsed.command_id) ?? [];
		lifecycle.push(cloneLifecycleEntry(entry));
		this.#lifecycleByCommandId.set(parsed.command_id, lifecycle);
	}

	public async appendMutatingDomainEvent(opts: {
		eventType: string;
		command: CommandRecord;
		payload: Record<string, unknown>;
		tsMs?: number;
		errorCode?: string | null;
		state?: CommandState;
	}): Promise<void> {
		await this.#ensureLoaded();
		const parsedCommand = CommandRecordSchema.parse(opts.command);
		const payload = opts.payload;
		if (typeof payload !== "object" || payload == null || Array.isArray(payload)) {
			throw new TypeError("payload must be an object");
		}

		const correlation = CorrelationMetadataSchema.parse({
			...correlationFromCommandRecord(parsedCommand),
			state: opts.state ?? parsedCommand.state,
			error_code: opts.errorCode ?? parsedCommand.error_code ?? null,
		});
		const entry = MutatingDomainJournalEntrySchema.parse({
			kind: "domain.mutating",
			ts_ms: Math.trunc(opts.tsMs ?? parsedCommand.updated_at_ms),
			event_type: opts.eventType,
			payload,
			correlation,
		});
		await appendJsonl(this.#path, entry);
		this.#entries.push(entry);

		const rows = this.#mutatingByCommandId.get(correlation.command_id) ?? [];
		rows.push(cloneMutatingEntry(entry));
		this.#mutatingByCommandId.set(correlation.command_id, rows);
	}
}
