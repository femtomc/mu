import {
	DEFAULT_FORUM_TOPICS_LIMIT,
	ForumStoreValidationError,
	normalizeForumPrefix,
	normalizeForumReadLimit,
	normalizeForumTopic,
	normalizeForumTopicsLimit,
} from "@femtomc/mu-forum";
import type { ServerContext } from "../server.js";

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ForumStoreValidationError("invalid json body");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ForumStoreValidationError("json body must be an object");
	}
	return body as Record<string, unknown>;
}

function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mapForumRouteError(error: unknown): Response {
	if (error instanceof ForumStoreValidationError) {
		return errorResponse(400, error.message);
	}
	if (error instanceof Error && error.name === "ZodError") {
		return errorResponse(400, error.message);
	}
	console.error("Forum API error:", error);
	return errorResponse(500, error instanceof Error ? error.message : "Internal server error");
}

export async function forumRoutes(request: Request, context: ServerContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace("/api/forum", "") || "/";
	const method = request.method;

	try {
		// List topics - GET /api/forum/topics
		if (path === "/topics" && method === "GET") {
			const prefix = normalizeForumPrefix(url.searchParams.get("prefix"));
			const limit = normalizeForumTopicsLimit(url.searchParams.get("limit"), {
				defaultLimit: DEFAULT_FORUM_TOPICS_LIMIT,
			});
			const topics = await context.forumStore.topics(prefix, { limit });
			return Response.json(topics);
		}

		// Read messages - GET /api/forum/read
		if (path === "/read" && method === "GET") {
			const topic = normalizeForumTopic(url.searchParams.get("topic"));
			const limit = normalizeForumReadLimit(url.searchParams.get("limit"));
			const messages = await context.forumStore.read(topic, limit);
			return Response.json(messages);
		}

		// Post message - POST /api/forum/post
		if (path === "/post" && method === "POST") {
			const body = await readJsonBody(request);
			const topic = normalizeForumTopic(body.topic);

			if (typeof body.body !== "string" || body.body.trim().length === 0) {
				return errorResponse(400, "body is required");
			}
			const messageBody = body.body;

			let author = "system";
			if (body.author != null) {
				if (typeof body.author !== "string" || body.author.trim().length === 0) {
					return errorResponse(400, "author must be a non-empty string when provided");
				}
				author = body.author.trim();
			}

			const message = await context.forumStore.post(topic, messageBody, author);
			return Response.json(message, { status: 201 });
		}

		return new Response("Not Found", { status: 404 });
	} catch (error) {
		return mapForumRouteError(error);
	}
}
