import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@femtomc/mu";
import type { BackendRunner, BackendRunOpts } from "@femtomc/mu-orchestrator";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-cli-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

test("mu --help", async () => {
	const dir = await mkTempRepo();
	const result = await run(["--help"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.includes("Usage:")).toBe(true);
	expect(result.stdout.includes("mu <command>")).toBe(true);
});

test("mu issues create outputs JSON and writes to store", async () => {
	const dir = await mkTempRepo();

	const init = await run(["init"], { cwd: dir });
	expect(init.exitCode).toBe(0);

	const created = await run(["issues", "create", "Hello"], { cwd: dir });
	expect(created.exitCode).toBe(0);

	const issue = JSON.parse(created.stdout) as any;
	expect(typeof issue.id).toBe("string");
	expect(issue.id.startsWith("mu-")).toBe(true);
	expect(issue.title).toBe("Hello");
	expect(issue.tags.includes("node:agent")).toBe(true);

	const text = await readFile(join(dir, ".mu", "issues.jsonl"), "utf8");
	const rows = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as any);
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(issue.id);

	const posted = await run(["forum", "post", `issue:${issue.id}`, "-m", "hello", "--author", "worker"], { cwd: dir });
	expect(posted.exitCode).toBe(0);

	const msg = JSON.parse(posted.stdout) as any;
	expect(msg).toMatchObject({ topic: `issue:${issue.id}`, body: "hello", author: "worker" });

	const forumText = await readFile(join(dir, ".mu", "forum.jsonl"), "utf8");
	expect(forumText.includes(`"topic":"issue:${issue.id}"`)).toBe(true);
});

function mkCaptureIo(): {
	io: { stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } };
	chunks: { stdout: string; stderr: string };
} {
	const chunks = { stdout: "", stderr: "" };
	return {
		chunks,
		io: {
			stdout: {
				write: (s: string) => {
					chunks.stdout += s;
				},
			},
			stderr: {
				write: (s: string) => {
					chunks.stderr += s;
				},
			},
		},
	};
}

test("mu run streams step headers + rendered assistant output (default human mode)", async () => {
	const dir = await mkTempRepo();
	const init = await run(["init"], { cwd: dir });
	expect(init.exitCode).toBe(0);

	const backend: BackendRunner = {
		run: async (opts: BackendRunOpts) => {
			// Emit pi-style JSON events; CLI should render assistant text deltas.
			opts.onLine?.(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}`);
			opts.onLine?.(`{"type":"message_end","message":{"role":"assistant"}}`);
			return 0;
		},
	};

	const { io, chunks } = mkCaptureIo();
	const result = await run(["run", "Hello", "--max-steps", "1"], { cwd: dir, io, backend });

	// The runner doesn't close the issue (stub backend), so the DagRunner marks failure.
	expect(result.exitCode).toBe(1);

	expect(chunks.stdout).toBe("Hello\n");
	expect(chunks.stderr.includes("Step 1/1")).toBe(true);
	expect(chunks.stderr.includes("role=")).toBe(true);
	expect(chunks.stderr.includes("Done 1/1")).toBe(true);
	expect(chunks.stderr.includes("outcome=failure")).toBe(true);
	expect(chunks.stderr.includes("Recovery:")).toBe(true);
	expect(chunks.stderr.includes("mu replay")).toBe(true);
});

test("mu run pretty TTY mode renders markdown + tool events", async () => {
	const dir = await mkTempRepo();
	const init = await run(["init"], { cwd: dir });
	expect(init.exitCode).toBe(0);

	const backend: BackendRunner = {
		run: async (opts: BackendRunOpts) => {
			opts.onLine?.(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"echo hi"}}`);
			opts.onLine?.(
				`{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":[],"isError":false}`,
			);
			opts.onLine?.(
				'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"# Hello\\n\\n- a\\n- b\\n\\n`code`\\n"}}',
			);
			opts.onLine?.(`{"type":"message_end","message":{"role":"assistant"}}`);
			return 0;
		},
	};

	const { io, chunks } = mkCaptureIo();
	// Mark these as TTY so the CLI switches into pretty rendering mode.
	(io.stdout as any).isTTY = true;
	(io.stderr as any).isTTY = true;

	const result = await run(["run", "Hello", "--max-steps", "1"], { cwd: dir, io, backend });
	expect(result.exitCode).toBe(1);

	// Tool events go to stderr and should be concise.
	expect(chunks.stderr.includes("bash")).toBe(true);
	expect(chunks.stderr.includes("echo hi")).toBe(true);

	// Assistant markdown should be rendered (no raw '# ' heading marker) and styled with ANSI.
	expect(chunks.stdout.includes("\u001b[")).toBe(process.env.NO_COLOR == null);
	const plain = chunks.stdout.replaceAll(/\u001b\[[0-9;]*m/g, "");
	expect(plain.includes("# Hello")).toBe(false);
	expect(plain.includes("Hello")).toBe(true);
	expect(plain.includes("- a")).toBe(true);
	expect(plain.includes("code")).toBe(true);
});

test("mu run --raw-stream prints raw pi JSONL to stdout", async () => {
	const dir = await mkTempRepo();
	const init = await run(["init"], { cwd: dir });
	expect(init.exitCode).toBe(0);

	const backend: BackendRunner = {
		run: async (opts: BackendRunOpts) => {
			opts.onLine?.(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}`);
			opts.onLine?.(`{"type":"message_end","message":{"role":"assistant"}}`);
			return 0;
		},
	};

	const { io, chunks } = mkCaptureIo();
	const result = await run(["run", "Hello", "--max-steps", "1", "--raw-stream"], { cwd: dir, io, backend });
	expect(result.exitCode).toBe(1);

	expect(chunks.stdout.includes(`"type":"message_update"`)).toBe(true);
	expect(chunks.stdout.includes(`"type":"message_end"`)).toBe(true);
	// Raw stream should not be the rendered assistant text.
	expect(chunks.stdout).not.toBe("Hello\n");
});

test("mu run --json stays clean even when io is provided", async () => {
	const dir = await mkTempRepo();
	const init = await run(["init"], { cwd: dir });
	expect(init.exitCode).toBe(0);

	const backend: BackendRunner = { run: async () => 0 };
	const { io, chunks } = mkCaptureIo();
	const result = await run(["run", "Hello", "--max-steps", "1", "--json"], { cwd: dir, io, backend });

	expect(chunks.stdout).toBe("");
	expect(chunks.stderr).toBe("");

	const payload = JSON.parse(result.stdout) as any;
	expect(payload).toMatchObject({
		root_id: expect.any(String),
		status: expect.any(String),
		steps: expect.any(Number),
	});
});
