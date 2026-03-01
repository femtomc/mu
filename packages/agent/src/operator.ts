import { UiDocSchema, type UiDoc, normalizeUiDocs } from "@femtomc/mu-core";
import { appendJsonl, getStorePaths } from "@femtomc/mu-core/node";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CommandContextResolver } from "./command_context.js";
import { createMuSession, type CreateMuSessionOpts, type MuSession } from "./session_factory.js";
import { DEFAULT_OPERATOR_SYSTEM_PROMPT } from "./default_prompts.js";

export type MessagingOperatorInboundEnvelope = {
	channel: string;
	channel_tenant_id: string;
	channel_conversation_id: string;
	request_id: string;
	repo_root: string;
	command_text: string;
	target_type: string;
	target_id: string;
	metadata: Record<string, unknown>;
};

export type MessagingOperatorIdentityBinding = {
	binding_id: string;
	assurance_tier: string;
};

type InboundEnvelope = MessagingOperatorInboundEnvelope;
type IdentityBinding = MessagingOperatorIdentityBinding;

const OPERATOR_RESPONSE_MAX_CHARS = 12_000;
const OPERATOR_TURN_UI_DOCS_MAX = 16;
const SAFE_RESPONSE_RE = new RegExp(`^[\\s\\S]{1,${OPERATOR_RESPONSE_MAX_CHARS}}$`);
const OPERATOR_TIMEOUT_MIN_MS = 1_000;
const OPERATOR_TIMEOUT_HARD_CAP_MS = 10 * 60 * 1_000;

export const OperatorApprovedCommandSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("status") }),
	z.object({ kind: z.literal("ready") }),
	z.object({ kind: z.literal("issue_list") }),
	z.object({ kind: z.literal("issue_get"), issue_id: z.string().trim().min(1).optional() }),
	z.object({
		kind: z.literal("forum_read"),
		topic: z.string().trim().min(1).optional(),
		limit: z.number().int().min(1).max(500).optional(),
	}),
	z.object({ kind: z.literal("reload") }),
	z.object({ kind: z.literal("update") }),
	z.object({ kind: z.literal("operator_config_get") }),
	z.object({
		kind: z.literal("operator_model_list"),
		provider: z.string().trim().min(1).optional(),
	}),
	z.object({
		kind: z.literal("operator_thinking_list"),
		provider: z.string().trim().min(1).optional(),
		model: z.string().trim().min(1).optional(),
	}),
	z.object({
		kind: z.literal("operator_model_set"),
		provider: z.string().trim().min(1),
		model: z.string().trim().min(1),
		thinking: z.string().trim().min(1).optional(),
	}),
	z.object({
		kind: z.literal("operator_thinking_set"),
		thinking: z.string().trim().min(1),
	}),
]);
export type OperatorApprovedCommand = z.infer<typeof OperatorApprovedCommandSchema>;

const OperatorTurnUiDocsSchema = z.array(UiDocSchema).max(OPERATOR_TURN_UI_DOCS_MAX).optional();

export const OperatorBackendTurnResultSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("respond"),
		message: z.string().trim().min(1).max(OPERATOR_RESPONSE_MAX_CHARS),
		ui_docs: OperatorTurnUiDocsSchema,
	}),
	z.object({
		kind: z.literal("command"),
		command: OperatorApprovedCommandSchema,
		ui_docs: OperatorTurnUiDocsSchema,
	}),
]);
export type OperatorBackendTurnResult = z.infer<typeof OperatorBackendTurnResultSchema>;

export type OperatorBackendTurnInput = {
	sessionId: string;
	turnId: string;
	inbound: InboundEnvelope;
	binding: IdentityBinding;
};

export interface MessagingOperatorBackend {
	runTurn(input: OperatorBackendTurnInput): Promise<OperatorBackendTurnResult>;
	abortSession?(sessionId: string): Promise<boolean> | boolean;
	dispose?(): void | Promise<void>;
}

export type OperatorDecision =
	| {
			kind: "response";
			message: string;
			ui_docs?: UiDoc[];
			operatorSessionId: string;
			operatorTurnId: string;
	  }
	| {
			kind: "command";
			commandText: string;
			ui_docs?: UiDoc[];
			operatorSessionId: string;
			operatorTurnId: string;
	  }
	| {
			kind: "reject";
			reason:
				| "operator_disabled"
				| "operator_action_disallowed"
				| "operator_invalid_output"
				| "operator_cancelled"
				| "context_missing"
				| "context_ambiguous"
				| "context_unauthorized"
				| "cli_validation_failed";
			details?: string;
			operatorSessionId: string;
			operatorTurnId: string;
	  };

export type ApprovedCommandBrokerOpts = {
	contextResolver?: CommandContextResolver;
};

