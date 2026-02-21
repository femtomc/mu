import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { muServeExtension } from "../src/extensions/mu-serve.js";

describe("muServeExtension", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
	});

	afterEach(() => {
		resetMuCommandDispatcher();
	});

	test("registers planning/subagents tools and does not register legacy query/command tools", () => {
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

		muServeExtension(api as any);
		expect(tools.has("mu_planning_hud")).toBe(true);
		expect(tools.has("mu_subagents_hud")).toBe(true);
		expect(tools.has("query")).toBe(false);
		expect(tools.has("command")).toBe(false);
		expect(commands.has("mu")).toBe(true);
	});
});
