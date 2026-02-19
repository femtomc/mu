import {
	createMuSession,
	type CreateMuSessionOpts,
	DEFAULT_OPERATOR_SYSTEM_PROMPT,
	DEFAULT_ORCHESTRATOR_PROMPT,
	DEFAULT_REVIEWER_PROMPT,
	DEFAULT_WORKER_PROMPT,
	operatorExtensionPaths,
	orchestratorToolExtensionPaths,
	workerToolExtensionPaths,
	type MuSession,
} from "@femtomc/mu-agent";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ServerRoutingDependencies } from "../server_routing.js";

export type SessionTurnRequest = {
	session_id: string;
	session_kind: string | null;
	body: string;
	source: string | null;
	provider: string | null;
	model: string | null;
	thinking: string | null;
	session_file: string | null;
	session_dir: string | null;
	extension_profile: string | null;
};

export type SessionTurnResult = {
	session_id: string;
	session_kind: string | null;
	session_file: string;
	context_entry_id: string | null;
	reply: string;
	source: string | null;
	completed_at_ms: number;
};

export class SessionTurnError extends Error {
	readonly status: number;

	public constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function normalizeSessionKind(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase().replaceAll("-", "_");
	if (normalized === "cpoperator" || normalized === "control_plane_operator") {
		return "cp_operator";
	}
	return normalized;
}

function normalizeExtensionProfile(
	value: string | null,
): "operator" | "worker" | "orchestrator" | "reviewer" | "none" | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "operator" ||
		normalized === "worker" ||
		normalized === "orchestrator" ||
		normalized === "reviewer" ||
		normalized === "none"
	) {
		return normalized;
	}
	return null;
}

function sessionFileStem(sessionId: string): string {
	const normalized = sessionId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
	const compact = normalized.replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
	return compact.length > 0 ? compact : "session";
}

function resolveRepoPath(repoRoot: string, candidate: string): string {
	return isAbsolute(candidate) ? resolve(candidate) : resolve(repoRoot, candidate);
}

function defaultSessionDirForKind(repoRoot: string, sessionKind: string | null): string {
	switch (sessionKind) {
		case "operator":
			return join(repoRoot, ".mu", "operator", "sessions");
		case "cp_operator":
			return join(repoRoot, ".mu", "control-plane", "operator-sessions");
		case "orchestrator":
			return join(repoRoot, ".mu", "orchestrator", "sessions");
		case "worker":
			return join(repoRoot, ".mu", "worker", "sessions");
		case "reviewer":
			return join(repoRoot, ".mu", "reviewer", "sessions");
		default:
			return join(repoRoot, ".mu", "control-plane", "operator-sessions");
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

async function readSessionHeaderId(sessionFile: string): Promise<string | null> {
	let raw: string;
	try {
		raw = await readFile(sessionFile, "utf8");
	} catch {
		return null;
	}
	const firstLine = raw
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) {
		return null;
	}
	try {
		const parsed = JSON.parse(firstLine) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const header = parsed as Record<string, unknown>;
		if (header.type !== "session") {
			return null;
		}
		return nonEmptyString(header.id);
	} catch {
		return null;
	}
}

async function resolveSessionFileById(opts: { sessionDir: string; sessionId: string }): Promise<string | null> {
	const direct = join(opts.sessionDir, `${sessionFileStem(opts.sessionId)}.jsonl`);
	if (await pathExists(direct)) {
		const headerId = await readSessionHeaderId(direct);
		if (headerId === opts.sessionId) {
			return direct;
		}
	}

	const entries = await readdir(opts.sessionDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
			continue;
		}
		const filePath = join(opts.sessionDir, entry.name);
		if (filePath === direct) {
			continue;
		}
		const headerId = await readSessionHeaderId(filePath);
		if (headerId === opts.sessionId) {
			return filePath;
		}
	}
	return null;
}