function normalizeArg(arg: string): string {
	return arg.trim();
}

export class ApprovedCommandBroker {
	readonly #contextResolver: CommandContextResolver;

	public constructor(opts: ApprovedCommandBrokerOpts = {}) {
		this.#contextResolver = opts.contextResolver ?? new CommandContextResolver();
	}

	public approve(opts: { proposal: OperatorApprovedCommand; inbound: InboundEnvelope }):
		| {
				kind: "approved";
				commandText: string;
		  }
		| {
				kind: "reject";
				reason:
					| "operator_action_disallowed"
					| "context_missing"
					| "context_ambiguous"
					| "context_unauthorized"
					| "cli_validation_failed";
				details?: string;
		  } {
		let commandKey: string;
		let args: string[];

		switch (opts.proposal.kind) {
			case "status":
				commandKey = "status";
				args = [];
				break;
			case "ready":
				commandKey = "ready";
				args = [];
				break;
			case "issue_list":
				commandKey = "issue list";
				args = [];
				break;
			case "issue_get":
				commandKey = "issue get";
				args = opts.proposal.issue_id ? [normalizeArg(opts.proposal.issue_id)] : [];
				break;
			case "forum_read": {
				commandKey = "forum read";
				args = [];
				if (opts.proposal.topic) {
					args.push(normalizeArg(opts.proposal.topic));
				}
				if (opts.proposal.limit != null) {
					args.push(String(Math.trunc(opts.proposal.limit)));
				}
				break;
			}
			case "reload": {
				commandKey = "reload";
				args = [];
				break;
			}
			case "update": {
				commandKey = "update";
				args = [];
				break;
			}
			case "operator_config_get": {
				commandKey = "operator config get";
				args = [];
				break;
			}
			case "operator_model_list": {
				commandKey = "operator model list";
				args = [];
				if (opts.proposal.provider) {
					args.push(normalizeArg(opts.proposal.provider));
				}
				break;
			}
			case "operator_thinking_list": {
				commandKey = "operator thinking list";
				args = [];
				if (opts.proposal.provider) {
					args.push(normalizeArg(opts.proposal.provider));
				}
				if (opts.proposal.model) {
					args.push(normalizeArg(opts.proposal.model));
				}
				break;
			}
			case "operator_model_set": {
				commandKey = "operator model set";
				args = [normalizeArg(opts.proposal.provider), normalizeArg(opts.proposal.model)];
				if (opts.proposal.thinking) {
					args.push(normalizeArg(opts.proposal.thinking));
				}
				break;
			}
			case "operator_thinking_set": {
				commandKey = "operator thinking set";
				args = [normalizeArg(opts.proposal.thinking)];
				break;
			}
			default:
				return { kind: "reject", reason: "operator_action_disallowed" };
		}

		const resolved = this.#contextResolver.resolve({
			repoRoot: opts.inbound.repo_root,
			commandKey,
			args,
			inboundTargetType: opts.inbound.target_type,
			inboundTargetId: opts.inbound.target_id,
			metadata: opts.inbound.metadata,
		});

		if (resolved.kind === "reject") {
			return {
				kind: "reject",
				reason: resolved.reason,
				details: resolved.details,
			};
		}

		return {
			kind: "approved",
			commandText: `/mu ${resolved.normalizedText}`,
		};
	}
}

export type MessagingOperatorConversationSessionStore = {
	getSessionId: (conversationKey: string) => Promise<string | null> | string | null;
	setSessionId: (conversationKey: string, sessionId: string) => Promise<void> | void;
	stop?: () => Promise<void> | void;
};

export type MessagingOperatorRuntimeOpts = {
	backend: MessagingOperatorBackend;
	broker?: ApprovedCommandBroker;
	enabled?: boolean;
	enabledChannels?: readonly string[];
	sessionIdFactory?: () => string;
	turnIdFactory?: () => string;
	conversationSessionStore?: MessagingOperatorConversationSessionStore;
};

function defaultSessionId(): string {
	return `operator-${crypto.randomUUID()}`;
}

function defaultTurnId(): string {
	return `turn-${crypto.randomUUID()}`;
}

function buildOperatorFailureFallbackMessage(code: string): string {
	const reasonLine =
		code === "operator_timeout"
			? "The operator turn exceeded the messaging timeout before a safe response was produced."
			: code === "operator_busy"
				? "Another operator turn is already in progress for this conversation."
				: code === "operator_empty_response"
					? "The operator completed without a usable response payload."
					: code === "operator_cancelled"
						? "The operator turn was cancelled before completion."
						: "An internal operator runtime/formatting error interrupted the turn.";
	return [
		"I could not complete that turn safely.",
		`Code: ${code}`,
		reasonLine,
		"You can retry this request in plain conversational text.",
	].join("\n");
}

