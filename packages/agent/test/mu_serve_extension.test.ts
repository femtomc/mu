import { describe, expect, test } from "bun:test";
import { muServeExtension } from "../src/extensions/mu-serve.js";

describe("muServeExtension", () => {
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

		muServeExtension(api as any);
		expect([...tools.keys()].sort()).toEqual(["command", "query"]);
	});
});