function extensionPathsForTurn(opts: {
	sessionKind: string | null;
	extensionProfile: "operator" | "worker" | "orchestrator" | "reviewer" | "none" | null;
}): string[] {
	if (opts.extensionProfile === "none") {
		return [];
	}
	if (opts.extensionProfile === "operator") {
		return [...operatorExtensionPaths];
	}
	if (opts.extensionProfile === "orchestrator") {
		return [...orchestratorToolExtensionPaths];
	}
	if (opts.extensionProfile === "worker" || opts.extensionProfile === "reviewer") {
		return [...workerToolExtensionPaths];
	}
	if (opts.sessionKind === "operator" || opts.sessionKind === "cp_operator") {
		return [...operatorExtensionPaths];
	}
	if (opts.sessionKind === "orchestrator") {
		return [...orchestratorToolExtensionPaths];
	}
	if (opts.sessionKind === "worker" || opts.sessionKind === "reviewer") {
		return [...workerToolExtensionPaths];
	}
	return [...operatorExtensionPaths];
}

function systemPromptForTurn(opts: {
	sessionKind: string | null;
	extensionProfile: "operator" | "worker" | "orchestrator" | "reviewer" | "none" | null;
}): string | undefined {
	const role = opts.extensionProfile ?? opts.sessionKind;
	if (role === "operator" || role === "cp_operator") {
		return DEFAULT_OPERATOR_SYSTEM_PROMPT;
	}
	if (role === "orchestrator") {
		return DEFAULT_ORCHESTRATOR_PROMPT;
	}
	if (role === "reviewer") {
		return DEFAULT_REVIEWER_PROMPT;
	}
	if (role === "worker") {
		return DEFAULT_WORKER_PROMPT;
	}
	return undefined;
}

function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}
	const record = message as Record<string, unknown>;
	if (typeof record.text === "string") {
		return record.text;
	}
	if (typeof record.content === "string") {
		return record.content;
	}
	if (Array.isArray(record.content)) {
		const parts: string[] = [];
		for (const item of record.content) {
			if (typeof item === "string") {
				if (item.trim().length > 0) {
					parts.push(item);
				}
				continue;
			}
			if (!item || typeof item !== "object") {
				continue;
			}
			const text = nonEmptyString((item as Record<string, unknown>).text);
			if (text) {
				parts.push(text);
			}
		}
		return parts.join("\n");
	}
	return "";
}

