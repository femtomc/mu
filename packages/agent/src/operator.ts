import { appendJsonl } from "@femtomc/mu-core/node";
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

const SAFE_RESPONSE_RE = /^[\s\S]{1,2000}$/;

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
	z.object({ kind: z.literal("run_list") }),
	z.object({
		kind: z.literal("run_status"),
		root_issue_id: z.string().trim().min(1).optional(),
	}),
	z.object({
		kind: z.literal("run_resume"),
		root_issue_id: z.string().trim().min(1).optional(),
		max_steps: z.number().int().min(1).max(500).optional(),
	}),
	z.object({
		kind: z.literal("run_interrupt"),
		root_issue_id: z.string().trim().min(1).optional(),
	}),
	z.object({ kind: z.literal("reload") }),
	z.object({ kind: z.literal("update") }),
	z.object({
		kind: z.literal("run_start"),
		prompt: z.string().trim().min(1),
		max_steps: z.number().int().min(1).max(500).optional(),
	}),
]);
export type OperatorApprovedCommand = z.infer<typeof OperatorApprovedCommandSchema>;

export const OperatorBackendTurnResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("respond"), message: z.string().trim().min(1).max(2000) }),
	z.object({ kind: z.literal("command"), command: OperatorApprovedCommandSchema }),
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
	dispose?(): void | Promise<void>;
}

export type OperatorDecision =
	| {
			kind: "response";
			message: string;
			operatorSessionId: string;
			operatorTurnId: string;
	  }
	| {
			kind: "command";
			commandText: string;
			operatorSessionId: string;
			operatorTurnId: string;
	  }
	| {
			kind: "reject";
			reason:
				| "operator_disabled"
				| "operator_action_disallowed"
				| "operator_invalid_output"
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
	runTriggersEnabled?: boolean;
};

function splitPromptIntoTokens(prompt: string): string[] {
	return prompt
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function normalizeArg(arg: string): string {
	return arg.trim();
}

export class ApprovedCommandBroker {
	readonly #contextResolver: CommandContextResolver;
	readonly #runTriggersEnabled: boolean;

	public constructor(opts: ApprovedCommandBrokerOpts = {}) {
		this.#contextResolver = opts.contextResolver ?? new CommandContextResolver();
		this.#runTriggersEnabled = opts.runTriggersEnabled ?? true;
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
			case "run_list":
				commandKey = "run list";
				args = [];
				break;
			case "run_status":
				commandKey = "run status";
				args = [];
				if (opts.proposal.root_issue_id) {
					args.push(normalizeArg(opts.proposal.root_issue_id));
				}
				break;
			case "run_resume": {
				if (!this.#runTriggersEnabled) {
					return { kind: "reject", reason: "operator_action_disallowed", details: "run triggers disabled" };
				}
				commandKey = "run resume";
				args = [];
				if (opts.proposal.root_issue_id) {
					args.push(normalizeArg(opts.proposal.root_issue_id));
				}
				if (opts.proposal.max_steps != null) {
					args.push(String(Math.trunc(opts.proposal.max_steps)));
				}
				break;
			}
			case "run_interrupt": {
				if (!this.#runTriggersEnabled) {
					return { kind: "reject", reason: "operator_action_disallowed", details: "run triggers disabled" };
				}
				commandKey = "run interrupt";
				args = [];
				if (opts.proposal.root_issue_id) {
					args.push(normalizeArg(opts.proposal.root_issue_id));
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
			case "run_start": {
				if (!this.#runTriggersEnabled) {
					return { kind: "reject", reason: "operator_action_disallowed", details: "run triggers disabled" };
				}
				commandKey = "run start";
				args = splitPromptIntoTokens(opts.proposal.prompt);
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
	return [
		"I ran into an internal operator formatting/runtime issue and could not complete that turn safely.",
		`Code: ${code}`,
		"You can retry, or use an explicit /mu command (for example: /mu status or /mu run list).",
	].join("\n");
}

function conversationKey(inbound: InboundEnvelope, binding: IdentityBinding): string {
	return `${inbound.channel}:${inbound.channel_tenant_id}:${inbound.channel_conversation_id}:${binding.binding_id}`;
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
			return {
				kind: "response",
				message: buildOperatorFailureFallbackMessage("operator_backend_error"),
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
			return {
				kind: "response",
				message,
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

		return {
			kind: "command",
			commandText: approved.commandText,
			operatorSessionId: sessionId,
			operatorTurnId: turnId,
		};
	}

	public async stop(): Promise<void> {
		this.#sessionByConversation.clear();
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

function buildOperatorPrompt(input: OperatorBackendTurnInput): string {
	return [
		`[Messaging context]`,
		`channel: ${input.inbound.channel}`,
		`request_id: ${input.inbound.request_id}`,
		`repo_root: ${input.inbound.repo_root}`,
		``,
		`User message: ${input.inbound.command_text}`,
	].join("\n");
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

	public constructor(opts: PiMessagingOperatorBackendOpts = {}) {
		this.#provider = opts.provider;
		this.#model = opts.model;
		this.#thinking = opts.thinking ?? "minimal";
		this.#systemPrompt = opts.systemPrompt ?? DEFAULT_OPERATOR_SYSTEM_PROMPT;
		this.#timeoutMs = Math.max(1_000, Math.trunc(opts.timeoutMs ?? 90_000));
		this.#extensionPaths = opts.extensionPaths ?? [];
		this.#sessionFactory = opts.sessionFactory ?? createMuSession;
		this.#nowMs = opts.nowMs ?? Date.now;
		this.#sessionIdleTtlMs = Math.max(60_000, Math.trunc(opts.sessionIdleTtlMs ?? 30 * 60 * 1_000));
		this.#maxSessions = Math.max(1, Math.trunc(opts.maxSessions ?? 32));
		this.#auditTurns = opts.auditTurns ?? true;
		this.#persistSessions = opts.persistSessions ?? true;
		this.#sessionDirForRepoRoot =
			opts.sessionDirForRepoRoot ?? ((repoRoot) => join(repoRoot, ".mu", "control-plane", "operator-sessions"));

		// Command execution routes through the server command pipeline via command.
	}

	#disposeSession(sessionId: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) {
			return;
		}
		this.#sessions.delete(sessionId);
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
			const path = join(input.inbound.repo_root, ".mu", "control-plane", "operator_turns.jsonl");
			await appendJsonl(path, entry);
		} catch {
			// best effort audit
		}
	}

	public async runTurn(input: OperatorBackendTurnInput): Promise<OperatorBackendTurnResult> {
		const sessionRecord = await this.#resolveSession(input.sessionId, input.inbound.repo_root);
		const session = sessionRecord.session;

		let assistantText = "";
		let capturedCommand: OperatorApprovedCommand | null = null;

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
		});

		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("pi operator timeout")), this.#timeoutMs);
		});

		try {
			await Promise.race([
				session.prompt(buildOperatorPrompt(input), { expandPromptTemplates: false }),
				timeoutPromise,
			]);
		} catch (err) {
			await this.#auditTurn(input, {
				outcome: "error",
				reason: err instanceof Error ? err.message : "operator_backend_error",
				messagePreview: assistantText,
			});
			throw err;
		} finally {
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
			return { kind: "command", command: capturedCommand };
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

		const responseMessage = message.slice(0, 2000);
		await this.#auditTurn(input, {
			outcome: "respond",
			messagePreview: responseMessage,
		});
		return { kind: "respond", message: responseMessage };
	}

	public dispose(): void {
		for (const sessionId of [...this.#sessions.keys()]) {
			this.#disposeSession(sessionId);
		}
	}
}
