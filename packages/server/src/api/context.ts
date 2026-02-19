import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { getStorePaths } from "@femtomc/mu-core/node";
import { getControlPlanePaths } from "@femtomc/mu-control-plane";
import type { ServerContext } from "../server.js";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 500;
const MAX_TEXT_LENGTH = 8_000;
const PREVIEW_LENGTH = 240;

const CONTEXT_SOURCE_KINDS = [
	"issues",
	"forum",
	"events",
	"cp_commands",
	"cp_outbox",
	"cp_adapter_audit",
	"cp_operator_turns",
	"cp_telegram_ingress",
	"session_flash",
	"operator_sessions",
	"cp_operator_sessions",
] as const;

type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

type ContextItem = {
	id: string;
	ts_ms: number;
	source_kind: ContextSourceKind;
	source_path: string;
	source_line: number;
	repo_root: string;
	text: string;
	preview: string;
	issue_id: string | null;
	run_id: string | null;
	session_id: string | null;
	channel: string | null;
	channel_tenant_id: string | null;
	channel_conversation_id: string | null;
	actor_binding_id: string | null;
	conversation_key: string | null;
	topic: string | null;
	author: string | null;
	role: string | null;
	tags: string[];
	metadata: Record<string, unknown>;
};

type SearchFilters = {
	query: string | null;
	sources: Set<ContextSourceKind> | null;
	limit: number;
	sinceMs: number | null;
	untilMs: number | null;
	issueId: string | null;
	runId: string | null;
	sessionId: string | null;
	conversationKey: string | null;
	channel: string | null;
	channelTenantId: string | null;
	channelConversationId: string | null;
	actorBindingId: string | null;
	topic: string | null;
	author: string | null;
	role: string | null;
};

type TimelineFilters = SearchFilters & {
	order: "asc" | "desc";
};

type JsonlRow = {
	line: number;
	value: unknown;
};

class QueryValidationError extends Error {
	readonly status = 400;

	public constructor(message: string) {
		super(message);
		this.name = "QueryValidationError";
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
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

function asInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return Math.trunc(value);
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return Math.trunc(parsed.getTime());
		}
	}
	if (value instanceof Date) {
		const ms = value.getTime();
		if (!Number.isNaN(ms)) {
			return Math.trunc(ms);
		}
	}
	return null;
}

function toSingleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clampText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	if (maxLength <= 1) {
		return value.slice(0, Math.max(0, maxLength));
	}
	return `${value.slice(0, maxLength - 1)}…`;
}

function buildPreview(text: string): string {
	const normalized = toSingleLine(text);
	if (normalized.length === 0) {
		return "";
	}
	return clampText(normalized, PREVIEW_LENGTH);
}

function textFromUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value == null) {
		return "";
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function buildConversationKey(parts: {
	channel: string | null;
	tenantId: string | null;
	conversationId: string | null;
	bindingId: string | null;
}): string | null {
	if (!parts.channel || !parts.tenantId || !parts.conversationId || !parts.bindingId) {
		return null;
	}
	return `${parts.channel}:${parts.tenantId}:${parts.conversationId}:${parts.bindingId}`;
}

function conversationScopeKey(key: string): string {
	const parts = key.split(":");
	if (parts.length < 3) {
		return key;
	}
	return `${parts[0]}:${parts[1]}:${parts[2]}`;
}

function parseCsv(value: string | null): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function parseLimit(value: string | null): number {
	if (value == null || value.trim().length === 0) {
		return DEFAULT_LIMIT;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		throw new QueryValidationError("invalid limit: expected integer");
	}
	if (parsed < 1) {
		throw new QueryValidationError("invalid limit: must be >= 1");
	}
	return Math.min(parsed, MAX_LIMIT);
}

function parseOptionalTs(value: string | null, name: string): number | null {
	if (value == null || value.trim().length === 0) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		throw new QueryValidationError(`invalid ${name}: expected integer epoch ms`);
	}
	return parsed;
}

function parseSourceFilter(value: string | null): Set<ContextSourceKind> | null {
	const parts = parseCsv(value);
	if (parts.length === 0) {
		return null;
	}
	const out = new Set<ContextSourceKind>();
	for (const part of parts) {
		const normalized = part.trim().toLowerCase();
		if (normalized === "all") {
			for (const source of CONTEXT_SOURCE_KINDS) {
				out.add(source);
			}
			continue;
		}
		if ((CONTEXT_SOURCE_KINDS as readonly string[]).includes(normalized)) {
			out.add(normalized as ContextSourceKind);
			continue;
		}
		throw new QueryValidationError(
			`unknown context source: ${part}. valid sources: ${CONTEXT_SOURCE_KINDS.join(", ")}`,
		);
	}
	return out;
}

