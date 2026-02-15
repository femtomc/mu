import type { ServerContext } from "../server.js";

export async function forumRoutes(request: Request, context: ServerContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace("/api/forum", "") || "/";
	const method = request.method;
	
	try {
		// List topics - GET /api/forum/topics
		if (path === "/topics" && method === "GET") {
			const prefix = url.searchParams.get("prefix");
			const topics = await context.forumStore.topics(prefix);
			return Response.json(topics);
		}
		
		// Read messages - GET /api/forum/read
		if (path === "/read" && method === "GET") {
			const topic = url.searchParams.get("topic");
			const limit = url.searchParams.get("limit");
			
			if (!topic) {
				return new Response("Topic is required", { status: 400 });
			}
			
			const messages = await context.forumStore.read(
				topic,
				limit ? parseInt(limit, 10) : 50
			);
			return Response.json(messages);
		}
		
		// Post message - POST /api/forum/post
		if (path === "/post" && method === "POST") {
			const body = await request.json() as any;
			const { topic, body: messageBody, author } = body;
			
			if (!topic || !messageBody) {
				return new Response("Topic and body are required", { status: 400 });
			}
			
			const message = await context.forumStore.post(
				topic,
				messageBody,
				author || "system"
			);
			
			return Response.json(message, { status: 201 });
		}
		
		return new Response("Not Found", { status: 404 });
		
	} catch (error) {
		console.error("Forum API error:", error);
		return new Response(
			JSON.stringify({ error: error instanceof Error ? error.message : "Internal server error" }),
			{ 
				status: 500,
				headers: { "Content-Type": "application/json" }
			}
		);
	}
}