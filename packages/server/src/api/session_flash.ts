import { appendJsonl, readJsonl } from "@femtomc/mu-core/node";
import { join } from "node:path";
import type { ServerRoutingDependencies } from "../server_routing.js";

type SessionFlashCreateRow = {
	kind: "session_flash.create";
	ts_ms: number;
	flash_id: string;
	session_id: string;
	session_kind: string | null;
	body: string;
	context_ids: string[];
	source: string | null;
	metadata: Record<string, unknown>;
	from: {
		channel: string | null;
		channel_tenant_id: string | null;
		channel_conversation_id: string | null;
		actor_binding_id: string | null;
	};
};

type SessionFlashDeliveryRow = {
	kind: "session_flash.delivery";
	ts_ms: number;
	flash_id: string;
	session_id: string;
	delivered_by: string;
	note: string | null;
};

export type SessionFlashStatus = "pending" | "delivered";

export type SessionFlashRecord = {
	flash_id: string;
	created_at_ms: number;
	session_id: string;
	session_kind: string | null;
	body: string;
	context_ids: string[];
	source: string | null;
	metadata: Record<string, unknown>;
	from: {
		channel: string | null;
		channel_tenant_id: string | null;
		channel_conversation_id: string | null;
		actor_binding_id: string | null;
	};
	status: SessionFlashStatus;
	delivered_at_ms: number | null;
	delivered_by: string | null;
	delivery_note: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function finiteInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return Math.trunc(value);
}

function parseStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		const out: string[] = [];
		for (const item of value) {
			const parsed = nonEmptyString(item);
			if (parsed) {
				out.push(parsed);
			}
		}
		return out;
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
	}
	return [];
}