function parseSearchFilters(url: URL): SearchFilters {
	const query =
		nonEmptyString(url.searchParams.get("query")) ??
		nonEmptyString(url.searchParams.get("q")) ??
		nonEmptyString(url.searchParams.get("contains"));
	return {
		query,
		sources: parseSourceFilter(url.searchParams.get("sources") ?? url.searchParams.get("source")),
		limit: parseLimit(url.searchParams.get("limit")),
		sinceMs: parseOptionalTs(url.searchParams.get("since"), "since"),
		untilMs: parseOptionalTs(url.searchParams.get("until"), "until"),
		issueId: nonEmptyString(url.searchParams.get("issue_id")),
		runId: nonEmptyString(url.searchParams.get("run_id")),
		sessionId: nonEmptyString(url.searchParams.get("session_id")),
		conversationKey: nonEmptyString(url.searchParams.get("conversation_key")),
		channel: nonEmptyString(url.searchParams.get("channel")),
		channelTenantId: nonEmptyString(url.searchParams.get("channel_tenant_id")),
		channelConversationId: nonEmptyString(url.searchParams.get("channel_conversation_id")),
		actorBindingId: nonEmptyString(url.searchParams.get("actor_binding_id")),
		topic: nonEmptyString(url.searchParams.get("topic")),
		author: nonEmptyString(url.searchParams.get("author")),
		role: nonEmptyString(url.searchParams.get("role")),
	};
}

function parseTimelineFilters(url: URL): TimelineFilters {
	const base = parseSearchFilters(url);
	const orderRaw = nonEmptyString(url.searchParams.get("order"))?.toLowerCase();
	const order = orderRaw === "desc" ? "desc" : "asc";
	if (
		!base.conversationKey &&
		!base.issueId &&
		!base.runId &&
		!base.sessionId &&
		!base.topic &&
		!base.channel
	) {
		throw new QueryValidationError(
			"timeline requires one anchor filter: conversation_key, issue_id, run_id, session_id, topic, or channel",
		);
	}
	return { ...base, order };
}

function matchesConversation(item: ContextItem, requested: string): boolean {
	const requestedTrimmed = requested.trim();
	if (requestedTrimmed.length === 0) {
		return true;
	}
	const direct = item.conversation_key ? [item.conversation_key] : [];
	const metadataKeys = Array.isArray(item.metadata.conversation_keys)
		? item.metadata.conversation_keys.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		: [];
	const allKeys = [...direct, ...metadataKeys];
	if (allKeys.length === 0) {
		return false;
	}
	if (requestedTrimmed.includes("*")) {
		const prefix = requestedTrimmed.replace(/\*/g, "");
		return allKeys.some((key) => key.startsWith(prefix));
	}
	if (allKeys.includes(requestedTrimmed)) {
		return true;
	}
	const requestedScope = conversationScopeKey(requestedTrimmed);
	return allKeys.some((key) => conversationScopeKey(key) === requestedScope);
}

function matchSource(item: ContextItem, sources: Set<ContextSourceKind> | null): boolean {
	if (!sources) {
		return true;
	}
	return sources.has(item.source_kind);
}

function matchSearchFilters(item: ContextItem, filters: SearchFilters): boolean {
	if (!matchSource(item, filters.sources)) {
		return false;
	}
	if (filters.sinceMs != null && item.ts_ms < filters.sinceMs) {
		return false;
	}
	if (filters.untilMs != null && item.ts_ms > filters.untilMs) {
		return false;
	}
	if (filters.issueId && item.issue_id !== filters.issueId) {
		return false;
	}
	if (filters.runId && item.run_id !== filters.runId) {
		return false;
	}
	if (filters.sessionId && item.session_id !== filters.sessionId) {
		return false;
	}
	if (filters.channel && item.channel !== filters.channel) {
		return false;
	}
	if (filters.channelTenantId && item.channel_tenant_id !== filters.channelTenantId) {
		return false;
	}
	if (filters.channelConversationId && item.channel_conversation_id !== filters.channelConversationId) {
		return false;
	}
	if (filters.actorBindingId && item.actor_binding_id !== filters.actorBindingId) {
		return false;
	}
	if (filters.topic && item.topic !== filters.topic) {
		return false;
	}
	if (filters.author && item.author !== filters.author) {
		return false;
	}
	if (filters.role && item.role !== filters.role) {
		return false;
	}
	if (filters.conversationKey && !matchesConversation(item, filters.conversationKey)) {
		return false;
	}
	return true;
}

function tokenizeQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function searchableText(item: ContextItem): string {
	const tags = item.tags.join(" ");
	const fields = [
		item.text,
		item.preview,
		item.source_kind,
		item.issue_id ?? "",
		item.run_id ?? "",
		item.session_id ?? "",
		item.channel ?? "",
		item.topic ?? "",
		item.author ?? "",
		tags,
	];
	return fields.join("\n").toLowerCase();
}

function scoreItem(item: ContextItem, query: string | null): number {
	if (!query) {
		return item.ts_ms;
	}
	const haystack = searchableText(item);
	const needle = query.toLowerCase();
	const tokens = tokenizeQuery(needle);

	let score = 0;
	if (haystack.includes(needle)) {
		score += 100;
	}
	let tokenHits = 0;
	for (const token of tokens) {
		if (haystack.includes(token)) {
			tokenHits += 1;
			score += 20;
		}
	}
	if (tokens.length > 0 && tokenHits === 0) {
		return -1;
	}

	if (item.role === "user") {
		score += 8;
	}
	if (item.role === "assistant") {
		score += 4;
	}
	if (item.source_kind === "cp_operator_sessions" || item.source_kind === "operator_sessions") {
		score += 5;
	}

	const ageMs = Math.max(0, Date.now() - item.ts_ms);
	const recencyBonus = Math.max(0, 24 - Math.trunc(ageMs / (1000 * 60 * 60 * 24)));
	score += recencyBonus;

	return score;
}