function classifyBackendFailureCode(err: unknown): string {
	if (!(err instanceof Error)) {
		return "operator_backend_error";
	}
	const message = err.message.trim().toLowerCase();
	if (message.includes("pi operator timeout") || message.includes("operator timeout")) {
		return "operator_timeout";
	}
	if (message.includes("operator_empty_response")) {
		return "operator_empty_response";
	}
	if (message.includes("agent is already processing")) {
		return "operator_busy";
	}
	if (message.includes("aborted") || message.includes("cancelled")) {
		return "operator_cancelled";
	}
	return "operator_backend_error";
}

function parseOperatorControlDirective(commandText: string): "cancel" | null {
	const normalized = commandText.trim().toLowerCase();
	if (normalized === "cancel" || normalized === "abort" || normalized === "/mu cancel" || normalized === "/mu abort") {
		return "cancel";
	}
	return null;
}

function isAgentBusyError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	const text = err.message.trim().toLowerCase();
	return text.includes("agent is already processing");
}

function slackThreadScope(inbound: InboundEnvelope): string | null {
	if (inbound.channel !== "slack") {
		return null;
	}
	const metadata = inbound.metadata;
	const candidate = [metadata.slack_thread_ts, metadata.slack_message_ts, metadata.thread_ts].find(
		(value) => typeof value === "string" && value.trim().length > 0,
	);
	if (typeof candidate !== "string") {
		return null;
	}
	return candidate.trim();
}

function conversationKey(inbound: InboundEnvelope, binding: IdentityBinding): string {
	const base = `${inbound.channel}:${inbound.channel_tenant_id}:${inbound.channel_conversation_id}:${binding.binding_id}`;
	const slackThread = slackThreadScope(inbound);
	if (!slackThread) {
		return base;
	}
	return `${base}:thread:${slackThread}`;
}

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

function autonomousTurnEnvironment(metadata: Record<string, unknown>): Record<string, string> {
	const source = nonEmptyString(metadata.source);
	if (source !== "autonomous_ingress") {
		return {};
	}
	const out: Record<string, string> = {
		MU_AUTONOMOUS_INGRESS_SOURCE: source,
	};
	const wakeSource = nonEmptyString(metadata.wake_source);
	const wakeId = nonEmptyString(metadata.wake_id);
	const programId = nonEmptyString(metadata.program_id);
	const sourceTsMs = metadata.source_ts_ms;
	if (wakeSource) {
		out.MU_AUTONOMOUS_WAKE_SOURCE = wakeSource;
	}
	if (wakeId) {
		out.MU_AUTONOMOUS_WAKE_ID = wakeId;
	}
	if (programId) {
		out.MU_AUTONOMOUS_PROGRAM_ID = programId;
	}
	if (typeof sourceTsMs === "number" && Number.isFinite(sourceTsMs)) {
		out.MU_AUTONOMOUS_SOURCE_TS_MS = String(Math.trunc(sourceTsMs));
	}
	return out;
}

function isUiToolName(toolName: string): boolean {
	const normalized = toolName.trim().toLowerCase();
	return normalized === "mu_ui";
}

function extractUiDocsFromToolResult(result: unknown): UiDoc[] {
	const rec = asRecord(result);
	if (!rec) {
		return [];
	}
	const details = asRecord(rec.details);
	const candidates: unknown[] = [];

	const topLevelUiDocs = rec.ui_docs;
	if (Array.isArray(topLevelUiDocs)) {
		candidates.push(...topLevelUiDocs);
	}

	if (details) {
		const detailUiDocs = details.ui_docs;
		if (Array.isArray(detailUiDocs)) {
			candidates.push(...detailUiDocs);
		}
	}

	return normalizeUiDocs(candidates, { maxDocs: OPERATOR_TURN_UI_DOCS_MAX });
}

function collectUiDocsFromToolExecutionEvent(event: unknown): UiDoc[] {
	const rec = asRecord(event);
	if (!rec) {
		return [];
	}
	if (nonEmptyString(rec.type) !== "tool_execution_end") {
		return [];
	}
	const toolName = nonEmptyString(rec.toolName);
	if (!toolName || !isUiToolName(toolName)) {
		return [];
	}
	return extractUiDocsFromToolResult(rec.result);
}

type PersistedConversationSessionState = {
	version: 1;
	bindings: Record<string, string>;
};

export class JsonFileConversationSessionStore implements MessagingOperatorConversationSessionStore {
	readonly #path: string;
	#loaded = false;
	readonly #bindings = new Map<string, string>();
	#persistQueue: Promise<void> = Promise.resolve();

	public constructor(path: string) {
		this.#path = path;
	}

	async #load(): Promise<void> {
		if (this.#loaded) {
			return;
		}
		this.#loaded = true;

