import { beforeEach, describe, expect, test } from "bun:test";
import { resetMuCommandDispatcher } from "../src/extensions/mu-command-dispatcher.js";
import { muServeExtension } from "../src/extensions/mu-serve.js";

describe("muServeExtension", () => {
	beforeEach(() => {
		resetMuCommandDispatcher();
	});

	test("registers mu_ui tool and mu command", () => {
		const tools = new Map<string, unknown>();
		const commands = new Map<string, unknown>();
		const api = {
			registerTool(tool: { name: string }) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: unknown) {
				commands.set(name, command);
			},
			registerShortcut() {
				return undefined;
			},
			on() {
				return undefined;
			},
		};

		muServeExtension(api as any);
		expect(tools.has("mu_ui")).toBe(true);
		expect(tools.has("query")).toBe(false);
		expect(tools.has("command")).toBe(false);
		expect(commands.has("mu")).toBe(true);
	});
});
