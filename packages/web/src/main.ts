import "./style.css";

import { EventLog, JsonlEventSink } from "@mu/core";
import { IndexedDbJsonlStore, LocalStorageJsonlStore } from "@mu/core/browser";
import { ForumStore } from "@mu/forum";
import { IssueStore } from "@mu/issue";

type Backend = "indexeddb" | "localstorage";

const DEMO_DB_NAME = "mu-demo";
const LAST_TOPIC_KEY = `${DEMO_DB_NAME}:last_topic`;
const STORES = ["issues", "forum", "events"] as const;

function backend(): Backend {
	return (globalThis as any).indexedDB ? "indexeddb" : "localstorage";
}

function safeLocalStorage(): any | null {
	return (globalThis as any).localStorage ?? null;
}

function loadLastTopic(): string | null {
	try {
		const ls = safeLocalStorage();
		if (!ls) return null;
		const value = String(ls.getItem(LAST_TOPIC_KEY) ?? "").trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

function saveLastTopic(topic: string): void {
	try {
		const ls = safeLocalStorage();
		if (!ls) return;
		const value = topic.trim();
		if (!value) return;
		ls.setItem(LAST_TOPIC_KEY, value);
	} catch {}
}

function makeStore(storeName: (typeof STORES)[number]) {
	if (backend() === "indexeddb") {
		return new IndexedDbJsonlStore({
			dbName: DEMO_DB_NAME,
			storeName,
			ensureStores: STORES,
		});
	}
	return new LocalStorageJsonlStore({ key: `${DEMO_DB_NAME}:${storeName}` });
}

const issuesJsonl = makeStore("issues");
const forumJsonl = makeStore("forum");
const eventsJsonl = makeStore("events");

const events = new EventLog(new JsonlEventSink(eventsJsonl));
const issues = new IssueStore(issuesJsonl, { events });
const forum = new ForumStore(forumJsonl, { events });

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) {
	throw new Error("missing #app");
}
const app = appEl;

app.innerHTML = `
	<div class="container">
		<h1>mu browser demo</h1>
		<div class="row muted">
			<span class="pill" data-testid="backend-pill"></span>
			<button data-testid="reset">Reset</button>
			<button data-testid="refresh">Refresh</button>
			<span class="muted">Data persists in your browser storage across reload.</span>
		</div>

		<div class="grid">
			<div class="card">
				<h2>Issues</h2>
				<div class="row">
					<input data-testid="issue-title" placeholder="Issue title" />
					<button data-testid="create-issue">Create</button>
				</div>
				<p class="muted">
					All issues: <span data-testid="issues-count">0</span>
					Ready leaves: <span data-testid="ready-count">0</span>
				</p>
				<div class="grid" style="grid-template-columns: 1fr; gap: 10px;">
					<div>
						<div class="muted">Issues</div>
						<pre data-testid="issues-json">[]</pre>
					</div>
					<div>
						<div class="muted">Ready Leaves</div>
						<pre data-testid="ready-json">[]</pre>
					</div>
				</div>
			</div>

			<div class="card">
				<h2>Forum</h2>

				<div class="muted">Post</div>
				<div class="row">
					<input data-testid="forum-topic" placeholder="Topic (e.g. issue:mu-123)" />
					<input data-testid="forum-author" placeholder="Author" value="worker" />
				</div>
				<textarea data-testid="forum-body" placeholder="Message body"></textarea>
				<div class="row">
					<button data-testid="forum-post">Post</button>
				</div>

				<div style="height: 10px;"></div>

				<div class="muted">Read</div>
				<div class="row">
					<input data-testid="read-topic" placeholder="Topic to read" />
					<button data-testid="forum-read">Read</button>
				</div>

				<div style="height: 10px;"></div>

				<div class="muted">Topics</div>
				<div class="row">
					<input data-testid="topics-prefix" placeholder="Prefix (optional)" />
					<button data-testid="topics-refresh">List</button>
				</div>

				<p class="muted">
					Topics: <span data-testid="topics-count">0</span>
					Events: <span data-testid="events-count">0</span>
				</p>

				<div class="grid" style="grid-template-columns: 1fr; gap: 10px;">
					<div>
						<div class="muted">Topics</div>
						<pre data-testid="topics-json">[]</pre>
					</div>
					<div>
						<div class="muted">Messages</div>
						<pre data-testid="messages-json">[]</pre>
					</div>
				</div>
			</div>
		</div>

		<div class="card" style="margin-top: 16px;">
			<div class="muted">Errors</div>
			<pre data-testid="errors"></pre>
		</div>
	</div>
`;

function q<T extends HTMLElement = HTMLElement>(testId: string): T {
	const el = app.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!el) {
		throw new Error(`missing [data-testid=${JSON.stringify(testId)}]`);
	}
	return el as T;
}