function isErrnoCode(err: unknown, code: string): boolean {
	return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === code);
}

async function readJsonlRows(path: string): Promise<JsonlRow[]> {
	const rows: JsonlRow[] = [];
	let stream: ReturnType<typeof createReadStream> | null = null;
	let rl: ReturnType<typeof createInterface> | null = null;
	try {
		stream = createReadStream(path, { encoding: "utf8" });
		rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		let line = 0;
		for await (const raw of rl) {
			line += 1;
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				continue;
			}
			try {
				rows.push({ line, value: JSON.parse(trimmed) as unknown });
			} catch {
				// Keep malformed JSON rows non-fatal for retrieval.
			}
		}
		return rows;
	} catch (err) {
		if (isErrnoCode(err, "ENOENT")) {
			return [];
		}
		throw err;
	} finally {
		rl?.close();
		stream?.close();
	}
}

async function listJsonlFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => join(dir, entry.name))
			.sort((a, b) => a.localeCompare(b));
	} catch (err) {
		if (isErrnoCode(err, "ENOENT")) {
			return [];
		}
		throw err;
	}
}

function extractMessageText(messageRaw: unknown): string {
	if (typeof messageRaw === "string") {
		return messageRaw;
	}
	const message = asRecord(messageRaw);
	if (!message) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		const chunks: string[] = [];
		for (const itemRaw of message.content) {
			const item = asRecord(itemRaw);
			if (!item) {
				continue;
			}
			const text = nonEmptyString(item.text);
			if (text) {
				chunks.push(text);
			}
		}
		if (chunks.length > 0) {
			return chunks.join("\n");
		}
	}
	const text = nonEmptyString(message.text);
	if (text) {
		return text;
	}
	return "";
}

async function loadConversationBindings(path: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let raw = "";
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if (isErrnoCode(err, "ENOENT")) {
			return out;
		}
		throw err;
	}
	const parsed = asRecord(JSON.parse(raw));
	const bindings = parsed ? asRecord(parsed.bindings) : null;
	if (!bindings) {
		return out;
	}
	for (const [conversationKey, sessionIdRaw] of Object.entries(bindings)) {
		const sessionId = nonEmptyString(sessionIdRaw);
		if (conversationKey.trim().length === 0 || !sessionId) {
			continue;
		}
		out.set(conversationKey, sessionId);
	}
	return out;
}

function reverseConversationBindings(bindings: Map<string, string>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [conversationKey, sessionId] of bindings.entries()) {
		const rows = out.get(sessionId) ?? [];
		rows.push(conversationKey);
		out.set(sessionId, rows);
	}
	for (const values of out.values()) {
		values.sort((a, b) => a.localeCompare(b));
	}
	return out;
}

function normalizeRelative(repoRoot: string, path: string): string {
	return relative(repoRoot, path).replaceAll("\\", "/");
}

function pushItem(
	out: ContextItem[],
	item: Omit<ContextItem, "preview" | "text"> & { text: string },
): void {
	const trimmed = item.text.trim();
	if (trimmed.length === 0) {
		return;
	}
	const text = clampText(trimmed, MAX_TEXT_LENGTH);
	out.push({
		...item,
		text,
		preview: buildPreview(text),
	});
}

async function collectIssues(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec) {
			continue;
		}
		const issueId = nonEmptyString(rec.id);
		const title = nonEmptyString(rec.title) ?? "";
		const body = nonEmptyString(rec.body) ?? "";
		const status = nonEmptyString(rec.status) ?? "unknown";
		const tags = Array.isArray(rec.tags)
			? rec.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
			: [];
		if (!issueId) {
			continue;
		}
		pushItem(out, {
			id: `issues:${issueId}:${row.line}`,
			ts_ms: asInt(rec.updated_at) ?? asInt(rec.created_at) ?? 0,
			source_kind: "issues",
			source_path: normalizeRelative(repoRoot, path),
			source_line: row.line,
			repo_root: repoRoot,
			issue_id: issueId,
			run_id: null,
			session_id: null,
			channel: null,
			channel_tenant_id: null,
			channel_conversation_id: null,
			actor_binding_id: null,
			conversation_key: null,
			topic: null,
			author: null,
			role: null,
			tags: ["issue", status, ...tags],
			metadata: {
				status,
				priority: asInt(rec.priority),
				outcome: rec.outcome ?? null,
			},
			text: [title, body, tags.join(" ")].filter((part) => part.length > 0).join("\n"),
		});
	}
	return out;
}

async function collectForum(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec) {
			continue;
		}
		const topic = nonEmptyString(rec.topic);
		const body = nonEmptyString(rec.body) ?? "";
		const author = nonEmptyString(rec.author);
		if (!topic) {
			continue;
		}
		pushItem(out, {
			id: `forum:${topic}:${row.line}`,
			ts_ms: asInt(rec.created_at) ?? 0,
			source_kind: "forum",
			source_path: normalizeRelative(repoRoot, path),
			source_line: row.line,
			repo_root: repoRoot,
			issue_id: topic.startsWith("issue:") ? topic.slice("issue:".length) : null,
			run_id: null,
			session_id: null,
			channel: null,
			channel_tenant_id: null,
			channel_conversation_id: null,
			actor_binding_id: null,
			conversation_key: null,
			topic,
			author,
			role: null,
			tags: ["forum", topic],
			metadata: {},
			text: [topic, author ?? "", body].filter((part) => part.length > 0).join("\n"),
		});
	}
	return out;
}

