import { existsSync, createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { getStorePaths } from "./store.js";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 500;
const MAX_TEXT_LENGTH = 8_000;
const PREVIEW_LENGTH = 240;
const CONTEXT_INDEX_SCHEMA_VERSION = 1;
const CONTEXT_INDEX_FILENAME = "memory.db";
const INDEX_QUERY_ROW_LIMIT = 100_000;
const INDEX_FTS_ROW_LIMIT = 100_000;
const AUTO_INDEX_REBUILD_IN_FLIGHT = new Map<string, Promise<boolean>>();

export const CONTEXT_SOURCE_KINDS = [
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

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

export type ContextItem = {
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

export type SearchFilters = {
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

export type TimelineFilters = SearchFilters & {
	order: "asc" | "desc";
};

type JsonlRow = {
	line: number;
	value: unknown;
};

export class ContextQueryValidationError extends Error {
	readonly status = 400;

	public constructor(message: string) {
		super(message);
		this.name = "ContextQueryValidationError";
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
		throw new ContextQueryValidationError("invalid limit: expected integer");
	}
	if (parsed < 1) {
		throw new ContextQueryValidationError("invalid limit: must be >= 1");
	}
	return Math.min(parsed, MAX_LIMIT);
}

function parseOptionalTs(value: string | null, name: string): number | null {
	if (value == null || value.trim().length === 0) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		throw new ContextQueryValidationError(`invalid ${name}: expected integer epoch ms`);
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
		throw new ContextQueryValidationError(
			`unknown memory source: ${part}. valid sources: ${CONTEXT_SOURCE_KINDS.join(", ")}`,
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
		throw new ContextQueryValidationError(
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
			const runId = null;
			const sessionId = command
				? nonEmptyString(command.operator_session_id) ?? nonEmptyString(command.meta_session_id)
				: null;
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
			const runId = null;
			const sessionId = correlation
				? nonEmptyString(correlation.operator_session_id) ?? nonEmptyString(correlation.meta_session_id)
				: null;
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
		const runId = null;
		const sessionId = correlation
			? nonEmptyString(correlation.operator_session_id) ?? nonEmptyString(correlation.meta_session_id)
			: null;
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

type ControlPlaneMemoryPaths = {
	controlPlaneDir: string;
	commandsPath: string;
	outboxPath: string;
	adapterAuditPath: string;
};

function getControlPlaneMemoryPaths(repoRoot: string): ControlPlaneMemoryPaths {
	const store = getStorePaths(repoRoot);
	const controlPlaneDir = join(store.storeDir, "control-plane");
	return {
		controlPlaneDir,
		commandsPath: join(controlPlaneDir, "commands.jsonl"),
		outboxPath: join(controlPlaneDir, "outbox.jsonl"),
		adapterAuditPath: join(controlPlaneDir, "adapter_audit.jsonl"),
	};
}

async function collectContextItems(repoRoot: string, requestedSources: Set<ContextSourceKind> | null): Promise<ContextItem[]> {
	const include = (kind: ContextSourceKind): boolean => (requestedSources ? requestedSources.has(kind) : true);
	const paths = getStorePaths(repoRoot);
	const cp = getControlPlaneMemoryPaths(repoRoot);
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
				dir: join(paths.storeDir, "operator", "sessions"),
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

export type ContextIndexSourceSummary = {
	source_kind: ContextSourceKind;
	count: number;
	text_bytes: number;
	last_ts_ms: number;
};

export type ContextIndexStatusResult = {
	mode: "index_status";
	repo_root: string;
	index_path: string;
	exists: boolean;
	schema_version: number;
	built_at_ms: number | null;
	total_count: number;
	total_text_bytes: number;
	source_count: number;
	stale_source_count: number;
	stale_source_paths: string[];
	sources: ContextIndexSourceSummary[];
};

export type ContextIndexRebuildResult = Omit<ContextIndexStatusResult, "mode"> & {
	mode: "index_rebuild";
	indexed_count: number;
	duration_ms: number;
	requested_sources: ContextSourceKind[] | null;
};

function contextIndexPath(repoRoot: string): string {
	return join(getStorePaths(repoRoot).storeDir, "context", CONTEXT_INDEX_FILENAME);
}

function toContextSourceKind(value: string): ContextSourceKind | null {
	if ((CONTEXT_SOURCE_KINDS as readonly string[]).includes(value)) {
		return value as ContextSourceKind;
	}
	return null;
}

function contextIndexFtsText(item: ContextItem): string {
	return [
		item.text,
		item.preview,
		item.source_kind,
		item.issue_id ?? "",
		item.run_id ?? "",
		item.session_id ?? "",
		item.channel ?? "",
		item.channel_tenant_id ?? "",
		item.channel_conversation_id ?? "",
		item.actor_binding_id ?? "",
		item.conversation_key ?? "",
		item.topic ?? "",
		item.author ?? "",
		item.role ?? "",
		item.tags.join(" "),
	].join("\n");
}

function parseStringArrayJson(value: unknown): string[] {
	if (typeof value !== "string") {
		return [];
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

function parseRecordJson(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") {
		return {};
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return asRecord(parsed) ?? {};
	} catch {
		return {};
	}
}

function contextItemFromIndexedRow(rowRaw: unknown): ContextItem | null {
	const row = asRecord(rowRaw);
	if (!row) {
		return null;
	}
	const sourceKindRaw = nonEmptyString(row.source_kind);
	if (!sourceKindRaw) {
		return null;
	}
	const sourceKind = toContextSourceKind(sourceKindRaw);
	if (!sourceKind) {
		return null;
	}
	const id = nonEmptyString(row.item_id);
	const sourcePath = nonEmptyString(row.source_path);
	const repoRoot = nonEmptyString(row.repo_root);
	const text = nonEmptyString(row.text);
	const preview = nonEmptyString(row.preview);
	if (!id || !sourcePath || !repoRoot || !text || !preview) {
		return null;
	}
	return {
		id,
		ts_ms: asInt(row.ts_ms) ?? 0,
		source_kind: sourceKind,
		source_path: sourcePath,
		source_line: asInt(row.source_line) ?? 0,
		repo_root: repoRoot,
		text,
		preview,
		issue_id: nonEmptyString(row.issue_id),
		run_id: nonEmptyString(row.run_id),
		session_id: nonEmptyString(row.session_id),
		channel: nonEmptyString(row.channel),
		channel_tenant_id: nonEmptyString(row.channel_tenant_id),
		channel_conversation_id: nonEmptyString(row.channel_conversation_id),
		actor_binding_id: nonEmptyString(row.actor_binding_id),
		conversation_key: nonEmptyString(row.conversation_key),
		topic: nonEmptyString(row.topic),
		author: nonEmptyString(row.author),
		role: nonEmptyString(row.role),
		tags: parseStringArrayJson(row.tags_json),
		metadata: parseRecordJson(row.metadata_json),
	};
}

function sqlClauseForFilters(filters: SearchFilters): { clause: string; params: unknown[] } {
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (filters.sources && filters.sources.size > 0) {
		const values = [...filters.sources];
		clauses.push(`source_kind IN (${values.map(() => "?").join(",")})`);
		params.push(...values);
	}
	if (filters.sinceMs != null) {
		clauses.push("ts_ms >= ?");
		params.push(filters.sinceMs);
	}
	if (filters.untilMs != null) {
		clauses.push("ts_ms <= ?");
		params.push(filters.untilMs);
	}
	if (filters.issueId) {
		clauses.push("issue_id = ?");
		params.push(filters.issueId);
	}
	if (filters.runId) {
		clauses.push("run_id = ?");
		params.push(filters.runId);
	}
	if (filters.sessionId) {
		clauses.push("session_id = ?");
		params.push(filters.sessionId);
	}
	if (filters.channel) {
		clauses.push("channel = ?");
		params.push(filters.channel);
	}
	if (filters.channelTenantId) {
		clauses.push("channel_tenant_id = ?");
		params.push(filters.channelTenantId);
	}
	if (filters.channelConversationId) {
		clauses.push("channel_conversation_id = ?");
		params.push(filters.channelConversationId);
	}
	if (filters.actorBindingId) {
		clauses.push("actor_binding_id = ?");
		params.push(filters.actorBindingId);
	}
	if (filters.topic) {
		clauses.push("topic = ?");
		params.push(filters.topic);
	}
	if (filters.author) {
		clauses.push("author = ?");
		params.push(filters.author);
	}
	if (filters.role) {
		clauses.push("role = ?");
		params.push(filters.role);
	}
	const clause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	return { clause, params };
}

type FtsMatchResult =
	| { kind: "ok"; ids: Set<string> }
	| { kind: "truncated" }
	| { kind: "error" };

function ftsQueryFromText(query: string): string {
	const tokens = tokenizeQuery(query);
	if (tokens.length === 0) {
		const escaped = query.replaceAll('"', '""');
		return `"${escaped}"`;
	}
	return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function lookupFtsMatches(db: Database, query: string): FtsMatchResult {
	const ftsQuery = ftsQueryFromText(query);
	try {
		const rows = db
			.query("SELECT item_id FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?")
			.all(ftsQuery, INDEX_FTS_ROW_LIMIT) as unknown[];
		if (rows.length >= INDEX_FTS_ROW_LIMIT) {
			return { kind: "truncated" };
		}
		const ids = new Set<string>();
		for (const rowRaw of rows) {
			const row = asRecord(rowRaw);
			const id = row ? nonEmptyString(row.item_id) : null;
			if (id) {
				ids.add(id);
			}
		}
		return { kind: "ok", ids };
	} catch {
		return { kind: "error" };
	}
}

function queryIndexedCandidates(db: Database, filters: SearchFilters): ContextItem[] | null {
	const sqlFilter = sqlClauseForFilters(filters);
	const sql = [
		"SELECT",
		"  item_id, ts_ms, source_kind, source_path, source_line, repo_root,",
		"  text, preview, issue_id, run_id, session_id, channel,",
		"  channel_tenant_id, channel_conversation_id, actor_binding_id, conversation_key,",
		"  topic, author, role, tags_json, metadata_json",
		"FROM memory_items",
		sqlFilter.clause,
		"ORDER BY ts_ms DESC, item_id ASC",
		"LIMIT ?",
	].join(" ");
	const rows = db.query(sql).all(...(sqlFilter.params as any[]), INDEX_QUERY_ROW_LIMIT) as unknown[];
	if (rows.length >= INDEX_QUERY_ROW_LIMIT) {
		return null;
	}
	const items: ContextItem[] = [];
	for (const row of rows) {
		const item = contextItemFromIndexedRow(row);
		if (item) {
			items.push(item);
		}
	}
	return items;
}

function readContextSearchFromIndex(opts: {
	repoRoot: string;
	filters: SearchFilters;
}): ContextSearchResult | null {
	const indexPath = contextIndexPath(opts.repoRoot);
	if (!existsSync(indexPath)) {
		return null;
	}
	let db: Database | null = null;
	try {
		db = new Database(indexPath, { readonly: true, create: false });
		const baseItems = queryIndexedCandidates(db, opts.filters);
		if (!baseItems) {
			return null;
		}
		let candidates = baseItems;
		if (opts.filters.query) {
			const match = lookupFtsMatches(db, opts.filters.query);
			if (match.kind === "truncated") {
				return null;
			}
			if (match.kind === "ok") {
				candidates = candidates.filter((item) => match.ids.has(item.id));
			}
		}
		const ranked = searchContext(candidates, opts.filters);
		const sliced = ranked.slice(0, opts.filters.limit);
		return {
			mode: "search",
			repo_root: opts.repoRoot,
			query: opts.filters.query,
			count: sliced.length,
			total: ranked.length,
			items: sliced,
		};
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function readContextTimelineFromIndex(opts: {
	repoRoot: string;
	filters: TimelineFilters;
}): ContextTimelineResult | null {
	const indexPath = contextIndexPath(opts.repoRoot);
	if (!existsSync(indexPath)) {
		return null;
	}
	let db: Database | null = null;
	try {
		db = new Database(indexPath, { readonly: true, create: false });
		const baseItems = queryIndexedCandidates(db, opts.filters);
		if (!baseItems) {
			return null;
		}
		let candidates = baseItems;
		if (opts.filters.query) {
			const match = lookupFtsMatches(db, opts.filters.query);
			if (match.kind === "truncated") {
				return null;
			}
			if (match.kind === "ok") {
				candidates = candidates.filter((item) => match.ids.has(item.id));
			}
		}
		const timeline = timelineContext(candidates, opts.filters);
		const sliced = timeline.slice(0, opts.filters.limit);
		return {
			mode: "timeline",
			repo_root: opts.repoRoot,
			order: opts.filters.order,
			count: sliced.length,
			total: timeline.length,
			items: sliced,
		};
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function readContextStatsFromIndex(opts: {
	repoRoot: string;
	filters: SearchFilters;
}): ContextStatsResult | null {
	const indexPath = contextIndexPath(opts.repoRoot);
	if (!existsSync(indexPath)) {
		return null;
	}
	let db: Database | null = null;
	try {
		db = new Database(indexPath, { readonly: true, create: false });
		const items = queryIndexedCandidates(db, opts.filters);
		if (!items) {
			return null;
		}
		const filtered = items.filter((item) => matchSearchFilters(item, { ...opts.filters, query: null }));
		const sources = buildSourceStats(filtered);
		return {
			mode: "stats",
			repo_root: opts.repoRoot,
			total_count: filtered.length,
			total_text_bytes: filtered.reduce((sum, item) => sum + item.text.length, 0),
			sources,
		};
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function parseMetaInt(db: Database, key: string): number | null {
	const row = db.query("SELECT value FROM memory_meta WHERE key = ?").get(key) as unknown;
	const rec = asRecord(row);
	const valueRaw = rec ? nonEmptyString(rec.value) : null;
	if (!valueRaw) {
		return null;
	}
	const parsed = Number.parseInt(valueRaw, 10);
	if (!Number.isFinite(parsed)) {
		return null;
	}
	return parsed;
}

function ensureContextIndexSchema(db: Database): void {
	db.exec(
		[
			"PRAGMA journal_mode = WAL;",
			"PRAGMA synchronous = NORMAL;",
			"CREATE TABLE IF NOT EXISTS memory_meta (",
			"  key TEXT PRIMARY KEY,",
			"  value TEXT NOT NULL",
			");",
			"CREATE TABLE IF NOT EXISTS memory_items (",
			"  item_id TEXT PRIMARY KEY,",
			"  ts_ms INTEGER NOT NULL,",
			"  source_kind TEXT NOT NULL,",
			"  source_path TEXT NOT NULL,",
			"  source_line INTEGER NOT NULL,",
			"  repo_root TEXT NOT NULL,",
			"  text TEXT NOT NULL,",
			"  preview TEXT NOT NULL,",
			"  issue_id TEXT,",
			"  run_id TEXT,",
			"  session_id TEXT,",
			"  channel TEXT,",
			"  channel_tenant_id TEXT,",
			"  channel_conversation_id TEXT,",
			"  actor_binding_id TEXT,",
			"  conversation_key TEXT,",
			"  topic TEXT,",
			"  author TEXT,",
			"  role TEXT,",
			"  tags_json TEXT NOT NULL,",
			"  metadata_json TEXT NOT NULL",
			");",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_ts ON memory_items(ts_ms DESC);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_source_ts ON memory_items(source_kind, ts_ms DESC);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_issue ON memory_items(issue_id);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_run ON memory_items(run_id);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_session ON memory_items(session_id);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_channel ON memory_items(channel);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_topic ON memory_items(topic);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_author ON memory_items(author);",
			"CREATE INDEX IF NOT EXISTS idx_memory_items_role ON memory_items(role);",
			"CREATE TABLE IF NOT EXISTS source_state (",
			"  source_kind TEXT NOT NULL,",
			"  source_path TEXT NOT NULL,",
			"  row_count INTEGER NOT NULL,",
			"  mtime_ms INTEGER,",
			"  size_bytes INTEGER,",
			"  updated_at_ms INTEGER NOT NULL,",
			"  PRIMARY KEY(source_kind, source_path)",
			");",
			"CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(",
			"  item_id UNINDEXED,",
			"  fulltext",
			");",
		].join("\n"),
	);
}

function writeMeta(db: Database, key: string, value: string): void {
	db
		.query("INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.run(key, value);
}

async function buildIndexSourceStateRows(repoRoot: string, items: ContextItem[]): Promise<
	Array<{
		source_kind: ContextSourceKind;
		source_path: string;
		row_count: number;
		mtime_ms: number | null;
		size_bytes: number | null;
	}>
> {
	const rowsByKey = new Map<string, { source_kind: ContextSourceKind; source_path: string; row_count: number }>();
	for (const item of items) {
		const key = `${item.source_kind}\u0000${item.source_path}`;
		const row = rowsByKey.get(key);
		if (row) {
			row.row_count += 1;
			continue;
		}
		rowsByKey.set(key, {
			source_kind: item.source_kind,
			source_path: item.source_path,
			row_count: 1,
		});
	}

	const out: Array<{
		source_kind: ContextSourceKind;
		source_path: string;
		row_count: number;
		mtime_ms: number | null;
		size_bytes: number | null;
	}> = [];
	for (const row of rowsByKey.values()) {
		const absolutePath = join(repoRoot, row.source_path);
		const stats = await stat(absolutePath).catch(() => null);
		out.push({
			...row,
			mtime_ms: stats ? Math.trunc(stats.mtimeMs) : null,
			size_bytes: stats ? Math.trunc(stats.size) : null,
		});
	}
	out.sort((a, b) => {
		if (a.source_kind !== b.source_kind) {
			return a.source_kind.localeCompare(b.source_kind);
		}
		return a.source_path.localeCompare(b.source_path);
	});
	return out;
}

function readSourceSummariesFromIndex(db: Database): ContextIndexSourceSummary[] {
	const rows = db
		.query(
			"SELECT source_kind, COUNT(*) AS count, IFNULL(SUM(LENGTH(text)), 0) AS text_bytes, IFNULL(MAX(ts_ms), 0) AS last_ts_ms FROM memory_items GROUP BY source_kind",
		)
		.all() as unknown[];
	const out: ContextIndexSourceSummary[] = [];
	for (const rowRaw of rows) {
		const row = asRecord(rowRaw);
		if (!row) {
			continue;
		}
		const sourceKindRaw = nonEmptyString(row.source_kind);
		if (!sourceKindRaw) {
			continue;
		}
		const sourceKind = toContextSourceKind(sourceKindRaw);
		if (!sourceKind) {
			continue;
		}
		out.push({
			source_kind: sourceKind,
			count: asInt(row.count) ?? 0,
			text_bytes: asInt(row.text_bytes) ?? 0,
			last_ts_ms: asInt(row.last_ts_ms) ?? 0,
		});
	}
	out.sort((a, b) => {
		if (a.count !== b.count) {
			return b.count - a.count;
		}
		return a.source_kind.localeCompare(b.source_kind);
	});
	return out;
}

async function staleSourcePathsFromIndex(repoRoot: string, db: Database): Promise<string[]> {
	const rows = db
		.query("SELECT source_path, mtime_ms, size_bytes FROM source_state ORDER BY source_path ASC")
		.all() as unknown[];
	const stale: string[] = [];
	for (const rowRaw of rows) {
		const row = asRecord(rowRaw);
		if (!row) {
			continue;
		}
		const sourcePath = nonEmptyString(row.source_path);
		if (!sourcePath) {
			continue;
		}
		const expectedMtime = asInt(row.mtime_ms);
		const expectedSize = asInt(row.size_bytes);
		const absolutePath = join(repoRoot, sourcePath);
		const stats = await stat(absolutePath).catch(() => null);
		const currentMtime = stats ? Math.trunc(stats.mtimeMs) : null;
		const currentSize = stats ? Math.trunc(stats.size) : null;
		if (expectedMtime !== currentMtime || expectedSize !== currentSize) {
			stale.push(sourcePath);
		}
	}
	return stale;
}

export async function runContextIndexStatus(opts: { repoRoot: string }): Promise<ContextIndexStatusResult> {
	const indexPath = contextIndexPath(opts.repoRoot);
	if (!existsSync(indexPath)) {
		return {
			mode: "index_status",
			repo_root: opts.repoRoot,
			index_path: indexPath,
			exists: false,
			schema_version: CONTEXT_INDEX_SCHEMA_VERSION,
			built_at_ms: null,
			total_count: 0,
			total_text_bytes: 0,
			source_count: 0,
			stale_source_count: 0,
			stale_source_paths: [],
			sources: [],
		};
	}

	const db = new Database(indexPath, { readonly: true, create: false });
	try {
		const totalsRow = asRecord(
			db.query("SELECT COUNT(*) AS count, IFNULL(SUM(LENGTH(text)), 0) AS text_bytes FROM memory_items").get(),
		);
		const totalCount = totalsRow ? asInt(totalsRow.count) ?? 0 : 0;
		const totalTextBytes = totalsRow ? asInt(totalsRow.text_bytes) ?? 0 : 0;
		const sources = readSourceSummariesFromIndex(db);
		const staleSourcePaths = await staleSourcePathsFromIndex(opts.repoRoot, db);
		return {
			mode: "index_status",
			repo_root: opts.repoRoot,
			index_path: indexPath,
			exists: true,
			schema_version: parseMetaInt(db, "schema_version") ?? CONTEXT_INDEX_SCHEMA_VERSION,
			built_at_ms: parseMetaInt(db, "built_at_ms"),
			total_count: totalCount,
			total_text_bytes: totalTextBytes,
			source_count: sources.length,
			stale_source_count: staleSourcePaths.length,
			stale_source_paths: staleSourcePaths.slice(0, 25),
			sources,
		};
	} finally {
		db.close();
	}
}

export async function runContextIndexRebuild(opts: {
	repoRoot: string;
	search: URLSearchParams;
}): Promise<ContextIndexRebuildResult> {
	const startedAtMs = Date.now();
	const requestedSources = parseSourceFilter(opts.search.get("sources") ?? opts.search.get("source"));
	const items = await collectContextItems(opts.repoRoot, requestedSources);
	const sourceStateRows = await buildIndexSourceStateRows(opts.repoRoot, items);

	const indexPath = contextIndexPath(opts.repoRoot);
	await mkdir(join(getStorePaths(opts.repoRoot).storeDir, "context"), { recursive: true });
	const db = new Database(indexPath, { create: true });
	try {
		ensureContextIndexSchema(db);
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec("DELETE FROM memory_items");
			db.exec("DELETE FROM memory_fts");
			db.exec("DELETE FROM source_state");

			const insertItem = db.query(
				[
					"INSERT INTO memory_items (",
					"  item_id, ts_ms, source_kind, source_path, source_line, repo_root,",
					"  text, preview, issue_id, run_id, session_id, channel,",
					"  channel_tenant_id, channel_conversation_id, actor_binding_id, conversation_key,",
					"  topic, author, role, tags_json, metadata_json",
					") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				].join("\n"),
			);
			const insertFts = db.query("INSERT INTO memory_fts (item_id, fulltext) VALUES (?, ?)");
			for (const item of items) {
				insertItem.run(
					item.id,
					item.ts_ms,
					item.source_kind,
					item.source_path,
					item.source_line,
					item.repo_root,
					item.text,
					item.preview,
					item.issue_id,
					item.run_id,
					item.session_id,
					item.channel,
					item.channel_tenant_id,
					item.channel_conversation_id,
					item.actor_binding_id,
					item.conversation_key,
					item.topic,
					item.author,
					item.role,
					JSON.stringify(item.tags),
					JSON.stringify(item.metadata),
				);
				insertFts.run(item.id, contextIndexFtsText(item));
			}

			const insertSourceState = db.query(
				"INSERT INTO source_state (source_kind, source_path, row_count, mtime_ms, size_bytes, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
			);
			const updatedAtMs = Date.now();
			for (const row of sourceStateRows) {
				insertSourceState.run(
					row.source_kind,
					row.source_path,
					row.row_count,
					row.mtime_ms,
					row.size_bytes,
					updatedAtMs,
				);
			}

			writeMeta(db, "schema_version", String(CONTEXT_INDEX_SCHEMA_VERSION));
			writeMeta(db, "built_at_ms", String(Date.now()));
			writeMeta(db, "repo_root", opts.repoRoot);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	} finally {
		db.close();
	}

	const status = await runContextIndexStatus({ repoRoot: opts.repoRoot });
	return {
		mode: "index_rebuild",
		repo_root: status.repo_root,
		index_path: status.index_path,
		exists: status.exists,
		schema_version: status.schema_version,
		built_at_ms: status.built_at_ms,
		total_count: status.total_count,
		total_text_bytes: status.total_text_bytes,
		source_count: status.source_count,
		stale_source_count: status.stale_source_count,
		stale_source_paths: status.stale_source_paths,
		sources: status.sources,
		indexed_count: items.length,
		duration_ms: Math.max(0, Date.now() - startedAtMs),
		requested_sources: requestedSources ? [...requestedSources].sort((a, b) => a.localeCompare(b)) : null,
	};
}

export type ContextIndexAutoRebuildMode = "off" | "missing" | "missing_or_stale";

const AUTO_INDEX_REBUILD_COOLDOWN_MS = 15_000;
const AUTO_INDEX_LAST_ATTEMPT_MS = new Map<string, number>();

function shouldAttemptAutoIndexRebuild(status: ContextIndexStatusResult, mode: ContextIndexAutoRebuildMode): boolean {
	if (mode === "off") {
		return false;
	}
	if (!status.exists) {
		return true;
	}
	if (mode === "missing_or_stale" && status.stale_source_count > 0) {
		return true;
	}
	return false;
}

async function maybeAutoRebuildContextIndex(opts: {
	repoRoot: string;
	mode: ContextIndexAutoRebuildMode;
}): Promise<void> {
	if (opts.mode === "off") {
		return;
	}
	const status = await runContextIndexStatus({ repoRoot: opts.repoRoot });
	if (!shouldAttemptAutoIndexRebuild(status, opts.mode)) {
		return;
	}
	const nowMs = Date.now();
	const lastAttemptMs = AUTO_INDEX_LAST_ATTEMPT_MS.get(opts.repoRoot) ?? 0;
	if (nowMs - lastAttemptMs < AUTO_INDEX_REBUILD_COOLDOWN_MS) {
		return;
	}
	AUTO_INDEX_LAST_ATTEMPT_MS.set(opts.repoRoot, nowMs);

	let inFlight = AUTO_INDEX_REBUILD_IN_FLIGHT.get(opts.repoRoot);
	if (!inFlight) {
		inFlight = (async () => {
			try {
				await runContextIndexRebuild({ repoRoot: opts.repoRoot, search: new URLSearchParams() });
				return true;
			} catch {
				return false;
			} finally {
				AUTO_INDEX_REBUILD_IN_FLIGHT.delete(opts.repoRoot);
			}
		})();
		AUTO_INDEX_REBUILD_IN_FLIGHT.set(opts.repoRoot, inFlight);
	}
	await inFlight;
}

export type ContextSearchResult = {
	mode: "search";
	repo_root: string;
	query: string | null;
	count: number;
	total: number;
	items: Array<ContextItem & { score: number }>;
};

export type ContextTimelineResult = {
	mode: "timeline";
	repo_root: string;
	order: "asc" | "desc";
	count: number;
	total: number;
	items: ContextItem[];
};

export type ContextStatsResult = {
	mode: "stats";
	repo_root: string;
	total_count: number;
	total_text_bytes: number;
	sources: Array<{
		source_kind: ContextSourceKind;
		count: number;
		text_bytes: number;
		last_ts_ms: number;
	}>;
};

function contextUrlFromSearch(search: URLSearchParams): URL {
	const query = search.toString();
	return new URL(`http://mu.local/context${query.length > 0 ? `?${query}` : ""}`);
}

export async function runContextSearch(opts: {
	repoRoot: string;
	search: URLSearchParams;
	indexAutoRebuild?: ContextIndexAutoRebuildMode;
}): Promise<ContextSearchResult> {
	const filters = parseSearchFilters(contextUrlFromSearch(opts.search));
	await maybeAutoRebuildContextIndex({
		repoRoot: opts.repoRoot,
		mode: opts.indexAutoRebuild ?? "off",
	});
	const indexed = readContextSearchFromIndex({ repoRoot: opts.repoRoot, filters });
	if (indexed) {
		return indexed;
	}
	const items = await collectContextItems(opts.repoRoot, filters.sources);
	const ranked = searchContext(items, filters);
	const sliced = ranked.slice(0, filters.limit);
	return {
		mode: "search",
		repo_root: opts.repoRoot,
		query: filters.query,
		count: sliced.length,
		total: ranked.length,
		items: sliced,
	};
}

export async function runContextTimeline(opts: {
	repoRoot: string;
	search: URLSearchParams;
	indexAutoRebuild?: ContextIndexAutoRebuildMode;
}): Promise<ContextTimelineResult> {
	const filters = parseTimelineFilters(contextUrlFromSearch(opts.search));
	await maybeAutoRebuildContextIndex({
		repoRoot: opts.repoRoot,
		mode: opts.indexAutoRebuild ?? "off",
	});
	const indexed = readContextTimelineFromIndex({ repoRoot: opts.repoRoot, filters });
	if (indexed) {
		return indexed;
	}
	const items = await collectContextItems(opts.repoRoot, filters.sources);
	const timeline = timelineContext(items, filters);
	const sliced = timeline.slice(0, filters.limit);
	return {
		mode: "timeline",
		repo_root: opts.repoRoot,
		order: filters.order,
		count: sliced.length,
		total: timeline.length,
		items: sliced,
	};
}

export async function runContextStats(opts: {
	repoRoot: string;
	search: URLSearchParams;
	indexAutoRebuild?: ContextIndexAutoRebuildMode;
}): Promise<ContextStatsResult> {
	const filters = parseSearchFilters(contextUrlFromSearch(opts.search));
	await maybeAutoRebuildContextIndex({
		repoRoot: opts.repoRoot,
		mode: opts.indexAutoRebuild ?? "off",
	});
	const indexed = readContextStatsFromIndex({ repoRoot: opts.repoRoot, filters });
	if (indexed) {
		return indexed;
	}
	const items = await collectContextItems(opts.repoRoot, filters.sources);
	const filtered = items.filter((item) => matchSearchFilters(item, { ...filters, query: null }));
	const sources = buildSourceStats(filtered);
	return {
		mode: "stats",
		repo_root: opts.repoRoot,
		total_count: filtered.length,
		total_text_bytes: filtered.reduce((sum, item) => sum + item.text.length, 0),
		sources,
	};
}
