import type { ServerContext } from "../server.js";

type EventRecord = {
	ts_ms?: number;
	type?: string;
	source?: string;
	issue_id?: string;
	run_id?: string;
	payload?: unknown;
};

function trimOrNull(value: string | null): string | null {
	if (value == null) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function previewText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value == null) {
		return "";
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function includeByContains(event: EventRecord, contains: string | null): boolean {
	if (!contains) {
		return true;
	}
	const needle = contains.toLowerCase();
	const haystack = [
		event.type ?? "",
		event.source ?? "",
		event.issue_id ?? "",
		event.run_id ?? "",
		previewText(event.payload),
	]
		.join("\n")
		.toLowerCase();
	return haystack.includes(needle);
}

function applyEventFilters(
	events: EventRecord[],
	filters: {
		type: string | null;
		source: string | null;
		issueId: string | null;
		runId: string | null;
		sinceMs: number | null;
		contains: string | null;
	},
): EventRecord[] {
	return events
		.filter((event) => (filters.type ? event.type === filters.type : true))
		.filter((event) => (filters.source ? event.source === filters.source : true))
		.filter((event) => (filters.issueId ? event.issue_id === filters.issueId : true))
		.filter((event) => (filters.runId ? event.run_id === filters.runId : true))
		.filter((event) => {
			if (filters.sinceMs == null) {
				return true;
			}
			if (typeof event.ts_ms !== "number") {
				return false;
			}
			return event.ts_ms >= filters.sinceMs;
		})
		.filter((event) => includeByContains(event, filters.contains));
}

function parseSinceMs(value: string | null): number | null {
	if (value == null || value.trim().length === 0) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		return null;
	}
	return parsed;
}

export async function eventRoutes(request: Request, context: ServerContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace("/api/events", "") || "/";
	const method = request.method;

	if (method !== "GET") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	try {
		const allEvents = (await context.eventsStore.read()) as EventRecord[];
		const filters = {
			type: trimOrNull(url.searchParams.get("type")),
			source: trimOrNull(url.searchParams.get("source")),
			issueId: trimOrNull(url.searchParams.get("issue_id")),
			runId: trimOrNull(url.searchParams.get("run_id")),
			sinceMs: parseSinceMs(url.searchParams.get("since")),
			contains: trimOrNull(url.searchParams.get("contains")),
		};

		// Tail - GET /api/events/tail?n=50
		if (path === "/tail") {
			const n = Math.min(Math.max(1, parseInt(url.searchParams.get("n") ?? "50", 10) || 50), 500);
			const filtered = applyEventFilters(allEvents, filters);
			return Response.json(filtered.slice(-n));
		}

		// Query - GET /api/events?type=...&source=...&issue_id=...&run_id=...&since=...&contains=...&limit=50
		if (path === "/") {
			const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50), 500);
			const filtered = applyEventFilters(allEvents, filters);
			return Response.json(filtered.slice(-limit));
		}

		return new Response("Not Found", { status: 404 });
	} catch (error) {
		console.error("Events API error:", error);
		return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Internal server error" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}