async function collectEvents(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec) {
			continue;
		}
		const type = nonEmptyString(rec.type) ?? "event";
		const source = nonEmptyString(rec.source) ?? "unknown";
		const payload = rec.payload ?? null;
		const payloadText = textFromUnknown(payload);
		const issueId = nonEmptyString(rec.issue_id);
		const runId = nonEmptyString(rec.run_id);
		pushItem(out, {
			id: `events:${type}:${row.line}`,
			ts_ms: asInt(rec.ts_ms) ?? 0,
			source_kind: "events",
			source_path: normalizeRelative(repoRoot, path),
			source_line: row.line,
			repo_root: repoRoot,
			issue_id: issueId,
			run_id: runId,
			session_id: null,
			channel: null,
			channel_tenant_id: null,
			channel_conversation_id: null,
			actor_binding_id: null,
			conversation_key: null,
			topic: null,
			author: null,
			role: null,
			tags: ["event", type, source],
			metadata: {
				type,
				source,
			},
			text: [type, source, issueId ?? "", runId ?? "", payloadText]
				.filter((part) => part.length > 0)
				.join("\n"),
		});
	}
	return out;
}

async function collectCommandJournal(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec) {
			continue;
		}
		const kind = nonEmptyString(rec.kind) ?? "unknown";
		if (kind === "command.lifecycle") {
			const command = asRecord(rec.command);
			const commandId = command ? nonEmptyString(command.command_id) : null;
			const commandText = command ? nonEmptyString(command.command_text) : null;
			const state = command ? nonEmptyString(command.state) : null;
			const targetType = command ? nonEmptyString(command.target_type) : null;
			const targetId = command ? nonEmptyString(command.target_id) : null;
			const channel = command ? nonEmptyString(command.channel) : null;
			const channelTenantId = command ? nonEmptyString(command.channel_tenant_id) : null;
			const channelConversationId = command ? nonEmptyString(command.channel_conversation_id) : null;
			const actorBindingId = command ? nonEmptyString(command.actor_binding_id) : null;
			const runId = command ? nonEmptyString(command.run_root_id) : null;
			const sessionId = command ? nonEmptyString(command.operator_session_id) : null;
			const conversationKey = buildConversationKey({
				channel,
				tenantId: channelTenantId,
				conversationId: channelConversationId,
				bindingId: actorBindingId,
			});
			const eventType = nonEmptyString(rec.event_type) ?? "command.lifecycle";
			pushItem(out, {
				id: `cp_commands:lifecycle:${commandId ?? row.line}`,
				ts_ms: asInt(rec.ts_ms) ?? (command ? asInt(command.updated_at_ms) : null) ?? 0,
				source_kind: "cp_commands",
				source_path: normalizeRelative(repoRoot, path),
				source_line: row.line,
				repo_root: repoRoot,
				issue_id: null,
				run_id: runId,
				session_id: sessionId,
				channel,
				channel_tenant_id: channelTenantId,
				channel_conversation_id: channelConversationId,
				actor_binding_id: actorBindingId,
				conversation_key: conversationKey,
				topic: null,
				author: null,
				role: null,
				tags: ["cp", "command.lifecycle", state ?? "unknown"],
				metadata: {
					kind,
					event_type: eventType,
					command_id: commandId,
					state,
					target_type: targetType,
					target_id: targetId,
				},
				text: [eventType, commandText ?? "", targetType ?? "", targetId ?? "", state ?? ""]
					.filter((part) => part.length > 0)
					.join("\n"),
			});
			continue;
		}

		if (kind === "domain.mutating") {
			const correlation = asRecord(rec.correlation);
			const eventType = nonEmptyString(rec.event_type) ?? "domain.mutating";
			const channel = correlation ? nonEmptyString(correlation.channel) : null;
			const channelTenantId = correlation ? nonEmptyString(correlation.channel_tenant_id) : null;
			const channelConversationId = correlation ? nonEmptyString(correlation.channel_conversation_id) : null;
			const actorBindingId = correlation ? nonEmptyString(correlation.actor_binding_id) : null;
			const runId = correlation ? nonEmptyString(correlation.run_root_id) : null;
			const sessionId = correlation ? nonEmptyString(correlation.operator_session_id) : null;
			const conversationKey = buildConversationKey({
				channel,
				tenantId: channelTenantId,
				conversationId: channelConversationId,
				bindingId: actorBindingId,
			});
			const payload = rec.payload ?? null;
			pushItem(out, {
				id: `cp_commands:mutating:${row.line}`,
				ts_ms: asInt(rec.ts_ms) ?? 0,
				source_kind: "cp_commands",
				source_path: normalizeRelative(repoRoot, path),
				source_line: row.line,
				repo_root: repoRoot,
				issue_id: null,
				run_id: runId,
				session_id: sessionId,
				channel,
				channel_tenant_id: channelTenantId,
				channel_conversation_id: channelConversationId,
				actor_binding_id: actorBindingId,
				conversation_key: conversationKey,
				topic: null,
				author: null,
				role: null,
				tags: ["cp", "domain.mutating", eventType],
				metadata: {
					kind,
					event_type: eventType,
				},
				text: [eventType, textFromUnknown(payload)].filter((part) => part.length > 0).join("\n"),
			});
		}
	}
	return out;
}

