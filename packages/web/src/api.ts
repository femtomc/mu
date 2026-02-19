const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
	const res = await fetch(`${API_BASE}${url}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options?.headers,
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new ApiError(res.status, text || `HTTP ${res.status}`);
	}

	return res.json();
}

export const api = {
	// Status
	async getStatus() {
		return fetchJson("/api/status");
	},

	// Issues
	async listIssues(params?: { status?: string; tag?: string }) {
		const query = new URLSearchParams();
		if (params?.status) query.set("status", params.status);
		if (params?.tag) query.set("tag", params.tag);
		const queryStr = query.toString();
		return fetchJson(`/api/issues${queryStr ? `?${queryStr}` : ""}`);
	},

	async getIssue(id: string) {
		return fetchJson(`/api/issues/${id}`);
	},

	async createIssue(data: { title: string; body?: string; tags?: string[]; priority?: number }) {
		return fetchJson("/api/issues", {
			method: "POST",
			body: JSON.stringify(data),
		});
	},

	async updateIssue(id: string, data: Record<string, unknown>) {
		return fetchJson(`/api/issues/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		});
	},

	async claimIssue(id: string) {
		return fetchJson(`/api/issues/${id}/claim`, {
			method: "POST",
			body: JSON.stringify({}),
		});
	},

	async closeIssue(id: string, outcome: string) {
		return fetchJson(`/api/issues/${id}/close`, {
			method: "POST",
			body: JSON.stringify({ outcome }),
		});
	},

	async getReadyIssues(root?: string) {
		const query = root ? `?root=${encodeURIComponent(root)}` : "";
		return fetchJson(`/api/issues/ready${query}`);
	},

	// Forum
	async postMessage(topic: string, body: string, author: string) {
		return fetchJson("/api/forum/post", {
			method: "POST",
			body: JSON.stringify({ topic, body, author }),
		});
	},

	async readMessages(topic: string, limit?: number) {
		const query = new URLSearchParams({ topic });
		if (limit) query.set("limit", String(limit));
		return fetchJson(`/api/forum/read?${query}`);
	},

	async listTopics(prefix?: string, limit?: number) {
		const query = new URLSearchParams();
		if (prefix) query.set("prefix", prefix);
		if (limit) query.set("limit", String(limit));
		const queryStr = query.toString();
		return fetchJson(`/api/forum/topics${queryStr ? `?${queryStr}` : ""}`);
	},

	// Events
	async getEvents(params?: { type?: string; source?: string; limit?: number }) {
		const query = new URLSearchParams();
		if (params?.type) query.set("type", params.type);
		if (params?.source) query.set("source", params.source);
		if (params?.limit) query.set("limit", String(params.limit));
		const queryStr = query.toString();
		return fetchJson(`/api/events${queryStr ? `?${queryStr}` : ""}`);
	},

	async getEventsTail(n?: number) {
		const query = n ? `?n=${n}` : "";
		return fetchJson(`/api/events/tail${query}`);
	},
} as const;
