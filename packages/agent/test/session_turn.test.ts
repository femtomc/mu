import { expect, test } from "bun:test";
import { getStorePaths } from "@femtomc/mu-core/node";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	executeSessionTurn,
	SessionTurnError,
	type CreateMuSessionOpts,
	type MuSession,
	type SessionTurnRequest,
} from "@femtomc/mu-agent";

type SessionKind = "operator" | "cp_operator";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-session-turn-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

async function writeSessionFile(opts: {
	repoRoot: string;
	sessionKind: SessionKind;
	sessionId: string;
	timestamp: string;
}): Promise<{ sessionDir: string; sessionFile: string }> {
	const storeDir = getStorePaths(opts.repoRoot).storeDir;
	const sessionDir =
		opts.sessionKind === "cp_operator"
			? join(storeDir, "control-plane", "operator-sessions")
			: join(storeDir, "operator", "sessions");
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `${opts.timestamp.replace(/[:.]/g, "-")}_${opts.sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: opts.sessionId,
		timestamp: opts.timestamp,
		cwd: opts.repoRoot,
	};
	await writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
	return { sessionDir, sessionFile };
}

function makeTurnRequest(overrides: Partial<SessionTurnRequest> = {}): SessionTurnRequest {
	return {
		session_id: "session-1",
		session_kind: null,
		body: "hello",
		source: null,
		provider: null,
		model: null,
		thinking: null,
		session_file: null,
		session_dir: null,
		extension_profile: null,
		...overrides,
	};
}

function makeMockSession(opts: { sessionId: string; sessionFile: string; reply: string }): MuSession {
	let listener: ((event: unknown) => void) | null = null;
	return {
		subscribe(next: (event: unknown) => void): () => void {
			listener = next;
			return () => {
				if (listener === next) {
					listener = null;
				}
			};
		},
		prompt: async () => {
			listener?.({
				type: "message_end",
				message: {
					role: "assistant",
					text: opts.reply,
				},
			});
		},
		dispose: () => {},
		bindExtensions: async () => {},
		agent: { waitForIdle: async () => {} },
		sessionId: opts.sessionId,
		sessionFile: opts.sessionFile,
		sessionManager: {
			getLeafId: () => "leaf-1",
		},
	};
}

test("executeSessionTurn auto-resolves cp_operator session ids when session_kind is omitted", async () => {
	const repoRoot = await mkTempRepo();
	try {
		const persisted = await writeSessionFile({
			repoRoot,
			sessionKind: "cp_operator",
			sessionId: "session-cp-1",
			timestamp: "2026-02-23T12:00:00.000Z",
		});
		const seenCreateOpts: CreateMuSessionOpts[] = [];

		const result = await executeSessionTurn({
			repoRoot,
			request: makeTurnRequest({
				session_id: "session-cp-1",
			}),
			sessionFactory: async (createOpts) => {
				seenCreateOpts.push(createOpts);
				return makeMockSession({
					sessionId: "session-cp-1",
					sessionFile: persisted.sessionFile,
					reply: "cp reply",
				});
			},
		});

		expect(result.session_kind).toBe("cp_operator");
		expect(result.session_file).toBe(persisted.sessionFile);
		expect(result.reply).toBe("cp reply");
		expect(seenCreateOpts).toHaveLength(1);
		expect(seenCreateOpts[0]?.session?.sessionDir).toBe(persisted.sessionDir);
		expect(seenCreateOpts[0]?.session?.sessionFile).toBe(persisted.sessionFile);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test("executeSessionTurn errors when session id is ambiguous across operator/cp_operator stores", async () => {
	const repoRoot = await mkTempRepo();
	try {
		await writeSessionFile({
			repoRoot,
			sessionKind: "operator",
			sessionId: "session-shared-1",
			timestamp: "2026-02-23T12:10:00.000Z",
		});
		await writeSessionFile({
			repoRoot,
			sessionKind: "cp_operator",
			sessionId: "session-shared-1",
			timestamp: "2026-02-23T12:11:00.000Z",
		});

		let thrown: unknown;
		try {
			await executeSessionTurn({
				repoRoot,
				request: makeTurnRequest({ session_id: "session-shared-1" }),
				sessionFactory: async () => {
					throw new Error("sessionFactory should not be called when target resolution fails");
				},
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SessionTurnError);
		expect((thrown as SessionTurnError).status).toBe(409);
		expect(String((thrown as SessionTurnError).message)).toContain("ambiguous");
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test("executeSessionTurn uses explicit session_kind to disambiguate duplicate session ids", async () => {
	const repoRoot = await mkTempRepo();
	try {
		const operatorSession = await writeSessionFile({
			repoRoot,
			sessionKind: "operator",
			sessionId: "session-shared-2",
			timestamp: "2026-02-23T12:20:00.000Z",
		});
		await writeSessionFile({
			repoRoot,
			sessionKind: "cp_operator",
			sessionId: "session-shared-2",
			timestamp: "2026-02-23T12:21:00.000Z",
		});

		const seenCreateOpts: CreateMuSessionOpts[] = [];
		const result = await executeSessionTurn({
			repoRoot,
			request: makeTurnRequest({
				session_id: "session-shared-2",
				session_kind: "operator",
			}),
			sessionFactory: async (createOpts) => {
				seenCreateOpts.push(createOpts);
				return makeMockSession({
					sessionId: "session-shared-2",
					sessionFile: operatorSession.sessionFile,
					reply: "operator reply",
				});
			},
		});

		expect(result.session_kind).toBe("operator");
		expect(result.reply).toBe("operator reply");
		expect(seenCreateOpts[0]?.session?.sessionDir).toBe(operatorSession.sessionDir);
		expect(seenCreateOpts[0]?.session?.sessionFile).toBe(operatorSession.sessionFile);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});