		let raw = "";
		try {
			raw = await readFile(this.#path, "utf8");
		} catch {
			return;
		}
		if (!raw.trim()) {
			return;
		}

		try {
			const parsed = JSON.parse(raw) as PersistedConversationSessionState;
			const bindings = parsed?.bindings;
			if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
				return;
			}
			for (const [key, value] of Object.entries(bindings)) {
				if (typeof key === "string" && key.length > 0 && typeof value === "string" && value.length > 0) {
					this.#bindings.set(key, value);
				}
			}
		} catch {
			// Ignore malformed persistence snapshots.
		}
	}

	async #persist(): Promise<void> {
		const snapshot: PersistedConversationSessionState = {
			version: 1,
			bindings: Object.fromEntries([...this.#bindings.entries()].sort(([a], [b]) => a.localeCompare(b))),
		};
		await mkdir(dirname(this.#path), { recursive: true });
		const tempPath = `${this.#path}.tmp-${process.pid}-${crypto.randomUUID()}`;
		await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
		await rename(tempPath, this.#path);
	}

	async #persistSoon(): Promise<void> {
		const runPersist = async () => {
			await this.#persist();
		};
		this.#persistQueue = this.#persistQueue.then(runPersist, runPersist);
		await this.#persistQueue;
	}

	public async getSessionId(conversationKey: string): Promise<string | null> {
		await this.#load();
		return this.#bindings.get(conversationKey) ?? null;
	}

	public async setSessionId(conversationKey: string, sessionId: string): Promise<void> {
		await this.#load();
		const current = this.#bindings.get(conversationKey);
		if (current === sessionId) {
			return;
		}
		this.#bindings.set(conversationKey, sessionId);
		await this.#persistSoon();
	}

	public async stop(): Promise<void> {
		await this.#persistQueue;
	}
}

export class MessagingOperatorRuntime {
	readonly #backend: MessagingOperatorBackend;
	readonly #broker: ApprovedCommandBroker;
	readonly #enabled: boolean;
	readonly #enabledChannels: Set<string> | null;
	readonly #sessionIdFactory: () => string;
	readonly #turnIdFactory: () => string;
	readonly #conversationSessionStore: MessagingOperatorConversationSessionStore | null;
	readonly #sessionByConversation = new Map<string, string>();
	readonly #suppressedCancelledTurnsBySession = new Map<string, number>();

	public constructor(opts: MessagingOperatorRuntimeOpts) {
		this.#backend = opts.backend;
		this.#broker = opts.broker ?? new ApprovedCommandBroker();
		this.#enabled = opts.enabled ?? true;
		this.#enabledChannels = opts.enabledChannels ? new Set(opts.enabledChannels.map((v) => v.toLowerCase())) : null;
		this.#sessionIdFactory = opts.sessionIdFactory ?? defaultSessionId;
		this.#turnIdFactory = opts.turnIdFactory ?? defaultTurnId;
		this.#conversationSessionStore = opts.conversationSessionStore ?? null;
	}

	async #resolveSessionId(inbound: InboundEnvelope, binding: IdentityBinding): Promise<string> {
		const key = conversationKey(inbound, binding);
		const existing = this.#sessionByConversation.get(key);
		if (existing) {
			return existing;
		}

		if (this.#conversationSessionStore) {
			try {
				const persisted = await this.#conversationSessionStore.getSessionId(key);
				if (persisted && persisted.length > 0) {
					this.#sessionByConversation.set(key, persisted);
					return persisted;
				}
			} catch {
				// Non-fatal persistence lookup failure.
			}
		}

		const created = this.#sessionIdFactory();
		this.#sessionByConversation.set(key, created);
		if (this.#conversationSessionStore) {
			try {
				await this.#conversationSessionStore.setSessionId(key, created);
			} catch {
				// Non-fatal persistence write failure.
			}
		}
		return created;
	}

	#markSuppressedCancelledTurn(sessionId: string): void {
		const next = (this.#suppressedCancelledTurnsBySession.get(sessionId) ?? 0) + 1;
		this.#suppressedCancelledTurnsBySession.set(sessionId, next);
	}

	#consumeSuppressedCancelledTurn(sessionId: string): boolean {
		const current = this.#suppressedCancelledTurnsBySession.get(sessionId) ?? 0;
		if (current <= 0) {
			return false;
		}
		if (current === 1) {
			this.#suppressedCancelledTurnsBySession.delete(sessionId);
			return true;
		}
		this.#suppressedCancelledTurnsBySession.set(sessionId, current - 1);
		return true;
	}

	public async handleInbound(opts: { inbound: InboundEnvelope; binding: IdentityBinding }): Promise<OperatorDecision> {
		const sessionId = await this.#resolveSessionId(opts.inbound, opts.binding);
		const turnId = this.#turnIdFactory();

		if (!this.#enabled) {
			return {
				kind: "reject",
				reason: "operator_disabled",
				operatorSessionId: sessionId,
				operatorTurnId: turnId,
			};
		}
		if (this.#enabledChannels && !this.#enabledChannels.has(opts.inbound.channel.toLowerCase())) {
			return {
				kind: "reject",
				reason: "operator_disabled",
				operatorSessionId: sessionId,
				operatorTurnId: turnId,
			};
		}

		const controlDirective = parseOperatorControlDirective(opts.inbound.command_text);
		if (controlDirective === "cancel") {
			const aborted = (await this.#backend.abortSession?.(sessionId)) ?? false;
			if (aborted) {
				this.#markSuppressedCancelledTurn(sessionId);
			}
			return {
				kind: "response",
				message: aborted
					? "Cancelled the in-flight operator turn for this conversation."
					: "No in-flight operator turn is active for this conversation.",
				operatorSessionId: sessionId,
				operatorTurnId: turnId,
			};
		}

		let backendResult: OperatorBackendTurnResult;
		try {
			backendResult = OperatorBackendTurnResultSchema.parse(
				await this.#backend.runTurn({
					sessionId,
					turnId,
					inbound: opts.inbound,
					binding: opts.binding,
				}),
			);
		} catch (err) {
			const failureCode = classifyBackendFailureCode(err);
			if (failureCode === "operator_cancelled" && this.#consumeSuppressedCancelledTurn(sessionId)) {
				return {
					kind: "reject",
					reason: "operator_cancelled",
					operatorSessionId: sessionId,
					operatorTurnId: turnId,
				};
			}
			return {
				kind: "response",
				message: buildOperatorFailureFallbackMessage(failureCode),
				operatorSessionId: sessionId,
				operatorTurnId: turnId,
			};
		}

		if (backendResult.kind === "respond") {
			const message = backendResult.message.trim();
			if (!SAFE_RESPONSE_RE.test(message)) {
				return {
					kind: "response",
					message: buildOperatorFailureFallbackMessage("operator_invalid_response_payload"),
					operatorSessionId: sessionId,
					operatorTurnId: turnId,
				};
			}
			const docPayload: { ui_docs?: UiDoc[] } = {};
			if (backendResult.ui_docs && backendResult.ui_docs.length > 0) {
				docPayload.ui_docs = backendResult.ui_docs;
			}
			return {
				kind: "response",
				message,
				...docPayload,
				operatorSessionId: sessionId,
				operatorTurnId: turnId,
			};
		}

		const approved = this.#broker.approve({
			proposal: backendResult.command,
			inbound: opts.inbound,
		});
		if (approved.kind === "reject") {
			return {
				kind: "reject",
				reason: approved.reason,
				details: approved.details,
				operatorSessionId: sessionId,
				operatorTurnId: turnId,
			};
		}

		const docPayload: { ui_docs?: UiDoc[] } = {};
		if (backendResult.ui_docs && backendResult.ui_docs.length > 0) {
			docPayload.ui_docs = backendResult.ui_docs;
		}
		return {
			kind: "command",
			commandText: approved.commandText,
			...docPayload,
			operatorSessionId: sessionId,
			operatorTurnId: turnId,
		};
	}

	public async stop(): Promise<void> {
		this.#sessionByConversation.clear();
		this.#suppressedCancelledTurnsBySession.clear();
		await this.#backend.dispose?.();
		await this.#conversationSessionStore?.stop?.();
	}
}

