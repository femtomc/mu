import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { planningUiExtension } from "../src/extensions/planning-ui.js";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
};

function createExtensionApiMock() {
	const tools = new Map<string, RegisteredTool>();
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(_name: string, _command: unknown) {
			return undefined;
		},
		on(_event: string, _handler: unknown) {
			return undefined;
		},
	};
	return { api, tools };
}

function detailsOf(result: unknown): Record<string, unknown> {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error("expected object tool result");
	}
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		throw new Error("expected object details");
	}
	return details as Record<string, unknown>;
}

function textOf(result: unknown): string {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return "";
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return "";
	}
	const first = content[0];
	if (!first || typeof first !== "object" || Array.isArray(first)) {
		return "";
	}
	const text = (first as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

async function executePlanningTool(tool: RegisteredTool, params: Record<string, unknown>): Promise<unknown> {
	return tool.execute("call-1", params, undefined, undefined, { hasUI: false });
}

describe("planning HUD tool", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
	});

	test("registers mu_planning_hud and supports stateful actions", async () => {
		const { api, tools } = createExtensionApiMock();
		planningUiExtension(api as unknown as Parameters<typeof planningUiExtension>[0]);

		const tool = tools.get("mu_planning_hud");
		expect(tool).toBeDefined();
		if (!tool) {
			throw new Error("mu_planning_hud tool missing");
		}

		await executePlanningTool(tool, { action: "on" });
		await executePlanningTool(tool, { action: "phase", phase: "drafting" });
		await executePlanningTool(tool, { action: "root", root_issue_id: "mu-root-123" });
		await executePlanningTool(tool, { action: "check", step: 2 });

		const result = await executePlanningTool(tool, { action: "status" });
		const details = detailsOf(result);
		expect(details.ok).toBe(true);
		expect(details.enabled).toBe(true);
		expect(details.phase).toBe("drafting");
		expect(details.root_issue_id).toBe("mu-root-123");

		const steps = details.steps;
		expect(Array.isArray(steps)).toBe(true);
		const second = (steps as Array<Record<string, unknown>>)[1];
		expect(second?.done).toBe(true);
	});

	test("supports communication metadata and atomic update", async () => {
		const { api, tools } = createExtensionApiMock();
		planningUiExtension(api as unknown as Parameters<typeof planningUiExtension>[0]);

		const tool = tools.get("mu_planning_hud");
		if (!tool) {
			throw new Error("mu_planning_hud tool missing");
		}

		const updateResult = await executePlanningTool(tool, {
			action: "update",
			phase: "waiting_user",
			root_issue_id: "workshop-root-1",
			waiting_on_user: true,
			next_action: "Confirm tradeoff A vs B",
			blocker: "Need approval to proceed",
			confidence: "low",
			steps: ["Investigate", "Draft", "Review"],
			step_updates: [
				{ index: 1, done: true },
				{ index: 2, label: "Draft issue DAG" },
			],
		});
		const updateDetails = detailsOf(updateResult);
		expect(updateDetails.ok).toBe(true);

		const statusResult = await executePlanningTool(tool, { action: "status" });
		const statusDetails = detailsOf(statusResult);
		expect(statusDetails.phase).toBe("waiting_user");
		expect(statusDetails.waiting_on_user).toBe(true);
		expect(statusDetails.next_action).toBe("Confirm tradeoff A vs B");
		expect(statusDetails.blocker).toBe("Need approval to proceed");
		expect(statusDetails.confidence).toBe("low");
		expect(statusDetails.root_issue_id).toBe("workshop-root-1");

		const steps = statusDetails.steps as Array<Record<string, unknown>>;
		expect(steps).toHaveLength(3);
		expect(steps[0]?.done).toBe(true);
		expect(steps[1]?.label).toBe("Draft issue DAG");

		const snapshotResult = await executePlanningTool(tool, { action: "snapshot", snapshot_format: "compact" });
		expect(textOf(snapshotResult)).toContain("HUD(plan)");
		expect(textOf(snapshotResult)).toContain("waiting=yes");
	});

	test("returns structured error for invalid phase", async () => {
		const { api, tools } = createExtensionApiMock();
		planningUiExtension(api as unknown as Parameters<typeof planningUiExtension>[0]);

		const tool = tools.get("mu_planning_hud");
		if (!tool) {
			throw new Error("mu_planning_hud tool missing");
		}

		const result = await executePlanningTool(tool, { action: "phase", phase: "invalid-phase" });
		const details = detailsOf(result);
		expect(details.ok).toBe(false);
		expect(details.error).toBe("Invalid phase.");
		expect(textOf(result)).toContain("Invalid phase.");
	});
});
