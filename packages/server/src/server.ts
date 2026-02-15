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
		
		// Health check
		if (path === "/healthz" || path === "/health") {
			return new Response("ok", { status: 200 });
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
			});
		}
		
		// Issue routes
		if (path.startsWith("/api/issues")) {
			return issueRoutes(request, context);
		}
		
		// Forum routes
		if (path.startsWith("/api/forum")) {
			return forumRoutes(request, context);
		}
		
		return new Response("Not Found", { status: 404 });
	};
	
	const server = {
		port: options.port || 3000,
		fetch: handleRequest,
		hostname: "0.0.0.0",
	};
	
	return server;
}