export type PiMessagingOperatorBackendOpts = {
	provider?: string;
	model?: string;
	thinking?: string;
	systemPrompt?: string;
	timeoutMs?: number;
	extensionPaths?: string[];
	sessionFactory?: (opts: CreateMuSessionOpts) => Promise<MuSession>;
	nowMs?: () => number;
	sessionIdleTtlMs?: number;
	maxSessions?: number;
	auditTurns?: boolean;
	persistSessions?: boolean;
	sessionDirForRepoRoot?: (repoRoot: string) => string;
};

export { DEFAULT_OPERATOR_SYSTEM_PROMPT };

const COMMAND_TOOL_NAME = "command";
const OPERATOR_PROMPT_CONTEXT_MAX_CHARS = 2_500;

function compactJsonPreview(value: unknown, maxChars: number = OPERATOR_PROMPT_CONTEXT_MAX_CHARS): string | null {
	let raw = "";
	if (typeof value === "string") {
		raw = value;
	} else {
		try {
			raw = JSON.stringify(value);
		} catch {
			return null;
		}
	}
	const compact = raw.replace(/\s+/g, " ").trim();
	if (compact.length === 0) {
		return null;
	}
	if (compact.length <= maxChars) {
		return compact;
	}
	const keep = Math.max(1, maxChars - 1);
	return `${compact.slice(0, keep)}…`;
}

