import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { FsJsonlStore, findRepoRoot, getStorePaths } from "@femtomc/mu-core/node";
import { IssueStore } from "@femtomc/mu-issue";

export type MuStatus = {
	repoRoot: string;
	openCount: number;
	readyCount: number;
};

export type ReadyIssueSummary = {
	id: string;
	title: string;
	priority: number;
};

export type CreatedIssue = {
	id: string;
	title: string;
};

export type MuWorkflow = {
	status(): Promise<MuStatus>;
	ready(opts?: { rootId?: string | null; limit?: number | null }): Promise<ReadyIssueSummary[]>;
	createIssue?: (title: string, opts?: { body?: string | null }) => Promise<CreatedIssue>;
};

export type SlackBot = {
	fetch(req: Request): Promise<Response>;
};

export type SlackBotOptions = {
	signingSecret: string;
	workflow: MuWorkflow;
	nowMs?: () => number;
	allowedTimestampSkewSec?: number;
};

function copyHeaders(initHeaders: unknown): Headers {
	const headers = new Headers();
	if (!initHeaders) {
		return headers;
	}

	// Sequence form: [ [k, v], ... ]
	if (Array.isArray(initHeaders)) {
		for (const entry of initHeaders) {
			const [key, value] = entry as [unknown, unknown];
			headers.append(String(key), String(value));
		}
		return headers;
	}

	// Headers / Map-like objects (including undici's Headers) implement forEach(value, key).
	if (typeof (initHeaders as any).forEach === "function") {
		(initHeaders as any).forEach((value: unknown, key: unknown) => {
			headers.append(String(key), String(value));
		});
		return headers;
	}

	// Iterable of [k, v] pairs (some runtimes accept this as HeadersInit).
	if (typeof (initHeaders as any)[Symbol.iterator] === "function") {
		for (const entry of initHeaders as any) {
			if (Array.isArray(entry) && entry.length >= 2) {
				headers.append(String(entry[0]), String(entry[1]));
			}
		}
		return headers;
	}

	// Record form: { [k]: v }
	for (const [key, value] of Object.entries(initHeaders as Record<string, unknown>)) {
		if (Array.isArray(value)) {
			for (const v of value) {
				headers.append(key, String(v));
			}
		} else if (value != null) {
			headers.set(key, String(value));
		}
	}
	return headers;
}

function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = copyHeaders(init.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "application/json; charset=utf-8");
	}
	return new Response(JSON.stringify(data), { ...init, headers });
}

function slackEphemeral(text: string, init: ResponseInit = {}): Response {
	return json({ response_type: "ephemeral", text }, init);
}

function okText(text: string, init: ResponseInit = {}): Response {
	const headers = copyHeaders(init.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "text/plain; charset=utf-8");
	}
	return new Response(text, { ...init, headers });
}

function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
	const baseString = `v0:${timestamp}:${rawBody}`;
	const hex = createHmac("sha256", signingSecret).update(baseString, "utf8").digest("hex");
	return `v0=${hex}`;
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) {
		return false;
	}
	return timingSafeEqual(ab, bb);
}

function verifySlackRequest(
	req: Request,
	rawBody: string,
	opts: Pick<SlackBotOptions, "signingSecret" | "allowedTimestampSkewSec" | "nowMs">,
): { ok: true } | { ok: false; status: number; error: string } {
	const timestamp = req.headers.get("x-slack-request-timestamp");
	const signature = req.headers.get("x-slack-signature");
	if (!timestamp || !signature) {
		return { ok: false, status: 401, error: "missing Slack signature headers" };
	}

	const ts = Number.parseInt(timestamp, 10);
	if (!Number.isFinite(ts)) {
		return { ok: false, status: 401, error: "invalid Slack timestamp" };
	}

	const skewSec = opts.allowedTimestampSkewSec ?? 5 * 60;
	const nowS = (opts.nowMs?.() ?? Date.now()) / 1000;
	if (Math.abs(nowS - ts) > skewSec) {
		return { ok: false, status: 401, error: "stale Slack request timestamp" };
	}

	const expected = computeSlackSignature(opts.signingSecret, timestamp, rawBody);
	if (!timingSafeEqualUtf8(expected, signature)) {
		return { ok: false, status: 401, error: "invalid Slack signature" };
	}

	return { ok: true };
}

