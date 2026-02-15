import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createSlackBot, type MuWorkflow } from "@femtomc/mu-slack-bot";

function slackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
	const baseString = `v0:${timestamp}:${rawBody}`;
	const hex = createHmac("sha256", signingSecret).update(baseString, "utf8").digest("hex");
	return `v0=${hex}`;
}

function slackRequest(opts: {
	secret: string;
	timestamp: number;
	url: string;
	body: string;
	contentType: string;
}): Request {
	const ts = String(opts.timestamp);
	const headers = new Headers({
		"content-type": opts.contentType,
		"x-slack-request-timestamp": ts,
		"x-slack-signature": slackSignature(opts.secret, ts, opts.body),
	});
	return new Request(opts.url, { method: "POST", headers, body: opts.body });
}

test("POST /slack/commands status calls workflow.status()", async () => {
	let statusCalls = 0;
	const workflow: MuWorkflow = {
		async status() {
			statusCalls += 1;
			return { repoRoot: "/repo", openCount: 2, readyCount: 1 };
		},
		async ready() {
			return [];
		},
	};

	const secret = "shh";
	const timestamp = 1_700_000_000;
	const bot = createSlackBot({ signingSecret: secret, workflow, nowMs: () => timestamp * 1000 });

	const body = new URLSearchParams({ command: "/mu", text: "status" }).toString();
	const req = slackRequest({
		secret,
		timestamp,
		url: "https://example.test/slack/commands",
		body,
		contentType: "application/x-www-form-urlencoded",
	});

	const res = await bot.fetch(req);
	expect(res.status).toBe(200);
	const payload = (await res.json()) as any;
	expect(payload.response_type).toBe("ephemeral");
	expect(payload.text).toContain("repo_root: /repo");
	expect(payload.text).toContain("open: 2");
	expect(payload.text).toContain("ready: 1");
	expect(statusCalls).toBe(1);
});

test("POST /slack/commands ready passes rootId and limit to workflow.ready()", async () => {
	let got: any = null;

	const workflow: MuWorkflow = {
		async status() {
			return { repoRoot: "/repo", openCount: 0, readyCount: 0 };
		},
		async ready(opts) {
			got = opts ?? null;
			const issues = [
				{ id: "mu-a", title: "A", priority: 2 },
				{ id: "mu-b", title: "B", priority: 3 },
			];
			return issues.slice(0, opts?.limit ?? issues.length);
		},
	};

	const secret = "shh";
	const timestamp = 1_700_000_000;
	const bot = createSlackBot({ signingSecret: secret, workflow, nowMs: () => timestamp * 1000 });

	const body = new URLSearchParams({ command: "/mu", text: "ready mu-root --limit 1" }).toString();
	const req = slackRequest({
		secret,
		timestamp,
		url: "https://example.test/slack/commands",
		body,
		contentType: "application/x-www-form-urlencoded",
	});

	const res = await bot.fetch(req);
	expect(res.status).toBe(200);
	const payload = (await res.json()) as any;
	expect(payload.text).toContain("root=mu-root");
	expect(payload.text).toContain("mu-a");
	expect(payload.text).not.toContain("mu-b");

	expect(got).toMatchObject({ rootId: "mu-root", limit: 1 });
});

test("POST /slack/commands create parses title/body and calls workflow.createIssue()", async () => {
	let got: any = null;

	const workflow: MuWorkflow = {
		async status() {
			return { repoRoot: "/repo", openCount: 0, readyCount: 0 };
		},
		async ready() {
			return [];
		},
		async createIssue(title, opts) {
			got = { title, body: opts?.body ?? "" };
			return { id: "mu-new", title };
		},
	};

	const secret = "shh";
	const timestamp = 1_700_000_000;
	const bot = createSlackBot({ signingSecret: secret, workflow, nowMs: () => timestamp * 1000 });

	const body = new URLSearchParams({ command: "/mu", text: "create Hello world | Body line" }).toString();
	const req = slackRequest({
		secret,
		timestamp,
		url: "https://example.test/slack/commands",
		body,
		contentType: "application/x-www-form-urlencoded",
	});

	const res = await bot.fetch(req);
	expect(res.status).toBe(200);
	const payload = (await res.json()) as any;
	expect(payload.text).toContain("created: mu-new");
	expect(payload.text).toContain("title: Hello world");
	expect(payload.text).toContain("body: Body line");

	expect(got).toEqual({ title: "Hello world", body: "Body line" });
});

test("invalid Slack signature returns 401", async () => {
	const workflow: MuWorkflow = {
		async status() {
			return { repoRoot: "/repo", openCount: 0, readyCount: 0 };
		},
		async ready() {
			return [];
		},
	};

	const secret = "shh";
	const timestamp = 1_700_000_000;
	const bot = createSlackBot({ signingSecret: secret, workflow, nowMs: () => timestamp * 1000 });

	const body = new URLSearchParams({ command: "/mu", text: "status" }).toString();
	const headers = new Headers({
		"content-type": "application/x-www-form-urlencoded",
		"x-slack-request-timestamp": String(timestamp),
		"x-slack-signature": "v0=bad",
	});

	const res = await bot.fetch(new Request("https://example.test/slack/commands", { method: "POST", headers, body }));
	expect(res.status).toBe(401);
});

test("POST /slack/events url_verification returns challenge", async () => {
	const workflow: MuWorkflow = {
		async status() {
			return { repoRoot: "/repo", openCount: 0, readyCount: 0 };
		},
		async ready() {
			return [];
		},
	};

	const secret = "shh";
	const timestamp = 1_700_000_000;
	const bot = createSlackBot({ signingSecret: secret, workflow, nowMs: () => timestamp * 1000 });

	const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
	const req = slackRequest({
		secret,
		timestamp,
		url: "https://example.test/slack/events",
		body,
		contentType: "application/json",
	});

	const res = await bot.fetch(req);
	expect(res.status).toBe(200);
	const payload = (await res.json()) as any;
	expect(payload).toEqual({ challenge: "abc123" });
});