async function collectOutbox(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec || nonEmptyString(rec.kind) !== "outbox.state") {
			continue;
		}
		const record = asRecord(rec.record);
		const envelope = record ? asRecord(record.envelope) : null;
		const correlation = envelope ? asRecord(envelope.correlation) : null;
		const outboxId = record ? nonEmptyString(record.outbox_id) : null;
		const channel = envelope ? nonEmptyString(envelope.channel) : null;
		const channelTenantId = envelope ? nonEmptyString(envelope.channel_tenant_id) : null;
		const channelConversationId = envelope ? nonEmptyString(envelope.channel_conversation_id) : null;
		const actorBindingId = correlation ? nonEmptyString(correlation.actor_binding_id) : null;
		const conversationKey = buildConversationKey({
			channel,
			tenantId: channelTenantId,
			conversationId: channelConversationId,
			bindingId: actorBindingId,
		});
		const runId = correlation ? nonEmptyString(correlation.run_root_id) : null;
		const sessionId = correlation ? nonEmptyString(correlation.operator_session_id) : null;
		const body = envelope ? nonEmptyString(envelope.body) : null;
		const kind = envelope ? nonEmptyString(envelope.kind) : null;
		const state = record ? nonEmptyString(record.state) : null;
		pushItem(out, {
			id: `cp_outbox:${outboxId ?? row.line}`,
			ts_ms: asInt(rec.ts_ms) ?? (record ? asInt(record.updated_at_ms) : null) ?? 0,
			source_kind: "cp_outbox",
			source_path: normalizeRelative(repoRoot, path),
			source_line: row.line,
			repo_root: repoRoot,
			issue_id: null,
			run_id: runId,
			session_id: sessionId,
			channel,
			channel_tenant_id: channelTenantId,
			channel_conversation_id: channelConversationId,
			actor_binding_id: actorBindingId,
			conversation_key: conversationKey,
			topic: null,
			author: null,
			role: null,
			tags: ["cp", "outbox", state ?? "unknown", kind ?? "unknown"],
			metadata: {
				outbox_id: outboxId,
				state,
				kind,
				attempt_count: record ? asInt(record.attempt_count) : null,
				max_attempts: record ? asInt(record.max_attempts) : null,
			},
			text: [kind ?? "", body ?? "", state ?? ""].filter((part) => part.length > 0).join("\n"),
		});
	}
	return out;
}

async function collectAdapterAudit(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec || nonEmptyString(rec.kind) !== "adapter.audit") {
			continue;
		}
		const channel = nonEmptyString(rec.channel);
		const channelTenantId = nonEmptyString(rec.channel_tenant_id);
		const channelConversationId = nonEmptyString(rec.channel_conversation_id);
		const event = nonEmptyString(rec.event) ?? "adapter.audit";
		const commandText = nonEmptyString(rec.command_text) ?? "";
		const reason = nonEmptyString(rec.reason);
		pushItem(out, {
			id: `cp_adapter_audit:${event}:${row.line}`,
			ts_ms: asInt(rec.ts_ms) ?? 0,
			source_kind: "cp_adapter_audit",
			source_path: normalizeRelative(repoRoot, path),
			source_line: row.line,
			repo_root: repoRoot,
			issue_id: null,
			run_id: null,
			session_id: null,
			channel,
			channel_tenant_id: channelTenantId,
			channel_conversation_id: channelConversationId,
			actor_binding_id: null,
			conversation_key: null,
			topic: null,
			author: nonEmptyString(rec.actor_id),
			role: null,
			tags: ["cp", "adapter.audit", event],
			metadata: {
				request_id: nonEmptyString(rec.request_id),
				delivery_id: nonEmptyString(rec.delivery_id),
				reason,
			},
			text: [event, commandText, reason ?? ""].filter((part) => part.length > 0).join("\n"),
		});
	}
	return out;
}

async function collectOperatorTurns(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec || nonEmptyString(rec.kind) !== "operator.turn") {
			continue;
		}
		const outcome = nonEmptyString(rec.outcome) ?? "unknown";
		const reason = nonEmptyString(rec.reason);
		const sessionId = nonEmptyString(rec.session_id);
		const commandText = textFromUnknown(rec.command);
		const messagePreview = nonEmptyString(rec.message_preview) ?? "";
		pushItem(out, {
			id: `cp_operator_turns:${sessionId ?? "unknown"}:${row.line}`,
			ts_ms: asInt(rec.ts_ms) ?? 0,
			source_kind: "cp_operator_turns",
			source_path: normalizeRelative(repoRoot, path),
			source_line: row.line,
			repo_root: repoRoot,
			issue_id: null,
			run_id: null,
			session_id: sessionId,
			channel: nonEmptyString(rec.channel),
			channel_tenant_id: null,
			channel_conversation_id: null,
			actor_binding_id: null,
			conversation_key: null,
			topic: null,
			author: null,
			role: null,
			tags: ["cp", "operator.turn", outcome],
			metadata: {
				request_id: nonEmptyString(rec.request_id),
				turn_id: nonEmptyString(rec.turn_id),
				reason,
			},
			text: [outcome, reason ?? "", messagePreview, commandText].filter((part) => part.length > 0).join("\n"),
		});
	}
	return out;
}