function splitFirstWord(text: string): { head: string; rest: string } {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { head: "", rest: "" };
	}
	const m = /^(\S+)\s*(.*)$/.exec(trimmed);
	if (!m) {
		return { head: trimmed, rest: "" };
	}
	return { head: m[1] ?? "", rest: m[2] ?? "" };
}

function helpText(): string {
	return [
		"mu Slack bot",
		"",
		"Usage:",
		"  /mu status",
		"  /mu ready [rootId] [--limit N]",
		"  /mu create <title> [| body]",
		"",
		"Examples:",
		"  /mu status",
		"  /mu ready mu-d16f9960",
		"  /mu create Fix typecheck | bun run typecheck fails on Windows",
	].join("\n");
}

function formatStatus(status: MuStatus): string {
	return [
		"mu status",
		`repo_root: ${status.repoRoot}`,
		`open: ${status.openCount}`,
		`ready: ${status.readyCount}`,
	].join("\n");
}

function formatReady(issues: readonly ReadyIssueSummary[], opts: { rootId?: string | null } = {}): string {
	if (issues.length === 0) {
		return "No ready issues.";
	}
	const header = opts.rootId
		? `ready issues (root=${opts.rootId}, n=${issues.length})`
		: `ready issues (n=${issues.length})`;
	const lines = issues.map((i) => `- ${i.id} (p${i.priority}) ${i.title}`);
	return [header, ...lines].join("\n");
}

function parseLimit(tokens: readonly string[]): number | null {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === "--limit") {
			const next = tokens[i + 1];
			if (next != null) {
				const n = Number.parseInt(next, 10);
				return Number.isFinite(n) ? n : null;
			}
			return null;
		}
		if (t.startsWith("--limit=")) {
			const raw = t.slice("--limit=".length);
			const n = Number.parseInt(raw, 10);
			return Number.isFinite(n) ? n : null;
		}
	}
	return null;
}

function parseReadyArgs(rest: string): { rootId: string | null; limit: number | null } {
	const tokens = rest.trim().length > 0 ? rest.trim().split(/\s+/) : [];
	const limit = parseLimit(tokens);

	for (const t of tokens) {
		if (t.startsWith("-")) {
			continue;
		}
		// First non-flag positional arg is treated as rootId.
		return { rootId: t, limit };
	}
	return { rootId: null, limit };
}

function parseCreateArgs(rest: string): { title: string; body: string } {
	const trimmed = rest.trim();
	if (trimmed.length === 0) {
		return { title: "", body: "" };
	}
	const idx = trimmed.indexOf("|");
	if (idx < 0) {
		return { title: trimmed, body: "" };
	}
	return { title: trimmed.slice(0, idx).trim(), body: trimmed.slice(idx + 1).trim() };
}

