import { z } from "zod";
import { CommandContextResolver } from "./command_context.js";
import { createMuSession, type CreateMuSessionOpts, type MuSession } from "./session_factory.js";

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

export type MessagingOperatorRuntimeOpts = {
	backend: MessagingOperatorBackend;
	broker?: ApprovedCommandBroker;
	enabled?: boolean;
	enabledChannels?: readonly string[];
	sessionIdFactory?: () => string;
	turnIdFactory?: () => string;
};

function defaultSessionId(): string {
	return `operator-${crypto.randomUUID()}`;
}

function defaultTurnId(): string {
	return `turn-${crypto.randomUUID()}`;
}

function conversationKey(inbound: InboundEnvelope, binding: IdentityBinding): string {
	return `${inbound.channel}:${inbound.channel_tenant_id}:${inbound.channel_conversation_id}:${binding.binding_id}`;
}

export class MessagingOperatorRuntime {
	readonly #backend: MessagingOperatorBackend;
	readonly #broker: ApprovedCommandBroker;
	readonly #enabled: boolean;
	readonly #enabledChannels: Set<string> | null;
	readonly #sessionIdFactory: () => string;
	readonly #turnIdFactory: () => string;
	readonly #sessionByConversation = new Map<string, string>();

	public constructor(opts: MessagingOperatorRuntimeOpts) {
		this.#backend = opts.backend;
		this.#broker = opts.broker ?? new ApprovedCommandBroker();
		this.#enabled = opts.enabled ?? true;
		this.#enabledChannels = opts.enabledChannels ? new Set(opts.enabledChannels.map((v) => v.toLowerCase())) : null;
		this.#sessionIdFactory = opts.sessionIdFactory ?? defaultSessionId;
		this.#turnIdFactory = opts.turnIdFactory ?? defaultTurnId;
	}

	#resolveSessionId(inbound: InboundEnvelope, binding: IdentityBinding): string {
		const key = conversationKey(inbound, binding);
		const existing = this.#sessionByConversation.get(key);
		if (existing) {
			return existing;
		}
		const created = this.#sessionIdFactory();
		this.#sessionByConversation.set(key, created);
		return created;
	}

	public async handleInbound(opts: { inbound: InboundEnvelope; binding: IdentityBinding }): Promise<OperatorDecision> {
		const sessionId = this.#resolveSessionId(opts.inbound, opts.binding);
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
				kind: "reject",
				reason: "operator_invalid_output",
				details: err instanceof Error ? err.message : "operator_backend_error",
				operatorSessionId: sessionId,
				operatorTurnId: turnId,
			};
		}

		if (backendResult.kind === "respond") {
			const message = backendResult.message.trim();
			if (!SAFE_RESPONSE_RE.test(message)) {
				return {
					kind: "reject",
					reason: "operator_invalid_output",
					details: "invalid response payload",
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
};

export const DEFAULT_CHAT_SYSTEM_PROMPT = [
	"You are mu, an AI assistant for the mu orchestration platform.",
	"Help users with:",
	"- Understanding mu's architecture (issues, forum, orchestrator, control-plane)",
	"- Setting up control-plane integrations (Slack, Discord, Telegram, Gmail planning)",
	"- Navigating issues and forum topics",
	"- Running and monitoring orchestrator workflows",
	"- General questions about the mu ecosystem",
	"",
	"Be concise, practical, and actionable.",
].join("\n");

const OPERATOR_COMMAND_PREFIX = "MU_COMMAND:";

const DEFAULT_OPERATOR_SYSTEM_PROMPT = [
	"You are mu, an AI assistant for the mu orchestration platform.",
	"You have tools to interact with the mu server: mu_status, mu_control_plane, mu_issues, mu_forum, mu_events.",
	"Use these tools to answer questions about repository state, issues, events, and control-plane runtime state.",
	"For adapter setup workflow, use mu_messaging_setup (check/preflight/plan/apply/verify/guide).",
	"You can help users set up messaging integrations (Slack, Discord, Telegram, Gmail planning).",
	"You may either respond normally or emit an approved control-plane command.",
	`To emit a command, output exactly one line with prefix ${OPERATOR_COMMAND_PREFIX} followed by compact JSON.`,
	"Example:",
	`MU_COMMAND: {\"kind\":\"run_start\",\"prompt\":\"ship release\"}`,
	"Available command kinds: status, ready, issue_list, issue_get, forum_read, run_list, run_status, run_start, run_resume, run_interrupt.",
	"",
	"Be concise, practical, and actionable.",
	"For normal conversational answers, respond in plain text.",
].join("\n");

function parseOperatorCommandDirective(text: string): OperatorApprovedCommand | null {
	const whole = text.trim();
	if (whole.startsWith("{") && whole.endsWith("}")) {
		try {
			return OperatorApprovedCommandSchema.parse(JSON.parse(whole));
		} catch {
			// fall through to explicit MU_COMMAND parsing
		}
	}

	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(OPERATOR_COMMAND_PREFIX)) {
			continue;
		}
		const payloadText = trimmed.slice(OPERATOR_COMMAND_PREFIX.length).trim();
		if (payloadText.length === 0) {
			throw new Error("operator_command_directive_missing_payload");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payloadText);
		} catch (err) {
			throw new Error(
				`operator_command_directive_invalid_json: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return OperatorApprovedCommandSchema.parse(parsed);
	}
	return null;
}

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

type PiOperatorSessionRecord = {
	session: MuSession;
	repoRoot: string;
	createdAtMs: number;
	lastUsedAtMs: number;
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

	async #createSession(repoRoot: string, nowMs: number): Promise<PiOperatorSessionRecord> {
		const session = await this.#sessionFactory({
			cwd: repoRoot,
			systemPrompt: this.#systemPrompt,
			provider: this.#provider,
			model: this.#model,
			thinking: this.#thinking,
			extensionPaths: this.#extensionPaths,
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

		const created = await this.#createSession(repoRoot, nowMs);
		this.#sessions.set(sessionId, created);
		this.#pruneSessions(nowMs);
		return created;
	}

	public async runTurn(input: OperatorBackendTurnInput): Promise<OperatorBackendTurnResult> {
		const sessionRecord = await this.#resolveSession(input.sessionId, input.inbound.repo_root);
		const session = sessionRecord.session;

		let assistantText = "";
		const unsub = session.subscribe((event: any) => {
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
		});

		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("pi operator timeout")), this.#timeoutMs);
		});

		try {
			await Promise.race([
				session.prompt(buildOperatorPrompt(input), { expandPromptTemplates: false }),
				timeoutPromise,
			]);
		} finally {
			unsub();
			sessionRecord.lastUsedAtMs = Math.trunc(this.#nowMs());
		}

		const message = assistantText.trim();
		if (!message) {
			throw new Error("operator_empty_response");
		}

		const command = parseOperatorCommandDirective(message);
		if (command) {
			return {
				kind: "command",
				command,
			};
		}

		return { kind: "respond", message: message.slice(0, 2000) };
	}

	public dispose(): void {
		for (const sessionId of [...this.#sessions.keys()]) {
			this.#disposeSession(sessionId);
		}
	}
}