function extractPromptContext(metadata: Record<string, unknown>): unknown | null {
	for (const key of ["client_context", "context", "editor_context"] as const) {
		if (!(key in metadata)) {
			continue;
		}
		const value = metadata[key];
		if (value == null) {
			continue;
		}
		if (typeof value === "object" || typeof value === "string") {
			return value;
		}
	}
	return null;
}

function buildOperatorPromptContextBlock(metadata: Record<string, unknown>): string[] {
	const context = extractPromptContext(metadata);
	if (!context) {
		return [];
	}
	const preview = compactJsonPreview(context);
	if (!preview) {
		return [];
	}
	return ["", "Client context (structured preview):", preview];
}

function buildOperatorPrompt(input: OperatorBackendTurnInput): string {
	const lines = [
		`[Messaging context]`,
		`channel: ${input.inbound.channel}`,
		`request_id: ${input.inbound.request_id}`,
		`repo_root: ${input.inbound.repo_root}`,
		``,
		`User message: ${input.inbound.command_text}`,
		...buildOperatorPromptContextBlock(input.inbound.metadata),
	];
	return lines.join("\n");
}

function sessionFileStem(sessionId: string): string {
	const normalized = sessionId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
	const compact = normalized.replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
	return compact.length > 0 ? compact : `operator-${crypto.randomUUID()}`;
}

type PiOperatorSessionRecord = {
	session: MuSession;
	repoRoot: string;
	createdAtMs: number;
	lastUsedAtMs: number;
};

type OperatorTurnAuditEntry = {
	kind: "operator.turn";
	ts_ms: number;
	repo_root: string;
	channel: string;
	request_id: string;
	session_id: string;
	turn_id: string;
	outcome: "respond" | "command" | "invalid_directive" | "error";
	reason: string | null;
	message_preview: string | null;
	command: OperatorApprovedCommand | null;
};

export class PiMessagingOperatorBackend implements MessagingOperatorBackend {
	readonly #provider: string | undefined;
	readonly #model: string | undefined;
	readonly #thinking: string;
	readonly #systemPrompt: string;
	readonly #timeoutMs: number;
	readonly #extensionPaths: string[];
	readonly #sessionFactory: (opts: CreateMuSessionOpts) => Promise<MuSession>;
	readonly #nowMs: () => number;
	readonly #sessionIdleTtlMs: number;
	readonly #maxSessions: number;
	readonly #auditTurns: boolean;
	readonly #persistSessions: boolean;
	readonly #sessionDirForRepoRoot: (repoRoot: string) => string;
	readonly #sessions = new Map<string, PiOperatorSessionRecord>();
	readonly #activePromptCountsBySession = new Map<string, number>();
	readonly #autonomousTurnEnvBySession = new Map<string, Record<string, string>>();

	public constructor(opts: PiMessagingOperatorBackendOpts = {}) {
		this.#provider = opts.provider;
		this.#model = opts.model;
		this.#thinking = opts.thinking ?? "minimal";
		this.#systemPrompt = opts.systemPrompt ?? DEFAULT_OPERATOR_SYSTEM_PROMPT;
		const requestedTimeoutMs = Math.max(OPERATOR_TIMEOUT_MIN_MS, Math.trunc(opts.timeoutMs ?? 90_000));
		this.#timeoutMs = Math.min(requestedTimeoutMs, OPERATOR_TIMEOUT_HARD_CAP_MS);
		this.#extensionPaths = opts.extensionPaths ?? [];
		this.#sessionFactory = opts.sessionFactory ?? createMuSession;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#sessionIdleTtlMs = Math.max(60_000, Math.trunc(opts.sessionIdleTtlMs ?? 30 * 60 * 1_000));
		this.#maxSessions = Math.max(1, Math.trunc(opts.maxSessions ?? 32));
		this.#auditTurns = opts.auditTurns ?? true;
		this.#persistSessions = opts.persistSessions ?? true;
		this.#sessionDirForRepoRoot =
			opts.sessionDirForRepoRoot ??
			((repoRoot) => join(getStorePaths(repoRoot).storeDir, "control-plane", "operator-sessions"));

		// Operator turns can emit structured command proposals captured from tool events.
	}

