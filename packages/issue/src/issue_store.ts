import type { Issue, JsonlStore } from "@femtomc/mu-core";
import { EventLog, IssueSchema, NullEventSink, nowTs, shortId } from "@femtomc/mu-core";
import {
	collapsible as dagCollapsible,
	readyLeaves,
	subtreeIds as dagSubtreeIds,
	type ValidationResult,
	validateDag,
} from "./dag.js";
import {
	IssueStoreNotFoundError,
	IssueStoreValidationError,
	normalizeIssueContainsFilter,
	normalizeIssueDepInput,
	normalizeIssueQueryLimit,
	normalizeIssueStatusFilter,
	normalizeIssueTagFilter,
} from "./contracts.js";

export type CreateIssueOpts = {
	body?: string;
	tags?: string[];
	priority?: number;
};

export type ListIssueOpts = {
	status?: Issue["status"] | null;
	tag?: string | null;
	contains?: string | null;
	limit?: number | null;
};

export type ReadyIssueOpts = {
	tags?: readonly string[] | null;
	contains?: string | null;
	limit?: number | null;
};

function deepEqualJson(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (typeof a !== typeof b) {
		return false;
	}
	if (a == null || b == null) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) {
			return false;
		}
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (!deepEqualJson(a[i], b[i])) {
				return false;
			}
		}
		return true;
	}
	if (typeof a === "object") {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const ak = Object.keys(ao).sort();
		const bk = Object.keys(bo).sort();
		if (ak.length !== bk.length) {
			return false;
		}
		for (let i = 0; i < ak.length; i++) {
			const key = ak[i]!;
			if (key !== bk[i]) {
				return false;
			}
			if (!deepEqualJson(ao[key], bo[key])) {
				return false;
			}
		}
		return true;
	}
	return false;
}

function issueContainsText(issue: Issue, contains: string): boolean {
	const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
	return haystack.includes(contains);
}

export class IssueStore {
	public readonly events: EventLog;
	readonly #issues: JsonlStore<unknown>;

	public constructor(issues: JsonlStore<unknown>, opts: { events?: EventLog } = {}) {
		this.#issues = issues;
		this.events = opts.events ?? new EventLog(new NullEventSink());
	}

