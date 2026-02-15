import type { Issue, ForumMessage, JsonlStore } from "@femtomc/mu-core";
import { EventLog, fsEventLogFromRepoRoot, FsJsonlStore, getStorePaths } from "@femtomc/mu-core/node";
import { IssueStore } from "@femtomc/mu-issue";
import { ForumStore } from "@femtomc/mu-forum";

import { issueRoutes } from "./api/issues.js";
import { forumRoutes } from "./api/forum.js";

export type ServerOptions = {
	repoRoot?: string;
	port?: number;
};

export type ServerContext = {
	repoRoot: string;
	issueStore: IssueStore;
	forumStore: ForumStore;
	eventLog: EventLog;
};

export function createContext(repoRoot: string): ServerContext {
	const paths = getStorePaths(repoRoot);
	const eventLog = fsEventLogFromRepoRoot(repoRoot);
	
	const issueStore = new IssueStore(
		new FsJsonlStore<Issue>(paths.issuesPath),
		{ events: eventLog }
	);
	
	const forumStore = new ForumStore(
		new FsJsonlStore<ForumMessage>(paths.forumPath),
		{ events: eventLog }
	);
	
	return { repoRoot, issueStore, forumStore, eventLog };
}

export function createServer(options: ServerOptions = {}) {
	const repoRoot = options.repoRoot || process.cwd();
	const context = createContext(repoRoot);
	
	const handleRequest = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;
		
		// CORS headers for development
		const headers = new Headers({
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		});
		
		// Handle preflight requests
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers });
		}
		
		// Health check
		if (path === "/healthz" || path === "/health") {
			return new Response("ok", { status: 200, headers });
		}
		
		// Status endpoint
		if (path === "/api/status") {
			const issues = await context.issueStore.list();
			const openIssues = issues.filter(i => i.status === "open");
			const readyIssues = await context.issueStore.ready();
			
			return Response.json({
				repo_root: context.repoRoot,
				open_count: openIssues.length,
				ready_count: readyIssues.length
			}, { headers });
		}
		
		// Issue routes
		if (path.startsWith("/api/issues")) {
			const response = await issueRoutes(request, context);
			// Add CORS headers to the response
			headers.forEach((value, key) => response.headers.set(key, value));
			return response;
		}
		
		// Forum routes
		if (path.startsWith("/api/forum")) {
			const response = await forumRoutes(request, context);
			// Add CORS headers to the response
			headers.forEach((value, key) => response.headers.set(key, value));
			return response;
		}
		
		return new Response("Not Found", { status: 404, headers });
	};
	
	const server = {
		port: options.port || 3000,
		fetch: handleRequest,
		hostname: "0.0.0.0",
	};
	
	return server;
}