	#disposeSession(sessionId: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) {
			return;
		}
		this.#sessions.delete(sessionId);
		this.#activePromptCountsBySession.delete(sessionId);
		this.#autonomousTurnEnvBySession.delete(sessionId);
		try {
			entry.session.dispose();
		} catch {
			// Best effort cleanup.
		}
	}

	#pruneSessions(nowMs: number): void {
		for (const [sessionId, entry] of this.#sessions.entries()) {
			if (nowMs - entry.lastUsedAtMs > this.#sessionIdleTtlMs) {
				this.#disposeSession(sessionId);
			}
		}

		if (this.#sessions.size <= this.#maxSessions) {
			return;
		}

		const byOldestUse = [...this.#sessions.entries()].sort((a, b) => a[1].lastUsedAtMs - b[1].lastUsedAtMs);
		while (this.#sessions.size > this.#maxSessions && byOldestUse.length > 0) {
			const [sessionId] = byOldestUse.shift()!;
			this.#disposeSession(sessionId);
		}
	}

	#incrementActivePrompt(sessionId: string): void {
		const next = (this.#activePromptCountsBySession.get(sessionId) ?? 0) + 1;
		this.#activePromptCountsBySession.set(sessionId, next);
	}

	#decrementActivePrompt(sessionId: string): void {
		const current = this.#activePromptCountsBySession.get(sessionId) ?? 0;
		if (current <= 1) {
			this.#activePromptCountsBySession.delete(sessionId);
			return;
		}
		this.#activePromptCountsBySession.set(sessionId, current - 1);
	}

	#sessionPersistence(repoRoot: string, sessionId: string): CreateMuSessionOpts["session"] | undefined {
		if (!this.#persistSessions) {
			return undefined;
		}
		const sessionDir = this.#sessionDirForRepoRoot(repoRoot);
		const sessionFile = join(sessionDir, `${sessionFileStem(sessionId)}.jsonl`);
		return {
			mode: "open",
			sessionDir,
			sessionFile,
		};
	}

	async #createSession(repoRoot: string, sessionId: string, nowMs: number): Promise<PiOperatorSessionRecord> {
		const session = await this.#sessionFactory({
			cwd: repoRoot,
			systemPrompt: this.#systemPrompt,
			provider: this.#provider,
			model: this.#model,
			thinking: this.#thinking,
			extensionPaths: this.#extensionPaths,
			session: this.#sessionPersistence(repoRoot, sessionId),
			bashToolOptions: {
				spawnHook: (context) => {
					const turnEnv = this.#autonomousTurnEnvBySession.get(sessionId);
					if (!turnEnv || Object.keys(turnEnv).length === 0) {
						return context;
					}
					return {
						...context,
						env: {
							...context.env,
							...turnEnv,
						},
					};
				},
			},
		});

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

		return {
			session,
			repoRoot,
			createdAtMs: nowMs,
			lastUsedAtMs: nowMs,
		};
	}

	async #resolveSession(sessionId: string, repoRoot: string): Promise<PiOperatorSessionRecord> {
		const nowMs = Math.trunc(this.#nowMs());
		this.#pruneSessions(nowMs);

		const existing = this.#sessions.get(sessionId);
		if (existing && existing.repoRoot === repoRoot) {
			existing.lastUsedAtMs = nowMs;
			return existing;
		}
		if (existing && existing.repoRoot !== repoRoot) {
			this.#disposeSession(sessionId);
		}

		const created = await this.#createSession(repoRoot, sessionId, nowMs);
		this.#sessions.set(sessionId, created);
		this.#pruneSessions(nowMs);
		return created;
	}

	async #auditTurn(
		input: OperatorBackendTurnInput,
		opts: {
			outcome: OperatorTurnAuditEntry["outcome"];
			reason?: string | null;
			messagePreview?: string | null;
			command?: OperatorApprovedCommand | null;
		},
	): Promise<void> {
		if (!this.#auditTurns) {
			return;
		}
		const entry: OperatorTurnAuditEntry = {
			kind: "operator.turn",
			ts_ms: Math.trunc(this.#nowMs()),
			repo_root: input.inbound.repo_root,
			channel: input.inbound.channel,
			request_id: input.inbound.request_id,
			session_id: input.sessionId,
			turn_id: input.turnId,
			outcome: opts.outcome,
			reason: opts.reason ?? null,
			message_preview: opts.messagePreview?.slice(0, 280) ?? null,
			command: opts.command ?? null,
		};
		try {
			const path = join(getStorePaths(input.inbound.repo_root).storeDir, "control-plane", "operator_turns.jsonl");
			await appendJsonl(path, entry);
		} catch {
			// best effort audit
		}
	}

	public async abortSession(sessionId: string): Promise<boolean> {
		const activeCount = this.#activePromptCountsBySession.get(sessionId) ?? 0;
		if (activeCount <= 0) {
			return false;
		}
		const record = this.#sessions.get(sessionId);
		if (!record) {
			return false;
		}
		const abortFn = (record.session as MuSession & { abort?: () => Promise<void> }).abort;
		if (!abortFn) {
			return false;
		}
		try {
			await abortFn.call(record.session);
			return true;
		} catch {
			return false;
		}
	}

	public async runTurn(input: OperatorBackendTurnInput): Promise<OperatorBackendTurnResult> {
		const sessionRecord = await this.#resolveSession(input.sessionId, input.inbound.repo_root);
		const session = sessionRecord.session;

		let assistantText = "";
		let capturedCommand: OperatorApprovedCommand | null = null;
		let capturedUiDocs: UiDoc[] = [];

		const turnEnv = autonomousTurnEnvironment(input.inbound.metadata);
		if (Object.keys(turnEnv).length > 0) {
			this.#autonomousTurnEnvBySession.set(input.sessionId, turnEnv);
		} else {
			this.#autonomousTurnEnvBySession.delete(input.sessionId);
		}

		const unsub = session.subscribe((event: any) => {
			// Capture assistant text for fallback responses.
			if (event?.type === "message_end" && event?.message?.role === "assistant") {
				const msg = event.message;
				if (typeof msg.text === "string") {
					assistantText = msg.text;
				} else if (typeof msg.content === "string") {
					assistantText = msg.content;
				} else if (Array.isArray(msg.content)) {
					const parts: string[] = [];
					for (const item of msg.content) {
						const t = typeof item === "string" ? item : item?.text;
						if (typeof t === "string" && t.trim().length > 0) parts.push(t);
					}
					if (parts.length > 0) assistantText = parts.join("\n");
				}
			}

			// Capture command tool calls — structured command proposals.
			if (event?.type === "tool_execution_start" && event?.toolName === COMMAND_TOOL_NAME) {
				const parsed = OperatorApprovedCommandSchema.safeParse(event.args);
				if (parsed.success) {
					capturedCommand = parsed.data;
				}
			}

			const uiDocs = collectUiDocsFromToolExecutionEvent(event);
			if (uiDocs.length > 0) {
				capturedUiDocs = normalizeUiDocs([...capturedUiDocs, ...uiDocs], {
					maxDocs: OPERATOR_TURN_UI_DOCS_MAX,
				});
			}
		});

		const promptText = buildOperatorPrompt(input);
		const promptOnce = async (): Promise<void> => {
			let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					const abortFn = (session as MuSession & { abort?: () => Promise<void> }).abort;
					if (abortFn) {
						void abortFn.call(session).catch(() => {
							// Best effort abort on timeout.
						});
					}
					reject(new Error("pi operator timeout"));
				}, this.#timeoutMs);
			});
			try {
				await Promise.race([session.prompt(promptText, { expandPromptTemplates: false }), timeoutPromise]);
			} finally {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
					timeoutHandle = null;
				}
			}
		};

		this.#incrementActivePrompt(input.sessionId);
		try {
			try {
				await promptOnce();
			} catch (err) {
				if (!isAgentBusyError(err)) {
					throw err;
				}
				await session.agent.waitForIdle();
				assistantText = "";
				capturedCommand = null;
				await promptOnce();
			}
		} catch (err) {
			await this.#auditTurn(input, {
				outcome: "error",
				reason: err instanceof Error ? err.message : "operator_backend_error",
				messagePreview: assistantText,
			});
			throw err;
		} finally {
			this.#decrementActivePrompt(input.sessionId);
			this.#autonomousTurnEnvBySession.delete(input.sessionId);
			unsub();
			sessionRecord.lastUsedAtMs = Math.trunc(this.#nowMs());
		}

		// If the operator called command, use the captured structured command.
		if (capturedCommand) {
			await this.#auditTurn(input, {
				outcome: "command",
				command: capturedCommand,
				messagePreview: assistantText,
			});
			const docPayload: { ui_docs?: UiDoc[] } = {};
			if (capturedUiDocs.length > 0) {
				docPayload.ui_docs = capturedUiDocs;
			}
			return { kind: "command", command: capturedCommand, ...docPayload };
		}

		// Otherwise treat the assistant text as a plain response.
		const message = assistantText.trim();
		if (!message) {
			await this.#auditTurn(input, {
				outcome: "error",
				reason: "operator_empty_response",
			});
			throw new Error("operator_empty_response");
		}

		const responseMessage = message.slice(0, OPERATOR_RESPONSE_MAX_CHARS);
		await this.#auditTurn(input, {
			outcome: "respond",
			messagePreview: responseMessage,
		});
		const docPayload: { ui_docs?: UiDoc[] } = {};
		if (capturedUiDocs.length > 0) {
			docPayload.ui_docs = capturedUiDocs;
		}
		return { kind: "respond", message: responseMessage, ...docPayload };
	}

	public dispose(): void {
		for (const sessionId of [...this.#sessions.keys()]) {
			this.#disposeSession(sessionId);
		}
	}
}