function parseLimit(value: string | null, fallback: number, max: number): number {
	if (value == null) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function sessionFlashPath(repoRoot: string): string {
	return join(repoRoot, ".mu", "control-plane", "session_flash.jsonl");
}

export function getSessionFlashPath(repoRoot: string): string {
	return sessionFlashPath(repoRoot);
}

function normalizeCreateRow(row: SessionFlashCreateRow): SessionFlashRecord {
	return {
		flash_id: row.flash_id,
		created_at_ms: row.ts_ms,
		session_id: row.session_id,
		session_kind: row.session_kind,
		body: row.body,
		context_ids: row.context_ids,
		source: row.source,
		metadata: row.metadata,
		from: row.from,
		status: "pending",
		delivered_at_ms: null,
		delivered_by: null,
		delivery_note: null,
	};
}

async function loadSessionFlashState(repoRoot: string): Promise<Map<string, SessionFlashRecord>> {
	const rows = await readJsonl(sessionFlashPath(repoRoot));
	const state = new Map<string, SessionFlashRecord>();

	for (const row of rows) {
		const rec = asRecord(row);
		if (!rec) {
			continue;
		}
		const kind = nonEmptyString(rec.kind);
		if (kind === "session_flash.create") {
			const flashId = nonEmptyString(rec.flash_id);
			const tsMs = finiteInt(rec.ts_ms);
			const sessionId = nonEmptyString(rec.session_id);
			const body = nonEmptyString(rec.body);
			if (!flashId || tsMs == null || !sessionId || !body) {
				continue;
			}
			const from = asRecord(rec.from);
			const createRow: SessionFlashCreateRow = {
				kind: "session_flash.create",
				ts_ms: tsMs,
				flash_id: flashId,
				session_id: sessionId,
				session_kind: nonEmptyString(rec.session_kind),
				body,
				context_ids: parseStringList(rec.context_ids),
				source: nonEmptyString(rec.source),
				metadata: asRecord(rec.metadata) ?? {},
				from: {
					channel: nonEmptyString(from?.channel),
					channel_tenant_id: nonEmptyString(from?.channel_tenant_id),
					channel_conversation_id: nonEmptyString(from?.channel_conversation_id),
					actor_binding_id: nonEmptyString(from?.actor_binding_id),
				},
			};
			state.set(flashId, normalizeCreateRow(createRow));
			continue;
		}

		if (kind === "session_flash.delivery") {
			const flashId = nonEmptyString(rec.flash_id);
			const sessionId = nonEmptyString(rec.session_id);
			const tsMs = finiteInt(rec.ts_ms);
			if (!flashId || !sessionId || tsMs == null) {
				continue;
			}
			const current = state.get(flashId);
			if (!current) {
				continue;
			}
			if (current.session_id !== sessionId) {
				continue;
			}
			state.set(flashId, {
				...current,
				status: "delivered",
				delivered_at_ms: tsMs,
				delivered_by: nonEmptyString(rec.delivered_by),
				delivery_note: nonEmptyString(rec.note),
			});
		}
	}

	return state;
}

export async function listSessionFlashRecords(opts: {
	repoRoot: string;
	sessionId?: string | null;
	sessionKind?: string | null;
	status?: SessionFlashStatus | "all";
	contains?: string | null;
	limit?: number;
}): Promise<SessionFlashRecord[]> {
	const state = await loadSessionFlashState(opts.repoRoot);
	const status = opts.status ?? "all";
	const contains = nonEmptyString(opts.contains)?.toLowerCase() ?? null;
	const out = [...state.values()].filter((record) => {
		if (opts.sessionId && record.session_id !== opts.sessionId) {
			return false;
		}
		if (opts.sessionKind && record.session_kind !== opts.sessionKind) {
			return false;
		}
		if (status !== "all" && record.status !== status) {
			return false;
		}
		if (contains) {
			const haystack = [record.body, record.flash_id, record.session_id, record.context_ids.join(" ")]
				.join("\n")
				.toLowerCase();
			if (!haystack.includes(contains)) {
				return false;
			}
		}
		return true;
	});

	out.sort((a, b) => {
		if (a.created_at_ms !== b.created_at_ms) {
			return b.created_at_ms - a.created_at_ms;
		}
		return a.flash_id.localeCompare(b.flash_id);
	});

	const limit = Math.max(1, Math.trunc(opts.limit ?? 50));
	return out.slice(0, limit);
}

export async function getSessionFlashRecord(opts: {
	repoRoot: string;
	flashId: string;
}): Promise<SessionFlashRecord | null> {
	const state = await loadSessionFlashState(opts.repoRoot);
	return state.get(opts.flashId) ?? null;
}

export async function createSessionFlashRecord(opts: {
	repoRoot: string;
	sessionId: string;
	body: string;
	sessionKind?: string | null;
	contextIds?: string[];
	source?: string | null;
	metadata?: Record<string, unknown>;
	from?: {
		channel?: string | null;
		channel_tenant_id?: string | null;
		channel_conversation_id?: string | null;
		actor_binding_id?: string | null;
	};
	nowMs?: number;
}): Promise<SessionFlashRecord> {
	const nowMs = Math.trunc(opts.nowMs ?? Date.now());
	const flashId = `flash-${crypto.randomUUID()}`;
	const row: SessionFlashCreateRow = {
		kind: "session_flash.create",
		ts_ms: nowMs,
		flash_id: flashId,
		session_id: opts.sessionId,
		session_kind: opts.sessionKind ?? null,
		body: opts.body,
		context_ids: opts.contextIds ?? [],
		source: opts.source ?? null,
		metadata: opts.metadata ?? {},
		from: {
			channel: opts.from?.channel ?? null,
			channel_tenant_id: opts.from?.channel_tenant_id ?? null,
			channel_conversation_id: opts.from?.channel_conversation_id ?? null,
			actor_binding_id: opts.from?.actor_binding_id ?? null,
		},
	};
	await appendJsonl(sessionFlashPath(opts.repoRoot), row);
	return normalizeCreateRow(row);
}

export async function ackSessionFlashRecord(opts: {
	repoRoot: string;
	flashId: string;
	sessionId?: string | null;
	deliveredBy?: string | null;
	note?: string | null;
	nowMs?: number;
}): Promise<SessionFlashRecord | null> {
	const current = await getSessionFlashRecord({ repoRoot: opts.repoRoot, flashId: opts.flashId });
	if (!current) {
		return null;
	}
	const sessionId = opts.sessionId ?? current.session_id;
	const row: SessionFlashDeliveryRow = {
		kind: "session_flash.delivery",
		ts_ms: Math.trunc(opts.nowMs ?? Date.now()),
		flash_id: current.flash_id,
		session_id: sessionId,
		delivered_by: nonEmptyString(opts.deliveredBy) ?? "api_ack",
		note: nonEmptyString(opts.note),
	};
	await appendJsonl(sessionFlashPath(opts.repoRoot), row);
	return {
		...current,
		status: "delivered",
		delivered_at_ms: row.ts_ms,
		delivered_by: row.delivered_by,
		delivery_note: row.note,
	};
}

export async function sessionFlashRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	const path = url.pathname;

	if (path === "/api/session-flash") {
		if (request.method === "GET") {
			const statusRaw = nonEmptyString(url.searchParams.get("status"))?.toLowerCase();
			const status: SessionFlashStatus | "all" =
				statusRaw === "pending" || statusRaw === "delivered" ? statusRaw : "all";
			const flashes = await listSessionFlashRecords({
				repoRoot: deps.context.repoRoot,
				sessionId: nonEmptyString(url.searchParams.get("session_id")),
				sessionKind: nonEmptyString(url.searchParams.get("session_kind")),
				status,
				contains: nonEmptyString(url.searchParams.get("contains")),
				limit: parseLimit(url.searchParams.get("limit"), 50, 500),
			});
			return Response.json(
				{
					ok: true,
					count: flashes.length,
					status,
					flashes,
				},
				{ headers },
			);
		}

		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}

		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const sessionId = nonEmptyString(body.session_id);
		const messageBody = nonEmptyString(body.body);
		if (!sessionId) {
			return Response.json({ error: "session_id is required" }, { status: 400, headers });
		}
		if (!messageBody) {
			return Response.json({ error: "body is required" }, { status: 400, headers });
		}
		if (body.metadata != null && !asRecord(body.metadata)) {
			return Response.json({ error: "metadata must be an object" }, { status: 400, headers });
		}

		const from = asRecord(body.from);
		const flash = await createSessionFlashRecord({
			repoRoot: deps.context.repoRoot,
			sessionId,
			body: messageBody,
			sessionKind: nonEmptyString(body.session_kind),
			contextIds: parseStringList(body.context_ids),
			source: nonEmptyString(body.source),
			metadata: asRecord(body.metadata) ?? {},
			from: {
				channel: nonEmptyString(from?.channel),
				channel_tenant_id: nonEmptyString(from?.channel_tenant_id),
				channel_conversation_id: nonEmptyString(from?.channel_conversation_id),
				actor_binding_id: nonEmptyString(from?.actor_binding_id),
			},
		});
		return Response.json({ ok: true, flash }, { status: 201, headers });
	}

	if (path === "/api/session-flash/ack") {
		if (request.method !== "POST") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return Response.json({ error: "invalid json body" }, { status: 400, headers });
		}
		const flashId = nonEmptyString(body.flash_id);
		if (!flashId) {
			return Response.json({ error: "flash_id is required" }, { status: 400, headers });
		}
		const flash = await ackSessionFlashRecord({
			repoRoot: deps.context.repoRoot,
			flashId,
			sessionId: nonEmptyString(body.session_id),
			deliveredBy: nonEmptyString(body.delivered_by),
			note: nonEmptyString(body.note),
		});
		if (!flash) {
			return Response.json({ error: "flash not found" }, { status: 404, headers });
		}
		return Response.json({ ok: true, flash }, { headers });
	}

	if (path.startsWith("/api/session-flash/")) {
		if (request.method !== "GET") {
			return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
		}
		const rawId = path.slice("/api/session-flash/".length);
		const flashId = nonEmptyString(decodeURIComponent(rawId));
		if (!flashId) {
			return Response.json({ error: "flash id is required" }, { status: 400, headers });
		}
		const flash = await getSessionFlashRecord({
			repoRoot: deps.context.repoRoot,
			flashId,
		});
		if (!flash) {
			return Response.json({ error: "flash not found" }, { status: 404, headers });
		}
		return Response.json({ ok: true, flash }, { headers });
	}

	return Response.json({ error: "Not Found" }, { status: 404, headers });
}