async function collectTelegramIngress(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec || nonEmptyString(rec.kind) !== "telegram.ingress.state") {
			continue;
		}
		const record = asRecord(rec.record);
		const inbound = record ? asRecord(record.inbound) : null;
		const channel = inbound ? nonEmptyString(inbound.channel) : null;
		const channelTenantId = inbound ? nonEmptyString(inbound.channel_tenant_id) : null;
		const channelConversationId = inbound ? nonEmptyString(inbound.channel_conversation_id) : null;
		const actorBindingId = inbound ? nonEmptyString(inbound.actor_binding_id) : null;
		const conversationKey = buildConversationKey({
			channel,
			tenantId: channelTenantId,
			conversationId: channelConversationId,
			bindingId: actorBindingId,
		});
		const ingressId = record ? nonEmptyString(record.ingress_id) : null;
		const state = record ? nonEmptyString(record.state) : null;
		const commandText = inbound ? nonEmptyString(inbound.command_text) : null;
		pushItem(out, {
			id: `cp_telegram_ingress:${ingressId ?? row.line}`,
			ts_ms: asInt(rec.ts_ms) ?? (record ? asInt(record.updated_at_ms) : null) ?? 0,
			source_kind: "cp_telegram_ingress",
			source_path: normalizeRelative(repoRoot, path),
			source_line: row.line,
			repo_root: repoRoot,
			issue_id: null,
			run_id: null,
			session_id: null,
			channel,
			channel_tenant_id: channelTenantId,
			channel_conversation_id: channelConversationId,
			actor_binding_id: actorBindingId,
			conversation_key: conversationKey,
			topic: null,
			author: inbound ? nonEmptyString(inbound.actor_id) : null,
			role: null,
			tags: ["cp", "telegram.ingress", state ?? "unknown"],
			metadata: {
				ingress_id: ingressId,
				state,
				request_id: inbound ? nonEmptyString(inbound.request_id) : null,
			},
			text: [commandText ?? "", state ?? ""].filter((part) => part.length > 0).join("\n"),
		});
	}
	return out;
}

async function collectSessionFlash(repoRoot: string, path: string): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	type FlashCreate = {
		created_at_ms: number;
		flash_id: string;
		session_id: string;
		session_kind: string | null;
		body: string;
		context_ids: string[];
		source: string | null;
		metadata: Record<string, unknown>;
		source_line: number;
	};
	const created = new Map<string, FlashCreate>();
	const delivered = new Map<string, { delivered_at_ms: number; delivered_by: string | null; note: string | null }>();

	for (const row of await readJsonlRows(path)) {
		const rec = asRecord(row.value);
		if (!rec) {
			continue;
		}
		const kind = nonEmptyString(rec.kind);
		if (kind === "session_flash.create") {
			const flashId = nonEmptyString(rec.flash_id);
			const sessionId = nonEmptyString(rec.session_id);
			const body = nonEmptyString(rec.body);
			const tsMs = asInt(rec.ts_ms) ?? 0;
			if (!flashId || !sessionId || !body) {
				continue;
			}
			const contextIds = Array.isArray(rec.context_ids)
				? rec.context_ids
						.map((value) => nonEmptyString(value))
						.filter((value): value is string => value != null)
				: [];
			created.set(flashId, {
				created_at_ms: tsMs,
				flash_id: flashId,
				session_id: sessionId,
				session_kind: nonEmptyString(rec.session_kind),
				body,
				context_ids: contextIds,
				source: nonEmptyString(rec.source),
				metadata: asRecord(rec.metadata) ?? {},
				source_line: row.line,
			});
			continue;
		}
		if (kind === "session_flash.delivery") {
			const flashId = nonEmptyString(rec.flash_id);
			if (!flashId) {
				continue;
			}
			delivered.set(flashId, {
				delivered_at_ms: asInt(rec.ts_ms) ?? 0,
				delivered_by: nonEmptyString(rec.delivered_by),
				note: nonEmptyString(rec.note),
			});
		}
	}

	for (const create of created.values()) {
		const delivery = delivered.get(create.flash_id);
		const status = delivery ? "delivered" : "pending";
		pushItem(out, {
			id: `session_flash:${create.flash_id}`,
			ts_ms: create.created_at_ms,
			source_kind: "session_flash",
			source_path: normalizeRelative(repoRoot, path),
			source_line: create.source_line,
			repo_root: repoRoot,
			issue_id: null,
			run_id: null,
			session_id: create.session_id,
			channel: null,
			channel_tenant_id: null,
			channel_conversation_id: null,
			actor_binding_id: null,
			conversation_key: null,
			topic: null,
			author: create.source,
			role: "user",
			tags: ["session_flash", status, create.session_kind ?? "unknown"],
			metadata: {
				flash_id: create.flash_id,
				session_kind: create.session_kind,
				context_ids: create.context_ids,
				delivery: delivery
					? {
							delivered_at_ms: delivery.delivered_at_ms,
							delivered_by: delivery.delivered_by,
							note: delivery.note,
					  }
					: null,
				...create.metadata,
			},
			text: [create.body, create.context_ids.join(" "), status].filter((part) => part.length > 0).join("\n"),
		});
	}
	return out;
}

