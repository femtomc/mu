import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { muOperatorExtension } from "../src/extensions/mu-operator.js";

describe("muOperatorExtension", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
	});

	test("registers HUD tool and does not expose legacy planning/subagents tools", () => {
		const tools = new Map<string, unknown>();
		const commands = new Map<string, unknown>();
		const api = {
			registerTool(tool: { name: string }) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: unknown) {
				commands.set(name, command);
			},
			on() {
				return undefined;
			},
		};

		muOperatorExtension(api as any);
		expect(tools.has("mu_hud")).toBe(true);
		expect(tools.has("mu_planning_hud")).toBe(false);
		expect(tools.has("mu_subagents_hud")).toBe(false);
		expect(tools.has("query")).toBe(false);
		expect(tools.has("command")).toBe(false);
		expect(commands.has("mu")).toBe(true);
	});
});
