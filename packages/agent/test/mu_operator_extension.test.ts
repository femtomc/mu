import { describe, expect, test } from "bun:test";
import { muOperatorExtension } from "../src/extensions/mu-operator.js";

describe("muOperatorExtension", () => {
	test("registers only query + command tools", () => {
		const tools = new Map<string, unknown>();
		const api = {
			registerTool(tool: { name: string }) {
				tools.set(tool.name, tool);
			},
			on() {
				return undefined;
			},
			registerCommand() {
				return undefined;
			},
		};

		muOperatorExtension(api as any);
		expect([...tools.keys()].sort()).toEqual(["command", "query"]);
	});
});