function sessionIdFromPath(path: string): string {
	const fileName = path.split(/[\\/]/).pop() ?? path;
	return fileName.replace(/\.jsonl$/i, "") || `session-${crypto.randomUUID()}`;
}

async function collectSessionMessages(opts: {
	repoRoot: string;
	dir: string;
	sourceKind: ContextSourceKind;
	conversationKeysBySessionId?: Map<string, string[]>;
}): Promise<ContextItem[]> {
	const out: ContextItem[] = [];
	const files = await listJsonlFiles(opts.dir);
	for (const filePath of files) {
		const rows = await readJsonlRows(filePath);
		const fileStat = await stat(filePath).catch(() => null);
		let sessionId: string | null = null;
		for (const row of rows) {
			const rec = asRecord(row.value);
			if (!rec) {
				continue;
			}
			const entryType = nonEmptyString(rec.type);
			if (entryType === "session") {
				sessionId = nonEmptyString(rec.id) ?? sessionId;
				continue;
			}
			if (entryType !== "message") {
				continue;
			}
			const msg = asRecord(rec.message);
			if (!msg) {
				continue;
			}
			const role = nonEmptyString(msg.role);
			const text = extractMessageText(msg);
			if (text.trim().length === 0) {
				continue;
			}
			const resolvedSessionId = sessionId ?? sessionIdFromPath(filePath);
			const tsMs =
				parseTimestamp(rec.timestamp) ??
				Math.trunc(fileStat?.mtimeMs ?? fileStat?.ctimeMs ?? fileStat?.birthtimeMs ?? 0);
			const conversationKeys =
				opts.conversationKeysBySessionId?.get(resolvedSessionId)?.slice().sort((a, b) => a.localeCompare(b)) ?? [];
			pushItem(out, {
				id: `${opts.sourceKind}:${resolvedSessionId}:${row.line}:${normalizeRelative(opts.repoRoot, filePath)}`,
				ts_ms: tsMs,
				source_kind: opts.sourceKind,
				source_path: normalizeRelative(opts.repoRoot, filePath),
				source_line: row.line,
				repo_root: opts.repoRoot,
				issue_id: null,
				run_id: null,
				session_id: resolvedSessionId,
				channel: null,
				channel_tenant_id: null,
				channel_conversation_id: null,
				actor_binding_id: null,
				conversation_key: conversationKeys[0] ?? null,
				topic: null,
				author: null,
				role,
				tags: ["session", opts.sourceKind, role ?? "unknown"],
				metadata: {
					entry_id: nonEmptyString(rec.id),
					parent_id: nonEmptyString(rec.parentId),
					conversation_keys: conversationKeys,
				},
				text,
			});
		}
	}
	return out;
}

async function collectContextItems(repoRoot: string, requestedSources: Set<ContextSourceKind> | null): Promise<ContextItem[]> {
	const include = (kind: ContextSourceKind): boolean => (requestedSources ? requestedSources.has(kind) : true);
	const paths = getStorePaths(repoRoot);
	const cp = getControlPlanePaths(repoRoot);
	const cpDir = cp.controlPlaneDir;
	const conversationMap = await loadConversationBindings(join(cpDir, "operator_conversations.json")).catch(() => new Map());
	const conversationKeysBySessionId = reverseConversationBindings(conversationMap);

	const tasks: Promise<ContextItem[]>[] = [];

	if (include("issues")) {
		tasks.push(collectIssues(repoRoot, paths.issuesPath));
	}
	if (include("forum")) {
		tasks.push(collectForum(repoRoot, paths.forumPath));
	}
	if (include("events")) {
		tasks.push(collectEvents(repoRoot, paths.eventsPath));
	}
	if (include("cp_commands")) {
		tasks.push(collectCommandJournal(repoRoot, cp.commandsPath));
	}
	if (include("cp_outbox")) {
		tasks.push(collectOutbox(repoRoot, cp.outboxPath));
	}
	if (include("cp_adapter_audit")) {
		tasks.push(collectAdapterAudit(repoRoot, cp.adapterAuditPath));
	}
	if (include("cp_operator_turns")) {
		tasks.push(collectOperatorTurns(repoRoot, join(cpDir, "operator_turns.jsonl")));
	}
	if (include("cp_telegram_ingress")) {
		tasks.push(collectTelegramIngress(repoRoot, join(cpDir, "telegram_ingress.jsonl")));
	}
	if (include("session_flash")) {
		tasks.push(collectSessionFlash(repoRoot, join(cpDir, "session_flash.jsonl")));
	}
	if (include("operator_sessions")) {
		tasks.push(
			collectSessionMessages({
				repoRoot,
				dir: join(repoRoot, ".mu", "operator", "sessions"),
				sourceKind: "operator_sessions",
			}),
		);
	}
	if (include("cp_operator_sessions")) {
		tasks.push(
			collectSessionMessages({
				repoRoot,
				dir: join(cpDir, "operator-sessions"),
				sourceKind: "cp_operator_sessions",
				conversationKeysBySessionId,
			}),
		);
	}

	const chunks = await Promise.all(tasks);
	const items = chunks.flat();
	items.sort((a, b) => {
		if (a.ts_ms !== b.ts_ms) {
			return b.ts_ms - a.ts_ms;
		}
		return a.id.localeCompare(b.id);
	});
	return items;
}

