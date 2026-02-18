import type { ForumMessage, JsonlStore } from "@femtomc/mu-core";
import { EventLog, ForumMessageSchema, NullEventSink, nowTs } from "@femtomc/mu-core";
import { normalizeForumPrefix, normalizeForumReadLimit, normalizeForumTopic } from "./contracts.js";

export type ForumTopicSummary = {
	topic: string;
	messages: number;
	last_at: number;
};

export class ForumStore {
	public readonly events: EventLog;
	readonly #forum: JsonlStore<unknown>;

	public constructor(forum: JsonlStore<unknown>, opts: { events?: EventLog } = {}) {
		this.#forum = forum;
		this.events = opts.events ?? new EventLog(new NullEventSink());
	}

	async #load(): Promise<ForumMessage[]> {
		const rows = await this.#forum.read();
		return rows.map((row, idx) => {
			const parsed = ForumMessageSchema.safeParse(row);
			if (!parsed.success) {
				throw new Error(`invalid forum row ${idx}: ${parsed.error.message}`);
			}
			return parsed.data;
		});
	}


	public async post(topic: string, body: string, author: string = "system"): Promise<ForumMessage> {
		const normalizedTopic = normalizeForumTopic(topic);

		let issueId: string | undefined;
		if (normalizedTopic.startsWith("issue:")) {
			const candidate = normalizedTopic.slice("issue:".length).trim();
			if (candidate.length > 0) {
				issueId = candidate;
			}
		}

		const msg = ForumMessageSchema.parse({
			topic: normalizedTopic,
			body,
			author,
			created_at: nowTs(),
		});

		await this.#forum.append(msg);

		await this.events.emit("forum.post", {
			source: "forum_store",
			issueId,
			payload: { message: msg },
		});

		return msg;
	}

	public async read(topic: string, limit: number = 50): Promise<ForumMessage[]> {
		const normalizedTopic = normalizeForumTopic(topic);
		const normalizedLimit = normalizeForumReadLimit(limit);

		const rows = await this.#load();
		const matching = rows.filter((row) => row.topic === normalizedTopic);
		return matching.slice(-normalizedLimit);
	}

	public async topics(prefix: string | null = null): Promise<ForumTopicSummary[]> {
		const normalizedPrefix = normalizeForumPrefix(prefix);
		const rows = await this.#load();

		const byTopic = new Map<string, ForumTopicSummary>();
		for (const row of rows) {
			const topic = row.topic;
			if (normalizedPrefix && !topic.startsWith(normalizedPrefix)) {
				continue;
			}

			const entry = byTopic.get(topic) ?? { topic, messages: 0, last_at: 0 };
			entry.messages += 1;
			entry.last_at = Math.max(entry.last_at, Math.trunc((row as any).created_at ?? 0));
			byTopic.set(topic, entry);
		}

		// Sort by descending activity time, then topic name.
		const out = [...byTopic.values()];
		out.sort((a, b) => {
			if (a.last_at !== b.last_at) {
				return b.last_at - a.last_at;
			}
			if (a.topic < b.topic) {
				return 1;
			}
			if (a.topic > b.topic) {
				return -1;
			}
			return 0;
		});
		return out;
	}
}