async function handleSlackSlashCommand(rawBody: string, workflow: MuWorkflow): Promise<Response> {
	const form = new URLSearchParams(rawBody);
	const command = form.get("command") ?? "";
	if (command && command !== "/mu") {
		return slackEphemeral(`Unsupported Slack command: ${command}\n\n${helpText()}`, { status: 200 });
	}

	const text = form.get("text") ?? "";
	const { head: subcmdRaw, rest } = splitFirstWord(text);
	const subcmd = subcmdRaw.toLowerCase();

	if (!subcmd || subcmd === "help" || subcmd === "--help" || subcmd === "-h") {
		return slackEphemeral(helpText(), { status: 200 });
	}

	try {
		if (subcmd === "status") {
			const status = await workflow.status();
			return slackEphemeral(formatStatus(status), { status: 200 });
		}

		if (subcmd === "ready") {
			const { rootId, limit } = parseReadyArgs(rest);
			const issues = await workflow.ready({ rootId, limit });
			return slackEphemeral(formatReady(issues, { rootId }), { status: 200 });
		}

		if (subcmd === "create") {
			if (!workflow.createIssue) {
				return slackEphemeral("Create is not enabled on this bot.", { status: 200 });
			}
			const { title, body } = parseCreateArgs(rest);
			if (!title) {
				return slackEphemeral("Missing title.\n\nUsage: /mu create <title> [| body]", { status: 200 });
			}
			const created = await workflow.createIssue(title, { body });
			const bodyLine = body ? `\nbody: ${body}` : "";
			return slackEphemeral(`created: ${created.id}\ntitle: ${created.title}${bodyLine}`, { status: 200 });
		}

		return slackEphemeral(`Unknown subcommand: ${subcmd}\n\n${helpText()}`, { status: 200 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return slackEphemeral(`error: ${msg}`, { status: 200 });
	}
}

async function handleSlackEvents(rawBody: string): Promise<Response> {
	let event: any;
	try {
		event = JSON.parse(rawBody) as any;
	} catch {
		return slackEphemeral("invalid JSON", { status: 400 });
	}

	if (event?.type === "url_verification" && typeof event.challenge === "string") {
		return json({ challenge: event.challenge }, { status: 200 });
	}

	// MVP: ack any event callbacks without side effects.
	return okText("ok", { status: 200 });
}

export function createSlackBot(opts: SlackBotOptions): SlackBot {
	return {
		fetch: async (req: Request): Promise<Response> => {
			const url = new URL(req.url);
			const path = url.pathname;

			if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
				return okText("ok", { status: 200 });
			}

			if (req.method !== "POST") {
				return okText("method not allowed", { status: 405 });
			}

			const rawBody = await req.text();
			const verified = verifySlackRequest(req, rawBody, opts);
			if (!verified.ok) {
				return okText(verified.error, { status: verified.status });
			}

			if (path === "/slack/commands") {
				return await handleSlackSlashCommand(rawBody, opts.workflow);
			}

			if (path === "/slack/events") {
				return await handleSlackEvents(rawBody);
			}

			return okText("not found", { status: 404 });
		},
	};
}

export function createFsMuWorkflow(opts: { repoRoot?: string } = {}): MuWorkflow {
	const repoRoot = opts.repoRoot ?? process.env.MU_REPO_ROOT ?? findRepoRoot(process.cwd());
	const paths = getStorePaths(repoRoot);
	const store = new IssueStore(new FsJsonlStore(paths.issuesPath));

	return {
		async status(): Promise<MuStatus> {
			const open = await store.list({ status: "open" });
			const ready = await store.ready(null);
			return { repoRoot, openCount: open.length, readyCount: ready.length };
		},
		async ready({ rootId = null, limit = null } = {}): Promise<ReadyIssueSummary[]> {
			let issues = await store.ready(rootId);
			if (limit != null) {
				issues = issues.slice(0, Math.max(0, limit));
			}
			return issues.map((i) => ({ id: i.id, title: i.title ?? "", priority: i.priority ?? 3 }));
		},
		async createIssue(title: string, createOpts: { body?: string | null } = {}): Promise<CreatedIssue> {
			const issue = await store.create(title, { body: createOpts.body ?? "", tags: ["node:agent"] });
			return { id: issue.id, title: issue.title ?? "" };
		},
	};
}

export function createSlackBotFromEnv(env: Record<string, string | undefined> = process.env): SlackBot {
	const secret = env.SLACK_SIGNING_SECRET;
	if (!secret) {
		throw new Error("SLACK_SIGNING_SECRET is required");
	}
	const workflow = createFsMuWorkflow({ repoRoot: env.MU_REPO_ROOT });
	return createSlackBot({ signingSecret: secret, workflow });
}
