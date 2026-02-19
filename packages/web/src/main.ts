import "./style.css";
import { api, ApiError } from "./api.js";

const LAST_TOPIC_KEY = "mu-web:last_topic";

function safeLocalStorage(): Storage | null {
	return typeof localStorage !== "undefined" ? localStorage : null;
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

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) {
	throw new Error("missing #app");
}
const app = appEl;

app.innerHTML = `
	<div class="container">
		<h1>mu</h1>
		<div class="row muted">
			<span class="pill" data-testid="status-pill">Connecting...</span>
			<button data-testid="refresh">Refresh</button>
			<span class="muted" data-testid="repo-root"></span>
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
			<h2>Events</h2>
			<div class="row">
				<button data-testid="events-refresh">Refresh</button>
				<label style="display: flex; align-items: center; gap: 4px;">
					<input type="checkbox" data-testid="events-auto-refresh" />
					Auto-refresh (5s)
				</label>
			</div>
			<p class="muted">
				Events: <span data-testid="events-count">0</span>
			</p>
			<pre data-testid="events-json">[]</pre>
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

const statusPill = q("status-pill");
const repoRootSpan = q("repo-root");
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
	if (err instanceof ApiError) {
		errorsPre.textContent = `API Error (${err.status}): ${err.message}`;
		return;
	}
	if (err instanceof Error) {
		errorsPre.textContent = `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
		return;
	}
	errorsPre.textContent = String(err);
}

async function checkConnection() {
	try {
		const status = await api.getStatus();
		statusPill.textContent = `Connected to ${import.meta.env.VITE_API_URL ? new URL(import.meta.env.VITE_API_URL).host : window.location.host}`;
		statusPill.classList.add("success");
		statusPill.classList.remove("error");
		repoRootSpan.textContent = status.repo_root || "";
		return true;
	} catch (err) {
		statusPill.textContent = "Connection failed";
		statusPill.classList.add("error");
		statusPill.classList.remove("success");
		repoRootSpan.textContent = "";
		setError(err);
		return false;
	}
}

async function refreshEvents() {
	try {
		const events = await api.getEventsTail(50);
		q("events-count").textContent = String(events.length);
		q("events-json").textContent = JSON.stringify(
			events.map((e: any) => ({
				time: new Date(e.ts_ms).toLocaleTimeString(),
				type: e.type,
				source: e.source,
				...(e.issue_id ? { issue_id: e.issue_id } : {}),
				...(Object.keys(e.payload ?? {}).length > 0 ? { payload: e.payload } : {}),
			})),
			null,
			2,
		);
	} catch (err) {
		q("events-json").textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function refresh(opts: { readTopic?: string } = {}) {
	try {
		setError(null);

		const [allIssues, ready, _status] = await Promise.all([api.listIssues(), api.getReadyIssues(), api.getStatus()]);

		const topicsPrefix = q<HTMLInputElement>("topics-prefix").value.trim() || undefined;
		const topics = await api.listTopics(topicsPrefix);

		q("issues-count").textContent = String(allIssues.length);
		q("ready-count").textContent = String(ready.length);
		q("topics-count").textContent = String(topics.length);

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
			const msgs = await api.readMessages(readTopic, 50);
			q("messages-json").textContent = JSON.stringify(msgs, null, 2);
		} else {
			q("messages-json").textContent = "[]";
		}

		await refreshEvents();
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
		await api.createIssue({ title, tags: ["node:agent"] });
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
		await api.postMessage(topic, body, author);
		saveLastTopic(topic);
		q<HTMLTextAreaElement>("forum-body").value = "";
		q<HTMLInputElement>("read-topic").value = topic;
		await refresh({ readTopic: topic });
	})();
});

// Events panel
q("events-refresh").addEventListener("click", () => {
	void refreshEvents();
});

let eventsAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
q<HTMLInputElement>("events-auto-refresh").addEventListener("change", (e) => {
	const checked = (e.target as HTMLInputElement).checked;
	if (checked) {
		eventsAutoRefreshTimer = setInterval(() => {
			void refreshEvents();
		}, 5_000);
	} else if (eventsAutoRefreshTimer) {
		clearInterval(eventsAutoRefreshTimer);
		eventsAutoRefreshTimer = null;
	}
});

// Initial connection check and render.
void (async () => {
	const connected = await checkConnection();
	if (connected) {
		await refresh();
	}
})();
