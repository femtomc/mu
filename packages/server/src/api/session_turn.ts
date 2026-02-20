import { executeSessionTurn, parseSessionTurnRequest, SessionTurnError } from "@femtomc/mu-agent";
import { timingSafeEqual } from "node:crypto";
import type { ServerRoutingDependencies } from "../server_routing.js";

const NEOVIM_SHARED_SECRET_HEADER = "x-mu-neovim-secret";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function secureSecretEqual(expected: string, provided: string): boolean {
	const expectedBuf = Buffer.from(expected, "utf8");
	const providedBuf = Buffer.from(provided, "utf8");
	if (expectedBuf.length !== providedBuf.length) {
		return false;
	}
	return timingSafeEqual(expectedBuf, providedBuf);
}

async function verifySessionTurnAuth(request: Request, deps: ServerRoutingDependencies): Promise<
	| { ok: true }
	| { ok: false; status: number; error: string }
> {
	const config = await deps.loadConfigFromDisk();
	const expected = config.control_plane.adapters.neovim.shared_secret?.trim() ?? "";
	if (expected.length === 0) {
		return {
			ok: false,
			status: 503,
			error: "neovim shared secret is not configured",
		};
	}

	const provided = request.headers.get(NEOVIM_SHARED_SECRET_HEADER)?.trim() ?? "";
	if (provided.length === 0) {
		return {
			ok: false,
			status: 401,
			error: `missing ${NEOVIM_SHARED_SECRET_HEADER} header`,
		};
	}
	if (!secureSecretEqual(expected, provided)) {
		return {
			ok: false,
			status: 401,
			error: `invalid ${NEOVIM_SHARED_SECRET_HEADER}`,
		};
	}
	return { ok: true };
}

export async function sessionTurnRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	if (url.pathname !== "/api/control-plane/turn") {
		return Response.json({ error: "Not Found" }, { status: 404, headers });
	}
	if (request.method !== "POST") {
		return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
	}

	const auth = await verifySessionTurnAuth(request, deps);
	if (!auth.ok) {
		return Response.json({ error: auth.error }, { status: auth.status, headers });
	}

	let body: Record<string, unknown>;
	try {
		const parsed = (await request.json()) as unknown;
		const rec = asRecord(parsed);
		if (!rec) {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		body = rec;
	} catch {
		return Response.json({ error: "invalid json body" }, { status: 400, headers });
	}

	const parsedRequest = parseSessionTurnRequest(body);
	if (!parsedRequest.request) {
		return Response.json({ error: parsedRequest.error ?? "invalid session turn request" }, { status: 400, headers });
	}

	try {
		const turn = await executeSessionTurn({
			repoRoot: deps.context.repoRoot,
			request: parsedRequest.request,
		});
		return Response.json({ ok: true, turn }, { headers });
	} catch (error) {
		const status = error instanceof SessionTurnError ? error.status : 500;
		return Response.json({ error: deps.describeError(error) }, { status, headers });
	}
}
