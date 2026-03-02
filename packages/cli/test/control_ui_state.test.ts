import { expect, test } from "bun:test";
import { UI_CONTRACT_VERSION, type UiDoc } from "@femtomc/mu-core";
import { getControlPlanePaths, UiDocsStateStore } from "@femtomc/mu-control-plane";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@femtomc/mu";

async function mkTempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mu-cli-ui-state-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

function mkUiDoc(overrides: Partial<UiDoc> = {}): UiDoc {
	return {
		v: UI_CONTRACT_VERSION,
		ui_id: "ui:planning",
		title: "Planning",
		components: [
			{
				kind: "text",
				id: "planning-text",
				text: "planning",
				metadata: {},
			},
		],
		actions: [],
		revision: { id: "rev:1", version: 1 },
		updated_at_ms: 100,
		metadata: {},
		...overrides,
	};
}

test("mu control ui-state help exposes list/get usage", async () => {
	const dir = await mkTempRepo();
	try {
		const result = await run(["control", "ui-state", "--help"], { cwd: dir });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("mu control ui-state - inspect persisted UiDoc scope/revision state");
		expect(result.stdout).toContain("mu control ui-state [list]");
		expect(result.stdout).toContain("mu control ui-state get <session|conversation> <scope-id>");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("mu control ui-state list/get inspects persisted scope snapshots", async () => {
	const dir = await mkTempRepo();
	try {
		const paths = getControlPlanePaths(dir);
		const store = new UiDocsStateStore(join(paths.controlPlaneDir, "ui_docs_state.jsonl"));

		await store.upsert({
			scope: { kind: "session", id: "heartbeat-program:hb-123" },
			docs: [mkUiDoc({ ui_id: "ui:planning" })],
			writer: {
				source: "autonomous_ingress",
				session_id: "heartbeat-program:hb-123",
				request_id: "req-1",
				wake_id: "wake-1",
				program_id: "hb-123",
			},
			nowMs: 1_000,
		});
		await store.upsert({
			scope: { kind: "conversation", id: "slack:team-1:chan-1:binding-1" },
			docs: [mkUiDoc({ ui_id: "ui:subagents" })],
			writer: {
				source: "adapter_ingress",
				channel: "slack",
				actor_binding_id: "binding-1",
				request_id: "req-2",
			},
			nowMs: 2_000,
		});

		const listResult = await run(["control", "ui-state", "list", "--kind", "session"], { cwd: dir });
		expect(listResult.exitCode).toBe(0);
		expect(listResult.stdout).toContain("UI docs state (1)");
		expect(listResult.stdout).toContain("session:heartbeat-program:hb-123");
		expect(listResult.stdout).toContain("writer=autonomous_ingress");

		const getResult = await run(["control", "ui-state", "get", "session", "heartbeat-program:hb-123"], {
			cwd: dir,
		});
		expect(getResult.exitCode).toBe(0);
		expect(getResult.stdout).toContain("UI docs state scope: session:heartbeat-program:hb-123");
		expect(getResult.stdout).toContain("Revision: 1");
		expect(getResult.stdout).toContain("Docs: 1");

		const getJson = await run(
			[
				"control",
				"ui-state",
				"get",
				"--kind",
				"conversation",
				"--id",
				"slack:team-1:chan-1:binding-1",
				"--json",
				"--pretty",
			],
			{ cwd: dir },
		);
		expect(getJson.exitCode).toBe(0);
		const payload = JSON.parse(getJson.stdout) as {
			record?: { scope?: { kind?: string; id?: string }; docs?: Array<{ ui_id?: string }> };
		};
		expect(payload.record?.scope?.kind).toBe("conversation");
		expect(payload.record?.scope?.id).toBe("slack:team-1:chan-1:binding-1");
		expect(payload.record?.docs?.[0]?.ui_id).toBe("ui:subagents");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