const backendPill = q("backend-pill");
backendPill.textContent = `storage=${backend()} db=${DEMO_DB_NAME}`;

const errorsPre = q<HTMLPreElement>("errors");
const initialLastTopic = loadLastTopic();
if (initialLastTopic) {
	q<HTMLInputElement>("read-topic").value = initialLastTopic;
}

function setError(err: unknown) {
	if (!err) {
		errorsPre.textContent = "";
		return;
	}
	if (err instanceof Error) {
		errorsPre.textContent = `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
		return;
	}
	errorsPre.textContent = String(err);
}

async function refresh(opts: { readTopic?: string } = {}) {
	try {
		setError(null);
		const allIssues = await issues.list();
		const ready = await issues.ready(null);
		const topicsPrefix = q<HTMLInputElement>("topics-prefix").value.trim() || null;
		const topics = await forum.topics(topicsPrefix);
		const eventsRows = await eventsJsonl.read();

		q("issues-count").textContent = String(allIssues.length);
		q("ready-count").textContent = String(ready.length);
		q("topics-count").textContent = String(topics.length);
		q("events-count").textContent = String(eventsRows.length);

		q("issues-json").textContent = JSON.stringify(allIssues, null, 2);
		q("ready-json").textContent = JSON.stringify(ready, null, 2);
		q("topics-json").textContent = JSON.stringify(topics, null, 2);

		let readTopic = opts.readTopic ?? q<HTMLInputElement>("read-topic").value.trim();
		if (!readTopic) {
			const last = loadLastTopic();
			if (last) {
				readTopic = last;
				q<HTMLInputElement>("read-topic").value = last;
			}
		}
		if (readTopic) {
			const msgs = await forum.read(readTopic, 50);
			q("messages-json").textContent = JSON.stringify(msgs, null, 2);
		} else {
			q("messages-json").textContent = "[]";
		}
	} catch (err) {
		setError(err);
	}
}

q("refresh").addEventListener("click", () => {
	void refresh();
});

q("topics-refresh").addEventListener("click", () => {
	void refresh();
});

q("forum-read").addEventListener("click", () => {
	const readTopic = q<HTMLInputElement>("read-topic").value.trim();
	saveLastTopic(readTopic);
	void refresh({ readTopic });
});

q("create-issue").addEventListener("click", () => {
	const input = q<HTMLInputElement>("issue-title");
	const title = input.value.trim();
	if (!title) {
		setError(new Error("issue title required"));
		return;
	}

	void (async () => {
		await issues.create(title, { tags: ["node:agent"] });
		input.value = "";
		await refresh();
	})();
});

q("forum-post").addEventListener("click", () => {
	const topic = q<HTMLInputElement>("forum-topic").value.trim();
	const author = q<HTMLInputElement>("forum-author").value.trim() || "system";
	const body = q<HTMLTextAreaElement>("forum-body").value;

	if (!topic) {
		setError(new Error("topic required"));
		return;
	}

	void (async () => {
		await forum.post(topic, body, author);
		saveLastTopic(topic);
		q<HTMLTextAreaElement>("forum-body").value = "";
		q<HTMLInputElement>("read-topic").value = topic;
		await refresh({ readTopic: topic });
	})();
});

q("reset").addEventListener("click", () => {
	void (async () => {
		await issuesJsonl.write([]);
		await forumJsonl.write([]);
		await eventsJsonl.write([]);
		try {
			safeLocalStorage()?.removeItem(LAST_TOPIC_KEY);
		} catch {}
		q<HTMLInputElement>("read-topic").value = "";
		await refresh();
	})();
});

// Initial render.
void refresh();
