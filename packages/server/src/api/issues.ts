import {
	DEFAULT_ISSUE_QUERY_LIMIT,
	ISSUE_STATUS_VALUES,
	IssueStoreNotFoundError,
	IssueStoreValidationError,
	normalizeIssueContainsFilter,
	normalizeIssueQueryLimit,
} from "@femtomc/mu-issue";
import type { ServerContext } from "../server.js";

const ISSUE_STATUS_SET = new Set(ISSUE_STATUS_VALUES);

function normalizeIssueId(value: string): string {
	try {
		return decodeURIComponent(value).trim();
	} catch (cause) {
		throw new IssueStoreValidationError("invalid issue id encoding", { cause });
	}
}

function normalizeIssueStatusFilter(value: string | null): (typeof ISSUE_STATUS_VALUES)[number] | undefined {
	if (value == null) {
		return undefined;
	}
	const normalized = value.trim();
	if (normalized.length === 0) {
		return undefined;
	}
	if (!ISSUE_STATUS_SET.has(normalized as (typeof ISSUE_STATUS_VALUES)[number])) {
		throw new IssueStoreValidationError(`invalid issue status filter: ${normalized}`);
	}
	return normalized as (typeof ISSUE_STATUS_VALUES)[number];
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new IssueStoreValidationError("invalid json body");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new IssueStoreValidationError("json body must be an object");
	}
	return body as Record<string, unknown>;
}

function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mapIssueRouteError(error: unknown): Response {
	if (error instanceof IssueStoreNotFoundError) {
		return errorResponse(404, error.message);
	}
	if (error instanceof IssueStoreValidationError) {
		return errorResponse(400, error.message);
	}
	if (error instanceof Error && error.name === "ZodError") {
		return errorResponse(400, error.message);
	}
	console.error("Issue API error:", error);
	return errorResponse(500, error instanceof Error ? error.message : "Internal server error");
}

export async function issueRoutes(request: Request, context: ServerContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace("/api/issues", "") || "/";
	const method = request.method;

	try {
		// List issues - GET /api/issues
		if (path === "/" && method === "GET") {
			const status = normalizeIssueStatusFilter(url.searchParams.get("status"));
			const tag = url.searchParams.get("tag")?.trim() || undefined;
			const contains = normalizeIssueContainsFilter(url.searchParams.get("contains"));
			const limit = normalizeIssueQueryLimit(url.searchParams.get("limit"), {
				defaultLimit: DEFAULT_ISSUE_QUERY_LIMIT,
			});
			const issues = await context.issueStore.list({ status, tag, contains, limit: limit ?? undefined });
			return Response.json(issues);
		}

		// Get ready issues - GET /api/issues/ready
		if (path === "/ready" && method === "GET") {
			const root = url.searchParams.get("root")?.trim() || undefined;
			const contains = normalizeIssueContainsFilter(url.searchParams.get("contains"));
			const limit = normalizeIssueQueryLimit(url.searchParams.get("limit"), {
				defaultLimit: DEFAULT_ISSUE_QUERY_LIMIT,
			});
			const issues = await context.issueStore.ready(root, { contains, limit: limit ?? undefined });
			return Response.json(issues);
		}

		// Get single issue - GET /api/issues/:id
		if (path.startsWith("/") && method === "GET") {
			const id = normalizeIssueId(path.slice(1));
			if (id.length === 0) {
				return errorResponse(400, "issue id is required");
			}
			const issue = await context.issueStore.get(id);
			if (!issue) {
				return errorResponse(404, "issue not found");
			}
			return Response.json(issue);
		}

		// Create issue - POST /api/issues
		if (path === "/" && method === "POST") {
			const body = await readJsonBody(request);
			const title = typeof body.title === "string" ? body.title.trim() : "";
			if (!title) {
				return errorResponse(400, "title is required");
			}

			const issueBody =
				body.body == null ? undefined : typeof body.body === "string" ? body.body : undefined;
			if (body.body != null && issueBody == null) {
				return errorResponse(400, "body must be a string when provided");
			}

			let tags: string[] | undefined;
			if (body.tags != null) {
				if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string")) {
					return errorResponse(400, "tags must be a string[] when provided");
				}
				tags = body.tags.map((tag) => tag.trim());
			}

			let priority: number | undefined;
			if (body.priority != null) {
				if (typeof body.priority !== "number" || !Number.isFinite(body.priority) || !Number.isInteger(body.priority)) {
					return errorResponse(400, "priority must be an integer when provided");
				}
				priority = body.priority;
			}

			const issue = await context.issueStore.create(title, {
				body: issueBody,
				tags,
				priority,
			});

			return Response.json(issue, { status: 201 });
		}

		// Update issue - PATCH /api/issues/:id
		if (path.startsWith("/") && method === "PATCH") {
			const id = normalizeIssueId(path.slice(1));
			if (id.length === 0) {
				return errorResponse(400, "issue id is required");
			}
			const body = await readJsonBody(request);
			const issue = await context.issueStore.update(id, body);
			return Response.json(issue);
		}

		// Close issue - POST /api/issues/:id/close
		if (path.endsWith("/close") && method === "POST") {
			const id = normalizeIssueId(path.slice(1, -"/close".length));
			if (id.length === 0) {
				return errorResponse(400, "issue id is required");
			}
			const body = await readJsonBody(request);
			const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
			if (!outcome) {
				return errorResponse(400, "outcome is required");
			}

			const issue = await context.issueStore.close(id, outcome);
			return Response.json(issue);
		}

		// Claim issue - POST /api/issues/:id/claim
		if (path.endsWith("/claim") && method === "POST") {
			const id = normalizeIssueId(path.slice(1, -"/claim".length));
			if (id.length === 0) {
				return errorResponse(400, "issue id is required");
			}

			const success = await context.issueStore.claim(id);
			if (!success) {
				return errorResponse(409, "failed to claim issue");
			}

			const issue = await context.issueStore.get(id);
			if (!issue) {
				return errorResponse(404, "issue not found");
			}
			return Response.json(issue);
		}

		return new Response("Not Found", { status: 404 });
	} catch (error) {
		return mapIssueRouteError(error);
	}
}
