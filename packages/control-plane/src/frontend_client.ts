import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultWebhookRouteForChannel } from "./adapter_contract.js";
import {
	ControlPlaneChannelsResponseSchema,
	frontendChannelCapabilitiesFromResponse,
	frontendSharedSecretHeaderForChannel,
	FrontendIngressRequestSchema,
	FrontendIngressResponseSchema,
	SessionFlashCreateRequestSchema,
	SessionFlashCreateResponseSchema,
	SessionFlashListResponseSchema,
	SessionFlashRecordSchema,
	SessionTurnCreateResponseSchema,
	SessionTurnRequestSchema,
	type ControlPlaneChannelsResponse,
	type FrontendChannel,
	type FrontendChannelCapability,
	type FrontendIngressRequest,
	type FrontendIngressResponse,
	type SessionFlashCreateRequest,
	type SessionFlashRecord,
	type SessionTurnRequest,
	type SessionTurnResult,
} from "./frontend_client_contract.js";

export type MuServerDiscovery = {
	pid: number | null;
	port: number | null;
	url: string;
	started_at_ms: number | null;
};

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

function trimmed(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const next = value.trim();
	return next.length > 0 ? next : null;
}

function asFiniteInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return Math.trunc(value);
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
	} catch {
		body = null;
	}
	if (!response.ok) {
		const message =
			(typeof body === "object" && body && "error" in body && typeof (body as any).error === "string"
				? (body as any).error
				: text) || `HTTP ${response.status}`;
		throw new Error(`mu server request failed (${response.status}): ${message}`);
	}
	return body;
}

export async function readMuServerDiscovery(repoRoot: string): Promise<MuServerDiscovery | null> {
	const path = join(repoRoot, ".mu", "control-plane", "server.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return null;
	}
	if (raw.trim().length === 0) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	const url = trimmed(record.url);
	if (!url) {
		return null;
	}
	return {
		pid: asFiniteInt(record.pid),
		port: asFiniteInt(record.port),
		url,
		started_at_ms: asFiniteInt(record.started_at_ms),
	};
}

export async function resolveFrontendServerUrl(opts: {
	repoRoot: string;
	explicitUrl?: string | null;
}): Promise<string | null> {
	const explicit = trimmed(opts.explicitUrl);
	if (explicit) {
		return normalizeBaseUrl(explicit);
	}
	const discovery = await readMuServerDiscovery(opts.repoRoot);
	if (!discovery) {
		return null;
	}
	return normalizeBaseUrl(discovery.url);
}

export async function fetchControlPlaneChannels(serverUrl: string): Promise<ControlPlaneChannelsResponse> {
	const body = await fetchJson(`${normalizeBaseUrl(serverUrl)}/api/control-plane/channels`);
	return ControlPlaneChannelsResponseSchema.parse(body);
}

export async function fetchFrontendChannels(serverUrl: string): Promise<FrontendChannelCapability[]> {
	const payload = await fetchControlPlaneChannels(serverUrl);
	return frontendChannelCapabilitiesFromResponse(payload);
}

export async function linkFrontendIdentity(opts: {
	serverUrl: string;
	channel: FrontendChannel;
	actorId: string;
	tenantId: string;
	role?: "operator" | "contributor" | "viewer";
	bindingId?: string;
	operatorId?: string;
}): Promise<unknown> {
	const body = await fetchJson(`${normalizeBaseUrl(opts.serverUrl)}/api/identities/link`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			channel: opts.channel,
			actor_id: opts.actorId,
			tenant_id: opts.tenantId,
			role: opts.role ?? "operator",
			binding_id: opts.bindingId,
			operator_id: opts.operatorId,
		}),
	});
	return body;
}

function resolveFrontendRoute(opts: {
	channel: FrontendChannel;
	channels?: readonly FrontendChannelCapability[];
}): string {
	const fromCapabilities = opts.channels?.find((capability) => capability.channel === opts.channel)?.route;
	if (typeof fromCapabilities === "string" && fromCapabilities.trim().length > 0) {
		return fromCapabilities;
	}
	return defaultWebhookRouteForChannel(opts.channel);
}

function resolveFrontendSecretHeader(opts: {
	channel: FrontendChannel;
	channels?: readonly FrontendChannelCapability[];
}): string {
	const fromCapabilities = opts.channels?.find((capability) => capability.channel === opts.channel)?.verification;
	if (
		fromCapabilities &&
		typeof fromCapabilities === "object" &&
		"kind" in fromCapabilities &&
		(fromCapabilities as Record<string, unknown>).kind === "shared_secret_header" &&
		"secret_header" in fromCapabilities &&
		typeof (fromCapabilities as Record<string, unknown>).secret_header === "string"
	) {
		return (fromCapabilities as Record<string, string>).secret_header;
	}
	return frontendSharedSecretHeaderForChannel(opts.channel);
}

