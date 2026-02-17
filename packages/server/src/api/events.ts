import type { ServerContext } from "../server.js";

export async function eventRoutes(request: Request, context: ServerContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace("/api/events", "") || "/";
	const method = request.method;

	if (method !== "GET") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	try {
		const allEvents = await context.eventsStore.read();

		// Tail - GET /api/events/tail?n=50
		if (path === "/tail") {
			const n = Math.min(Math.max(1, parseInt(url.searchParams.get("n") ?? "50", 10) || 50), 500);
			return Response.json(allEvents.slice(-n));
		}

		// Query - GET /api/events?type=...&source=...&since=...&limit=50
		if (path === "/") {
			const typeFilter = url.searchParams.get("type");
			const sourceFilter = url.searchParams.get("source");
			const sinceRaw = url.searchParams.get("since");
			const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50), 500);

			let filtered = allEvents;

			if (typeFilter) {
				filtered = filtered.filter((e) => e.type === typeFilter);
			}
			if (sourceFilter) {
				filtered = filtered.filter((e) => e.source === sourceFilter);
			}
			if (sinceRaw) {
				const sinceMs = parseInt(sinceRaw, 10);
				if (!Number.isNaN(sinceMs)) {
					filtered = filtered.filter((e) => e.ts_ms >= sinceMs);
				}
			}

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
