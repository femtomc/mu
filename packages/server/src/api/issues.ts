import type { ServerContext } from "../server.js";

export async function issueRoutes(request: Request, context: ServerContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace("/api/issues", "") || "/";
	const method = request.method;
	
	try {
		// List issues - GET /api/issues
		if (path === "/" && method === "GET") {
			const status = url.searchParams.get("status");
			const tag = url.searchParams.get("tag");
			const issues = await context.issueStore.list({
				status: status as any,
				tag: tag || undefined
			});
			return Response.json(issues);
		}
		
		// Get ready issues - GET /api/issues/ready
		if (path === "/ready" && method === "GET") {
			const root = url.searchParams.get("root");
			const issues = await context.issueStore.ready(root || undefined);
			return Response.json(issues);
		}
		
		// Get single issue - GET /api/issues/:id
		if (path.startsWith("/") && method === "GET") {
			const id = path.slice(1);
			if (id) {
				const issue = await context.issueStore.get(id);
				if (!issue) {
					return new Response("Issue not found", { status: 404 });
				}
				return Response.json(issue);
			}
		}
		
		// Create issue - POST /api/issues
		if (path === "/" && method === "POST") {
			const body = await request.json() as any;
			const { title, body: issueBody, tags, priority, execution_spec } = body;
			
			if (!title) {
				return new Response("Title is required", { status: 400 });
			}
			
			const issue = await context.issueStore.create(title, {
				body: issueBody,
				tags,
				priority,
				execution_spec
			});
			
			return Response.json(issue, { status: 201 });
		}
		
		// Update issue - PATCH /api/issues/:id
		if (path.startsWith("/") && method === "PATCH") {
			const id = path.slice(1);
			if (id) {
				const body = await request.json() as Record<string, unknown>;
				const issue = await context.issueStore.update(id, body);
				return Response.json(issue);
			}
		}
		
		// Close issue - POST /api/issues/:id/close
		if (path.endsWith("/close") && method === "POST") {
			const id = path.slice(1, -6); // Remove leading / and trailing /close
			const body = await request.json() as any;
			const { outcome } = body;
			
			if (!outcome) {
				return new Response("Outcome is required", { status: 400 });
			}
			
			const issue = await context.issueStore.close(id, outcome);
			return Response.json(issue);
		}
		
		// Claim issue - POST /api/issues/:id/claim
		if (path.endsWith("/claim") && method === "POST") {
			const id = path.slice(1, -6); // Remove leading / and trailing /claim
			
			const success = await context.issueStore.claim(id);
			if (!success) {
				return new Response("Failed to claim issue", { status: 409 });
			}
			
			const issue = await context.issueStore.get(id);
			return Response.json(issue);
		}
		
		return new Response("Not Found", { status: 404 });
		
	} catch (error) {
		console.error("Issue API error:", error);
		return new Response(
			JSON.stringify({ error: error instanceof Error ? error.message : "Internal server error" }),
			{ 
				status: 500,
				headers: { "Content-Type": "application/json" }
			}
		);
	}
}