export async function submitFrontendIngress(opts: {
	serverUrl: string;
	channel: FrontendChannel;
	sharedSecret: string;
	request: FrontendIngressRequest;
	channels?: readonly FrontendChannelCapability[];
}): Promise<FrontendIngressResponse> {
	const request = FrontendIngressRequestSchema.parse(opts.request);
	const route = resolveFrontendRoute({ channel: opts.channel, channels: opts.channels });
	const secretHeader = resolveFrontendSecretHeader({ channel: opts.channel, channels: opts.channels });
	const body = await fetchJson(`${normalizeBaseUrl(opts.serverUrl)}${route}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[secretHeader]: opts.sharedSecret,
		},
		body: JSON.stringify(request),
	});
	return FrontendIngressResponseSchema.parse(body);
}

export async function bootstrapFrontendChannel(opts: {
	repoRoot: string;
	channel: FrontendChannel;
	sharedSecret: string;
	actorId: string;
	tenantId: string;
	role?: "operator" | "contributor" | "viewer";
	serverUrl?: string | null;
}): Promise<{
	server_url: string;
	channel: FrontendChannelCapability;
	identity_link: unknown;
}> {
	const serverUrl = await resolveFrontendServerUrl({
		repoRoot: opts.repoRoot,
		explicitUrl: opts.serverUrl,
	});
	if (!serverUrl) {
		throw new Error("mu server discovery failed (no explicit serverUrl and no .mu/control-plane/server.json)");
	}
	const channels = await fetchFrontendChannels(serverUrl);
	const channel = channels.find((entry) => entry.channel === opts.channel);
	if (!channel) {
		throw new Error(`frontend channel not advertised by server: ${opts.channel}`);
	}
	const identityLink = await linkFrontendIdentity({
		serverUrl,
		channel: opts.channel,
		actorId: opts.actorId,
		tenantId: opts.tenantId,
		role: opts.role ?? "operator",
	});
	return {
		server_url: serverUrl,
		channel,
		identity_link: identityLink,
	};
}

export async function createSessionFlash(opts: {
	serverUrl: string;
	request: SessionFlashCreateRequest;
}): Promise<SessionFlashRecord> {
	const request = SessionFlashCreateRequestSchema.parse(opts.request);
	const body = await fetchJson(`${normalizeBaseUrl(opts.serverUrl)}/api/session-flash`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
	const parsed = SessionFlashCreateResponseSchema.parse(body);
	return parsed.flash;
}

export async function createSessionTurn(opts: {
	serverUrl: string;
	request: SessionTurnRequest;
}): Promise<SessionTurnResult> {
	const request = SessionTurnRequestSchema.parse(opts.request);
	const body = await fetchJson(`${normalizeBaseUrl(opts.serverUrl)}/api/session-turn`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
	const parsed = SessionTurnCreateResponseSchema.parse(body);
	return parsed.turn;
}

export async function listSessionFlash(opts: {
	serverUrl: string;
	sessionId?: string | null;
	sessionKind?: string | null;
	status?: "pending" | "delivered" | "all";
	contains?: string | null;
	limit?: number;
}): Promise<SessionFlashRecord[]> {
	const search = new URLSearchParams();
	if (trimmed(opts.sessionId)) {
		search.set("session_id", trimmed(opts.sessionId)!);
	}
	if (trimmed(opts.sessionKind)) {
		search.set("session_kind", trimmed(opts.sessionKind)!);
	}
	if (trimmed(opts.status)) {
		search.set("status", trimmed(opts.status)!);
	}
	if (trimmed(opts.contains)) {
		search.set("contains", trimmed(opts.contains)!);
	}
	if (opts.limit != null && Number.isFinite(opts.limit)) {
		search.set("limit", String(Math.max(1, Math.trunc(opts.limit))));
	}
	const suffix = search.size > 0 ? `?${search.toString()}` : "";
	const body = await fetchJson(`${normalizeBaseUrl(opts.serverUrl)}/api/session-flash${suffix}`);
	const parsed = SessionFlashListResponseSchema.parse(body);
	return parsed.flashes;
}

export async function getSessionFlash(opts: { serverUrl: string; flashId: string }): Promise<SessionFlashRecord> {
	const flashId = trimmed(opts.flashId);
	if (!flashId) {
		throw new Error("flashId is required");
	}
	const body = await fetchJson(`${normalizeBaseUrl(opts.serverUrl)}/api/session-flash/${encodeURIComponent(flashId)}`);
	const record = typeof body === "object" && body && "flash" in body ? (body as Record<string, unknown>).flash : body;
	return SessionFlashRecordSchema.parse(record);
}

export async function ackSessionFlash(opts: {
	serverUrl: string;
	flashId: string;
	sessionId?: string | null;
	deliveredBy?: string | null;
	note?: string | null;
}): Promise<SessionFlashRecord> {
	const flashId = trimmed(opts.flashId);
	if (!flashId) {
		throw new Error("flashId is required");
	}
	const body = await fetchJson(`${normalizeBaseUrl(opts.serverUrl)}/api/session-flash/ack`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			flash_id: flashId,
			session_id: trimmed(opts.sessionId),
			delivered_by: trimmed(opts.deliveredBy),
			note: trimmed(opts.note),
		}),
	});
	const record = typeof body === "object" && body && "flash" in body ? (body as Record<string, unknown>).flash : body;
	return SessionFlashRecordSchema.parse(record);
}