function safeLeafId(session: MuSession): string | null {
	const manager = (session as MuSession & { sessionManager?: { getLeafId?: () => string | null } }).sessionManager;
	if (!manager || typeof manager.getLeafId !== "function") {
		return null;
	}
	const value = manager.getLeafId();
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function safeSessionId(session: MuSession): string | null {
	const value = (session as MuSession & { sessionId?: string }).sessionId;
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function safeSessionFile(session: MuSession): string | null {
	const value = (session as MuSession & { sessionFile?: string }).sessionFile;
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function resolveSessionTarget(opts: {
	repoRoot: string;
	request: SessionTurnRequest;
	normalizedSessionKind: string | null;
}): Promise<{ sessionFile: string; sessionDir: string }> {
	const sessionDir = opts.request.session_dir
		? resolveRepoPath(opts.repoRoot, opts.request.session_dir)
		: defaultSessionDirForKind(opts.repoRoot, opts.normalizedSessionKind);

	if (opts.request.session_file) {
		const sessionFile = resolveRepoPath(opts.repoRoot, opts.request.session_file);
		if (!(await pathExists(sessionFile))) {
			throw new SessionTurnError(404, `session_file not found: ${sessionFile}`);
		}
		const headerId = await readSessionHeaderId(sessionFile);
		if (!headerId) {
			throw new SessionTurnError(400, `session_file is missing a valid session header: ${sessionFile}`);
		}
		if (headerId !== opts.request.session_id) {
			throw new SessionTurnError(
				409,
				`session_file header id mismatch (expected ${opts.request.session_id}, found ${headerId})`,
			);
		}
		return {
			sessionFile,
			sessionDir: opts.request.session_dir ? sessionDir : dirname(sessionFile),
		};
	}

	if (!(await directoryExists(sessionDir))) {
		throw new SessionTurnError(404, `session directory not found: ${sessionDir}`);
	}

	const sessionFile = await resolveSessionFileById({
		sessionDir,
		sessionId: opts.request.session_id,
	});
	if (!sessionFile) {
		throw new SessionTurnError(404, `session_id not found in ${sessionDir}: ${opts.request.session_id}`);
	}
	return { sessionFile, sessionDir };
}

export function parseSessionTurnRequest(body: Record<string, unknown>): {
	request: SessionTurnRequest | null;
	error: string | null;
} {
	const sessionId = nonEmptyString(body.session_id);
	if (!sessionId) {
		return { request: null, error: "session_id is required" };
	}
	const messageBody = nonEmptyString(body.body) ?? nonEmptyString(body.message) ?? nonEmptyString(body.prompt);
	if (!messageBody) {
		return { request: null, error: "body (or message/prompt) is required" };
	}
	const extensionProfileRaw = nonEmptyString(body.extension_profile);
	if (extensionProfileRaw && !normalizeExtensionProfile(extensionProfileRaw)) {
		return {
			request: null,
			error: "extension_profile must be one of operator|worker|orchestrator|reviewer|none",
		};
	}
	return {
		request: {
			session_id: sessionId,
			session_kind: nonEmptyString(body.session_kind),
			body: messageBody,
			source: nonEmptyString(body.source),
			provider: nonEmptyString(body.provider),
			model: nonEmptyString(body.model),
			thinking: nonEmptyString(body.thinking),
			session_file: nonEmptyString(body.session_file),
			session_dir: nonEmptyString(body.session_dir),
			extension_profile: extensionProfileRaw,
		},
		error: null,
	};
}

export async function executeSessionTurn(opts: {
	repoRoot: string;
	request: SessionTurnRequest;
	sessionFactory?: (opts: CreateMuSessionOpts) => Promise<MuSession>;
	nowMs?: () => number;
}): Promise<SessionTurnResult> {
	const normalizedSessionKind = normalizeSessionKind(opts.request.session_kind);
	const extensionProfile = normalizeExtensionProfile(opts.request.extension_profile);
	const target = await resolveSessionTarget({
		repoRoot: opts.repoRoot,
		request: opts.request,
		normalizedSessionKind,
	});

	const sessionFactory = opts.sessionFactory ?? createMuSession;
	const session = await sessionFactory({
		cwd: opts.repoRoot,
		systemPrompt: systemPromptForTurn({
			sessionKind: normalizedSessionKind,
			extensionProfile,
		}),
		provider: opts.request.provider ?? undefined,
		model: opts.request.model ?? undefined,
		thinking: opts.request.thinking ?? undefined,
		extensionPaths: extensionPathsForTurn({
			sessionKind: normalizedSessionKind,
			extensionProfile,
		}),
		session: {
			mode: "open",
			sessionDir: target.sessionDir,
			sessionFile: target.sessionFile,
		},
	});

	let assistantText = "";
	let contextEntryId: string | null = null;
	let resolvedSessionId: string | null = null;
	let resolvedSessionFile: string | null = null;
	const nowMs = opts.nowMs ?? Date.now;

	try {
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
			},
			onError: () => {},
		});

		const unsubscribe = session.subscribe((event: unknown) => {
			const rec = asRecord(event);
			if (!rec || rec.type !== "message_end") {
				return;
			}
			const message = asRecord(rec.message);
			if (!message || message.role !== "assistant") {
				return;
			}
			const text = extractAssistantText(message);
			if (text.trim().length > 0) {
				assistantText = text;
			}
		});
		try {
			await session.prompt(opts.request.body, { expandPromptTemplates: false });
			await session.agent.waitForIdle();
		} finally {
			unsubscribe();
		}

		contextEntryId = safeLeafId(session);
		resolvedSessionId = safeSessionId(session) ?? opts.request.session_id;
		resolvedSessionFile = safeSessionFile(session) ?? target.sessionFile;
	} finally {
		try {
			session.dispose();
		} catch {
			// Best effort cleanup.
		}
	}

	const reply = assistantText.trim();
	if (reply.length === 0) {
		throw new SessionTurnError(502, "session turn completed without an assistant reply");
	}

	return {
		session_id: resolvedSessionId ?? opts.request.session_id,
		session_kind: normalizedSessionKind,
		session_file: resolvedSessionFile ?? target.sessionFile,
		context_entry_id: contextEntryId,
		reply,
		source: opts.request.source ?? null,
		completed_at_ms: Math.trunc(nowMs()),
	};
}

export async function sessionTurnRoutes(
	request: Request,
	url: URL,
	deps: ServerRoutingDependencies,
	headers: Headers,
): Promise<Response> {
	if (url.pathname !== "/api/session-turn") {
		return Response.json({ error: "Not Found" }, { status: 404, headers });
	}
	if (request.method !== "POST") {
		return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
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
