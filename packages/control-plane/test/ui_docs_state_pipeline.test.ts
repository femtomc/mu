import { UI_CONTRACT_VERSION, type UiDoc } from "@femtomc/mu-core";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneCommandPipeline } from "../src/command_pipeline.js";
import { ControlPlaneRuntime } from "../src/runtime.js";

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

describe("ControlPlaneCommandPipeline ui docs state integration", () => {
	test("autonomous operator responses update ui docs state scope by session id", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "mu-cp-ui-state-"));
		let currentDoc = mkUiDoc();
		const runtime = new ControlPlaneRuntime({ repoRoot, nowMs: () => 1_000 });
		const operator = {
			handleInbound: async () => ({
				kind: "response" as const,
				message: "ok",
				ui_docs: [currentDoc],
				operatorSessionId: "operator-session",
				operatorTurnId: "operator-turn",
			}),
		};
		const pipeline = new ControlPlaneCommandPipeline({
			runtime,
			operator,
			nowMs: () => 1_000,
		});

		await pipeline.start();
		try {
			const first = await pipeline.handleAutonomousIngress({
				text: "wake",
				repoRoot,
				requestId: "req-1",
				metadata: {
					source: "autonomous_ingress",
					operator_session_id: "heartbeat-program:hb-7",
					program_id: "hb-7",
				},
			});
			expect(first.kind).toBe("operator_response");
			const firstRecord = runtime.uiDocsState.get({ kind: "session", id: "heartbeat-program:hb-7" });
			expect(firstRecord?.rev).toBe(1);
			expect(firstRecord?.docs[0]?.ui_id).toBe("ui:planning");

			await pipeline.handleAutonomousIngress({
				text: "wake",
				repoRoot,
				requestId: "req-2",
				metadata: {
					source: "autonomous_ingress",
					operator_session_id: "heartbeat-program:hb-7",
					program_id: "hb-7",
				},
			});
			const unchanged = runtime.uiDocsState.get({ kind: "session", id: "heartbeat-program:hb-7" });
			expect(unchanged?.rev).toBe(1);

			currentDoc = mkUiDoc({
				revision: { id: "rev:2", version: 2 },
				updated_at_ms: 200,
			});
			await pipeline.handleAutonomousIngress({
				text: "wake",
				repoRoot,
				requestId: "req-3",
				metadata: {
					source: "autonomous_ingress",
					operator_session_id: "heartbeat-program:hb-7",
					program_id: "hb-7",
				},
			});
			const updated = runtime.uiDocsState.get({ kind: "session", id: "heartbeat-program:hb-7" });
			expect(updated?.rev).toBe(2);
			expect(updated?.docs[0]?.revision.version).toBe(2);
		} finally {
			await pipeline.stop();
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});