function searchContext(items: ContextItem[], filters: SearchFilters): Array<ContextItem & { score: number }> {
	const scored: Array<ContextItem & { score: number }> = [];
	for (const item of items) {
		if (!matchSearchFilters(item, filters)) {
			continue;
		}
		const score = scoreItem(item, filters.query);
		if (score < 0) {
			continue;
		}
		scored.push({ ...item, score });
	}
	scored.sort((a, b) => {
		if (a.score !== b.score) {
			return b.score - a.score;
		}
		if (a.ts_ms !== b.ts_ms) {
			return b.ts_ms - a.ts_ms;
		}
		return a.id.localeCompare(b.id);
	});
	return scored;
}

function timelineContext(items: ContextItem[], filters: TimelineFilters): ContextItem[] {
	const out = items.filter((item) => matchSearchFilters(item, filters));
	out.sort((a, b) => {
		if (a.ts_ms !== b.ts_ms) {
			return filters.order === "asc" ? a.ts_ms - b.ts_ms : b.ts_ms - a.ts_ms;
		}
		return a.id.localeCompare(b.id);
	});
	if (filters.query) {
		const query = filters.query.toLowerCase();
		const tokens = tokenizeQuery(query);
		return out.filter((item) => {
			const haystack = searchableText(item);
			if (haystack.includes(query)) {
				return true;
			}
			if (tokens.length === 0) {
				return true;
			}
			return tokens.every((token) => haystack.includes(token));
		});
	}
	return out;
}

function buildSourceStats(items: ContextItem[]): Array<{
	source_kind: ContextSourceKind;
	count: number;
	text_bytes: number;
	last_ts_ms: number;
}> {
	const map = new Map<ContextSourceKind, { count: number; textBytes: number; lastTsMs: number }>();
	for (const item of items) {
		const row = map.get(item.source_kind) ?? { count: 0, textBytes: 0, lastTsMs: 0 };
		row.count += 1;
		row.textBytes += item.text.length;
		row.lastTsMs = Math.max(row.lastTsMs, item.ts_ms);
		map.set(item.source_kind, row);
	}
	const out = [...map.entries()].map(([source, row]) => ({
		source_kind: source,
		count: row.count,
		text_bytes: row.textBytes,
		last_ts_ms: row.lastTsMs,
	}));
	out.sort((a, b) => {
		if (a.count !== b.count) {
			return b.count - a.count;
		}
		return a.source_kind.localeCompare(b.source_kind);
	});
	return out;
}

export async function contextRoutes(
	request: Request,
	url: URL,
	deps: { context: ServerContext; describeError: (error: unknown) => string },
	headers: Headers,
): Promise<Response> {
	if (request.method !== "GET") {
		return Response.json({ error: "Method Not Allowed" }, { status: 405, headers });
	}

	const path = url.pathname.replace("/api/context", "") || "/";

	try {
		if (path === "/" || path === "/search") {
			const filters = parseSearchFilters(url);
			const items = await collectContextItems(deps.context.repoRoot, filters.sources);
			const ranked = searchContext(items, filters);
			const sliced = ranked.slice(0, filters.limit);
			return Response.json(
				{
					mode: "search",
					repo_root: deps.context.repoRoot,
					query: filters.query,
					count: sliced.length,
					total: ranked.length,
					items: sliced,
				},
				{ headers },
			);
		}

		if (path === "/timeline") {
			const filters = parseTimelineFilters(url);
			const items = await collectContextItems(deps.context.repoRoot, filters.sources);
			const timeline = timelineContext(items, filters);
			const sliced = timeline.slice(0, filters.limit);
			return Response.json(
				{
					mode: "timeline",
					repo_root: deps.context.repoRoot,
					order: filters.order,
					count: sliced.length,
					total: timeline.length,
					items: sliced,
				},
				{ headers },
			);
		}

		if (path === "/stats") {
			const filters = parseSearchFilters(url);
			const items = await collectContextItems(deps.context.repoRoot, filters.sources);
			const filtered = items.filter((item) => matchSearchFilters(item, { ...filters, query: null }));
			const sources = buildSourceStats(filtered);
			return Response.json(
				{
					mode: "stats",
					repo_root: deps.context.repoRoot,
					total_count: filtered.length,
					total_text_bytes: filtered.reduce((sum, item) => sum + item.text.length, 0),
					sources,
				},
				{ headers },
			);
		}

		return Response.json({ error: "Not Found" }, { status: 404, headers });
	} catch (err) {
		if (err instanceof QueryValidationError) {
			return Response.json({ error: err.message }, { status: err.status, headers });
		}
		return Response.json(
			{ error: `context query failed: ${deps.describeError(err)}` },
			{ status: 500, headers },
		);
	}
}