	#parseIssueRow(row: unknown, idx: number): Issue {
		const parsed = IssueSchema.safeParse(row);
		if (!parsed.success) {
			throw new Error(`invalid issue row ${idx}: ${parsed.error.message}`);
		}
		return parsed.data;
	}

	async #load(): Promise<Issue[]> {
		const rows = await this.#issues.read();
		return rows.map((row, idx) => this.#parseIssueRow(row, idx));
	}

	async *#streamRows(): AsyncGenerator<Issue> {
		if (this.#issues.stream) {
			let idx = 0;
			for await (const row of this.#issues.stream()) {
				yield this.#parseIssueRow(row, idx);
				idx += 1;
			}
			return;
		}

		const rows = await this.#issues.read();
		for (let idx = 0; idx < rows.length; idx += 1) {
			yield this.#parseIssueRow(rows[idx], idx);
		}
	}

	async #save(rows: readonly Issue[]): Promise<void> {
		await this.#issues.write(rows);
	}

	#findIndex(rows: readonly Issue[], issueId: string): number {
		return rows.findIndex((row) => row.id === issueId);
	}

	public async create(title: string, opts: CreateIssueOpts = {}): Promise<Issue> {
		const now = nowTs();
		const issueInput: Record<string, unknown> = {
			id: `mu-${shortId()}`,
			title,
			body: opts.body ?? "",
			status: "open",
			outcome: null,
			tags: opts.tags ?? [],
			deps: [],
			priority: opts.priority ?? 3,
			created_at: now,
			updated_at: now,
		};
		const issue = IssueSchema.parse(issueInput);

		await this.#issues.append(issue);

		await this.events.emit("issue.create", {
			source: "issue_store",
			issueId: issue.id,
			payload: { issue },
		});
		return issue;
	}

	public async get(issueId: string): Promise<Issue | null> {
		const rows = await this.#load();
		const idx = this.#findIndex(rows, issueId);
		return idx >= 0 ? rows[idx] : null;
	}

	public async list(opts: ListIssueOpts = {}): Promise<Issue[]> {
		const status = normalizeIssueStatusFilter(opts.status);
		const tag = normalizeIssueTagFilter(opts.tag);
		const contains = normalizeIssueContainsFilter(opts.contains);
		const limit = normalizeIssueQueryLimit(opts.limit, { defaultLimit: null });

		if (limit != null && this.#issues.stream) {
			const bounded: Issue[] = [];
			for await (const row of this.#streamRows()) {
				if (status && row.status !== status) {
					continue;
				}
				if (tag && !row.tags.includes(tag)) {
					continue;
				}
				if (contains && !issueContainsText(row, contains)) {
					continue;
				}
				bounded.push(row);
				if (bounded.length > limit) {
					bounded.shift();
				}
			}
			return bounded;
		}

		let rows = await this.#load();
		if (status) {
			rows = rows.filter((row) => row.status === status);
		}
		if (tag) {
			rows = rows.filter((row) => row.tags.includes(tag));
		}
		if (contains) {
			rows = rows.filter((row) => issueContainsText(row, contains));
		}
		if (limit != null) {
			rows = rows.slice(-limit);
		}
		return rows;
	}

	public async update(issueId: string, fields: Record<string, unknown>): Promise<Issue> {
		if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
			throw new IssueStoreValidationError("update fields must be an object");
		}

		const rows = await this.#load();
		const idx = this.#findIndex(rows, issueId);
		if (idx < 0) {
			throw new IssueStoreNotFoundError(issueId);
		}

		const issueBefore = rows[idx]!;
		const before = JSON.parse(JSON.stringify(issueBefore)) as Issue;

		for (const [key, _value] of Object.entries(fields)) {
			if (key === "id") {
				continue;
			}
			(issueBefore as any)[key] = _value;
		}
		issueBefore.updated_at = nowTs();

		const issueAfter = IssueSchema.parse(issueBefore);
		rows[idx] = issueAfter;
		await this.#save(rows);

		const changed: Record<string, { from: unknown; to: unknown }> = {};
		for (const [key, _value] of Object.entries(fields)) {
			if (key === "id") {
				continue;
			}
			const from = (before as any)[key];
			const to = (issueAfter as any)[key];
			if (!deepEqualJson(from, to)) {
				changed[key] = { from, to };
			}
		}

		const fieldsWithoutId: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(fields)) {
			if (k === "id") {
				continue;
			}
			fieldsWithoutId[k] = v;
		}

		await this.events.emit("issue.update", {
			source: "issue_store",
			issueId,
			payload: { changed, fields: fieldsWithoutId },
		});

		if (before.status !== issueAfter.status) {
			const status = issueAfter.status;
			if (status === "open") {
				await this.events.emit("issue.open", {
					source: "issue_store",
					issueId,
					payload: { from: before.status, to: status },
				});
			} else if (status === "closed") {
				await this.events.emit("issue.close", {
					source: "issue_store",
					issueId,
					payload: { from: before.status, to: status, outcome: issueAfter.outcome },
				});
			} else if (status === "in_progress") {
				await this.events.emit("issue.claim", {
					source: "issue_store",
					issueId,
					payload: { from: before.status, to: status, ok: true },
				});
			}
		}

		return issueAfter;
	}

	public async claim(issueId: string): Promise<boolean> {
		const rows = await this.#load();
		const idx = this.#findIndex(rows, issueId);
		if (idx < 0) {
			await this.events.emit("issue.claim", {
				source: "issue_store",
				issueId,
				payload: { ok: false, reason: "not_found" },
			});
			return false;
		}

		const issue = rows[idx]!;
		if (issue.status !== "open") {
			await this.events.emit("issue.claim", {
				source: "issue_store",
				issueId,
				payload: { ok: false, reason: `status=${issue.status}` },
			});
			return false;
		}

		issue.status = "in_progress";
		issue.updated_at = nowTs();
		rows[idx] = IssueSchema.parse(issue);
		await this.#save(rows);

		await this.events.emit("issue.claim", { source: "issue_store", issueId, payload: { ok: true } });
		return true;
	}

	public async close(issueId: string, outcome: string = "success"): Promise<Issue> {
		return await this.update(issueId, { status: "closed", outcome });
	}

	public async reset_in_progress(rootId: string): Promise<string[]> {
		const rows = await this.#load();
		const idsInScope = new Set(this.#subtreeIds(rows, rootId));

		const reset: string[] = [];
		for (const row of rows) {
			if (idsInScope.has(row.id) && row.status === "in_progress") {
				row.status = "open";
				row.updated_at = nowTs();
				reset.push(row.id);
			}
		}

		if (reset.length > 0) {
			await this.#save(rows.map((row) => IssueSchema.parse(row)));
		}
		return reset;
	}

	public async add_dep(srcId: string, depType: string, dstId: string): Promise<void> {
		const normalizedSrcId = srcId.trim();
		if (normalizedSrcId.length === 0) {
			throw new IssueStoreValidationError("source issue id is required");
		}
		const normalizedDep = normalizeIssueDepInput({ depType, target: dstId });
		if (normalizedDep.target === normalizedSrcId) {
			throw new IssueStoreValidationError("dependency target cannot equal source issue id");
		}

		const rows = await this.#load();
		const idx = this.#findIndex(rows, normalizedSrcId);
		if (idx < 0) {
			throw new IssueStoreNotFoundError(normalizedSrcId);
		}
		if (this.#findIndex(rows, normalizedDep.target) < 0) {
			throw new IssueStoreNotFoundError(normalizedDep.target);
		}

		const issue = rows[idx]!;
		const exists = issue.deps.some(
			(dep) => dep.type === normalizedDep.depType && dep.target === normalizedDep.target,
		);
		if (exists) {
			return;
		}

		(issue.deps as any).push({ type: normalizedDep.depType, target: normalizedDep.target });
		issue.updated_at = nowTs();
		rows[idx] = IssueSchema.parse(issue);
		await this.#save(rows);

		await this.events.emit("issue.dep.add", {
			source: "issue_store",
			issueId: normalizedSrcId,
			payload: { type: normalizedDep.depType, target: normalizedDep.target },
		});
	}

	public async remove_dep(srcId: string, depType: string, dstId: string): Promise<boolean> {
		const normalizedSrcId = srcId.trim();
		if (normalizedSrcId.length === 0) {
			throw new IssueStoreValidationError("source issue id is required");
		}
		const normalizedDep = normalizeIssueDepInput({ depType, target: dstId });

		const rows = await this.#load();
		const idx = this.#findIndex(rows, normalizedSrcId);
		if (idx < 0) {
			throw new IssueStoreNotFoundError(normalizedSrcId);
		}

		const issue = rows[idx]!;
		const before = issue.deps.length;
		issue.deps = issue.deps.filter(
			(dep) => !(dep.type === normalizedDep.depType && dep.target === normalizedDep.target),
		);
		const changed = issue.deps.length !== before;

		if (changed) {
			issue.updated_at = nowTs();
			rows[idx] = IssueSchema.parse(issue);
			await this.#save(rows);
		}

		await this.events.emit("issue.dep.remove", {
			source: "issue_store",
			issueId: normalizedSrcId,
			payload: { type: normalizedDep.depType, target: normalizedDep.target, ok: changed },
		});

		return changed;
	}

	public async children(parentId: string): Promise<Issue[]> {
		const rows = await this.#load();
		return rows.filter((row) => row.deps.some((dep) => dep.type === "parent" && dep.target === parentId));
	}

	public async subtree_ids(rootId: string): Promise<string[]> {
		const rows = await this.#load();
		return this.#subtreeIds(rows, rootId);
	}

	#subtreeIds(issues: readonly Issue[], rootId: string): string[] {
		return dagSubtreeIds(issues, rootId);
	}

	public async ready(rootId: string | null = null, opts: ReadyIssueOpts = {}): Promise<Issue[]> {
		const rows = await this.#load();
		const tags = opts.tags ?? undefined;
		const contains = normalizeIssueContainsFilter(opts.contains);
		const limit = normalizeIssueQueryLimit(opts.limit, { defaultLimit: null });
		const root_id = rootId ?? undefined;
		let ready = readyLeaves(rows, { root_id, tags: tags ?? undefined });
		if (contains) {
			ready = ready.filter((issue) => issueContainsText(issue, contains));
		}
		if (limit != null) {
			ready = ready.slice(0, limit);
		}
		return ready;
	}

	public async collapsible(rootId: string): Promise<Issue[]> {
		const rows = await this.#load();
		return dagCollapsible(rows, rootId);
	}

	public async validate(rootId: string): Promise<ValidationResult> {
		const rows = await this.#load();
		return validateDag(rows, rootId);
	}
}
