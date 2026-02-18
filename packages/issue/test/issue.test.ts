import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJsonlStore, fsEventLog, readJsonl, writeJsonl } from "@femtomc/mu-core/node";
import { IssueStore, IssueStoreNotFoundError, IssueStoreValidationError } from "@femtomc/mu-issue";

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mu-issue-"));
}

describe("IssueStore", () => {
	test("create persists canonical row and emits issue.create", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");

		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });
		const issue = await store.create("hello", { tags: ["node:agent"] });

		expect(issue.id.startsWith("mu-")).toBe(true);
		expect(issue.title).toBe("hello");
		expect(issue.body).toBe("");
		expect(issue.status).toBe("open");
		expect(issue.outcome).toBe(null);
		expect(issue.tags).toEqual(["node:agent"]);
		expect(issue.deps).toEqual([]);
		expect(typeof issue.created_at).toBe("number");
		expect(typeof issue.updated_at).toBe("number");

		const rows = await readJsonl(issuesPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: issue.id,
			title: "hello",
			status: "open",
			outcome: null,
			tags: ["node:agent"],
		});

		const events = (await readJsonl(join(dir, ".mu", "events.jsonl"))) as any[];
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			v: 1,
			type: "issue.create",
			source: "issue_store",
			issue_id: issue.id,
			payload: { issue: { id: issue.id, title: "hello" } },
		});
	});

	test("list filters by status and tag", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });

		const a = await store.create("a", { tags: ["t1"] });
		const b = await store.create("b", { tags: ["t2"] });
		await store.close(a.id, "success");

		const open = await store.list({ status: "open" });
		expect(open.map((i) => i.id).sort()).toEqual([b.id].sort());

		const t2 = await store.list({ tag: "t2" });
		expect(t2.map((i) => i.id).sort()).toEqual([b.id].sort());
	});

	test("list rejects invalid status filters", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });

		await expect(store.list({ status: "invalid" as any })).rejects.toBeInstanceOf(IssueStoreValidationError);
	});

	test("update ignores id and emits issue.update + issue.close on close transition", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });

		const issue = await store.create("t");
		const updated = await store.update(issue.id, { id: "nope", title: "t2", status: "closed", outcome: "skipped" });

		expect(updated.id).toBe(issue.id);
		expect(updated.title).toBe("t2");
		expect(updated.status).toBe("closed");
		expect(updated.outcome).toBe("skipped");

		const events = (await readJsonl(join(dir, ".mu", "events.jsonl"))) as any[];
		const types = events.map((e) => e.type);
		expect(types).toContain("issue.update");
		expect(types).toContain("issue.close");
	});

	test("update raises typed not-found errors for unknown issue ids", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });

		await expect(store.update("mu-missing", { title: "nope" })).rejects.toBeInstanceOf(IssueStoreNotFoundError);
	});

	test("claim returns ok/failed and emits issue.claim", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });

		const issue = await store.create("t");

		expect(await store.claim(issue.id)).toBe(true);
		expect(await store.claim(issue.id)).toBe(false);
		expect(await store.claim("mu-missing")).toBe(false);

		const after = await store.get(issue.id);
		expect(after?.status).toBe("in_progress");

		const events = (await readJsonl(join(dir, ".mu", "events.jsonl"))) as any[];
		const claimEvents = events.filter((e) => e.type === "issue.claim");
		expect(claimEvents.length).toBeGreaterThanOrEqual(3);
		expect(claimEvents.some((e) => e.payload?.ok === true)).toBe(true);
		expect(claimEvents.some((e) => e.payload?.ok === false && e.payload?.reason === "not_found")).toBe(true);
	});

	test("add_dep/remove_dep update deps and emit events", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });

		const a = await store.create("a");
		const b = await store.create("b");

		await store.add_dep(a.id, "blocks", b.id);
		await store.add_dep(a.id, "blocks", b.id); // idempotent

		const a1 = await store.get(a.id);
		expect(a1?.deps.filter((d) => d.type === "blocks" && d.target === b.id)).toHaveLength(1);

		expect(await store.remove_dep(a.id, "blocks", b.id)).toBe(true);
		expect(await store.remove_dep(a.id, "blocks", b.id)).toBe(false);

		const events = (await readJsonl(join(dir, ".mu", "events.jsonl"))) as any[];
		expect(events.some((e) => e.type === "issue.dep.add")).toBe(true);
		expect(events.some((e) => e.type === "issue.dep.remove" && e.payload?.ok === true)).toBe(true);
		expect(events.some((e) => e.type === "issue.dep.remove" && e.payload?.ok === false)).toBe(true);
	});

	test("add_dep enforces target existence and blocks self-dependencies", async () => {
		const dir = await mkTempDir();
		const issuesPath = join(dir, ".mu", "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });
		const a = await store.create("a");

		await expect(store.add_dep(a.id, "blocks", "mu-missing")).rejects.toBeInstanceOf(IssueStoreNotFoundError);
		await expect(store.add_dep(a.id, "blocks", a.id)).rejects.toBeInstanceOf(IssueStoreValidationError);
	});

	test("children/subtree_ids/ready/collapsible/validate behave as expected", async () => {
		const dir = await mkTempDir();
		const storeDir = join(dir, ".mu");
		await mkdir(storeDir, { recursive: true });

		const issuesPath = join(storeDir, "issues.jsonl");
		const eventLog = fsEventLog(join(dir, ".mu", "events.jsonl"));
		const store = new IssueStore(new FsJsonlStore(issuesPath), { events: eventLog });

		await writeJsonl(issuesPath, [
			{
				id: "mu-root",
				title: "root",
				body: "",
				status: "closed",
				outcome: "expanded",
				tags: ["node:root"],
				deps: [],

				priority: 3,
				created_at: 1,
				updated_at: 1,
			},
			{
				id: "mu-leaf1",
				title: "leaf1",
				body: "",
				status: "open",
				outcome: null,
				tags: ["node:agent"],
				deps: [{ type: "parent", target: "mu-root" }],

				priority: 2,
				created_at: 2,
				updated_at: 2,
			},
			{
				id: "mu-leaf2",
				title: "leaf2",
				body: "",
				status: "open",
				outcome: null,
				tags: ["node:agent", "x"],
				deps: [{ type: "parent", target: "mu-root" }],

				priority: 1,
				created_at: 3,
				updated_at: 3,
			},
			{
				id: "mu-blocker",
				title: "blocker",
				body: "",
				status: "open",
				outcome: null,
				tags: [],
				deps: [{ type: "blocks", target: "mu-leaf2" }],

				priority: 3,
				created_at: 4,
				updated_at: 4,
			},
		]);

		const kids = await store.children("mu-root");
		expect(kids.map((k) => k.id).sort()).toEqual(["mu-leaf1", "mu-leaf2"].sort());

		const subtree = await store.subtree_ids("mu-root");
		expect(subtree).toContain("mu-root");
		expect(subtree).toContain("mu-leaf1");
		expect(subtree).toContain("mu-leaf2");

		const readyAll = await store.ready("mu-root");
		expect(readyAll.map((i) => i.id)).toEqual(["mu-leaf1"]); // leaf2 blocked

		const readyTags = await store.ready("mu-root", { tags: ["node:agent", "x"] });
		expect(readyTags).toHaveLength(0); // leaf2 matches tags but is blocked

		// Now close blocker, leaf2 should become ready and win on priority.
		await store.close("mu-blocker", "success");
		const readyAfter = await store.ready("mu-root");
		expect(readyAfter.map((i) => i.id)).toEqual(["mu-leaf2", "mu-leaf1"]);

		const collapsible = await store.collapsible("mu-root");
		expect(collapsible).toHaveLength(0); // root has open children

		// Close leaves terminally; root becomes collapsible and DAG validates final.
		await store.close("mu-leaf1", "success");
		await store.close("mu-leaf2", "skipped");

		const collapsible2 = await store.collapsible("mu-root");
		expect(collapsible2.map((i) => i.id)).toContain("mu-root");

		const v = await store.validate("mu-root");
		expect(v).toEqual({ is_final: true, reason: "all work completed" });
	});

});
